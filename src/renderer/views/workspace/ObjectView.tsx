import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, Columns3, ListTree, Network, Play, RefreshCw, Rows3, Save, Zap } from 'lucide-react'
import type { DbObjectRef, TableStructure } from '@shared/model'
import { hasOperations } from '@domain/objectCapabilities'
import { useWorkspace, type ObjectSubView, type SessionState, type Tab } from '../../stores/workspaceStore'
import { Button, Empty, IconButton, SegmentedTabs, Spinner } from '../../components/ui'
import { SqlEditor, type SqlEditorHandle } from '../../components/editor/SqlEditor'
import { StructureEditor } from '../object/StructureEditor'
import { DataView } from '../object/DataView'
import { DependenciesView, OperationsView } from '../object/ObjectInsights'
import { TriggerEditor } from '../object/TriggerEditor'
import { notify } from '../../stores/toast'
import { errorMessage } from '../../gateways/api'

type View = ObjectSubView

const emptyTable = (ref: DbObjectRef): TableStructure => ({ ref, columns: [], indexes: [], foreignKeys: [], checks: [], options: {} })

export default function ObjectView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation()
  const session = useWorkspace((s) => s.sessions[tab.sessionId])
  const ref = tab.ref!
  const tableLike = ref.kind === 'table' || ref.kind === 'view' || ref.kind === 'materialized_view'
  const defaultView: View = tab.view ?? (ref.kind === 'table' ? 'structure' : tableLike ? 'data' : ref.kind === 'trigger' ? 'trigger' : 'ddl')
  const [view, setView] = useState<View>(defaultView)
  const [structure, setStructure] = useState<TableStructure | null>(tab.isNew ? emptyTable(ref) : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (tab.view) setView(tab.view)
  }, [tab.view])

  const loadStructure = useCallback(async () => {
    if (!session || tab.isNew || ref.kind !== 'table') return
    try {
      setStructure(await session.client.call('getTableStructure', { ref }))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [session, ref, tab.isNew])

  useEffect(() => {
    if (active && !structure && ref.kind === 'table') void loadStructure()
  }, [active, structure, loadStructure, ref.kind])

  if (!session) return null

  const views = [
    ...(ref.kind === 'table' ? [{ value: 'structure' as const, label: t('tabs.structure'), icon: <Columns3 size={14} /> }] : []),
    ...(tableLike && !tab.isNew ? [{ value: 'data' as const, label: t('tabs.data'), icon: <Rows3 size={14} /> }] : []),
    ...(ref.kind === 'trigger' ? [{ value: 'trigger' as const, label: t('tabs.trigger'), icon: <Zap size={14} /> }] : []),
    ...(!tab.isNew ? [{ value: 'ddl' as const, label: tableLike ? t('tabs.ddl') : t('tabs.source'), icon: <Code2 size={14} /> }] : []),
    ...(!tab.isNew ? [{ value: 'dependencies' as const, label: t('tabs.dependencies'), icon: <Network size={14} /> }] : []),
    ...(!tab.isNew && hasOperations(session.info.engine, ref.kind) ? [{ value: 'operations' as const, label: t('tabs.operations'), icon: <ListTree size={14} /> }] : [])
  ]

  return (
    <div className="flex h-full flex-col">
      <SegmentedTabs value={view} onChange={setView} items={views} />
      <div className="relative min-h-0 flex-1">
        {view === 'structure' &&
          (error ? (
            <Empty title={error} />
          ) : structure ? (
            <StructureEditor
              session={session}
              structure={structure}
              isNew={!!tab.isNew}
              onSaved={(name) => {
                const ws = useWorkspace.getState()
                const newRef = { ...ref, name }
                ws.updateTab(tab.id, { isNew: false, ref: newRef, title: name, preview: false })
                setStructure(null)
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ))}
        {tableLike && !tab.isNew && (
          <div className={view === 'data' ? 'h-full' : 'hidden'}>
            <DataView session={session} refObj={ref} tabId={tab.id} active={active && view === 'data'} structure={structure} />
          </div>
        )}
        {view === 'trigger' && (
          <TriggerEditor
            session={session}
            refObj={tab.isNew ? undefined : ref}
            isNew={!!tab.isNew}
            context={{ database: tab.database ?? ref.database, schema: tab.schema ?? ref.schema, table: ref.table }}
            onSaved={(saved) => useWorkspace.getState().updateTab(tab.id, { isNew: false, ref: saved, title: saved.name, preview: false })}
          />
        )}
        {view === 'ddl' && <SourceView session={session} refObj={ref} editable={ref.kind !== 'table' && ref.kind !== 'materialized_view'} />}
        {view === 'dependencies' && <DependenciesView session={session} refObj={ref} />}
        {view === 'operations' && <OperationsView session={session} refObj={ref} />}
      </div>
    </div>
  )
}

/** Turns SHOW CREATE output into a script that replaces the object when re-run. */
function replaceScript(session: SessionState, ref: DbObjectRef, ddl: string): string {
  const engine = session.info.engine
  if (engine === 'mysql' || engine === 'mariadb') {
    const kw: Record<string, string> = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT', package: 'PACKAGE' }
    const target = `${ref.database ? `\`${ref.database}\`.` : ''}\`${ref.name}\``
    if (kw[ref.kind]) return `DROP ${kw[ref.kind]} IF EXISTS ${target};\nDELIMITER $$\n${ddl.trim().replace(/;\s*$/, '')}$$\nDELIMITER ;`
    if (ref.kind === 'view') return ddl.replace(/^CREATE\s/i, 'CREATE OR REPLACE ')
  }
  // SQLite has no CREATE OR REPLACE: the saved source drops the old view or trigger first.
  if (engine === 'sqlite' && (ref.kind === 'view' || ref.kind === 'trigger')) {
    return `DROP ${ref.kind.toUpperCase()} IF EXISTS "${ref.name.replace(/"/g, '""')}";\n${ddl}`
  }
  if (engine === 'postgres' && ref.kind === 'trigger') {
    return `DROP TRIGGER IF EXISTS "${ref.name}" ON ${ref.schema ? `"${ref.schema}".` : ''}"${ref.table}";\n${ddl}`
  }
  return ddl
}

function SourceView({ session, refObj, editable }: { session: SessionState; refObj: DbObjectRef; editable: boolean }) {
  const { t } = useTranslation()
  const [ddl, setDdl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const editor = useRef<SqlEditorHandle>(null)

  const load = useCallback(async () => {
    try {
      setDdl(await session.client.call('getObjectDDL', { ref: refObj }))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [session, refObj])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    const sql = editor.current?.getValue() ?? ''
    setSaving(true)
    try {
      const summary = await session.client.call('execute', { queryId: crypto.randomUUID(), sql: replaceScript(session, refObj, sql), database: refObj.database, maxRows: 100 })
      const failed = summary.statements.find((s) => s.error)
      if (failed) throw new Error(failed.error!.message)
      notify.success(t('routine.saved'))
      void useWorkspace.getState().loadObjects(session.id, refObj.database, refObj.schema, true)
      void load()
    } catch (err) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  if (error) return <Empty title={error} />
  if (ddl === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        {editable && (
          <Button size="sm" variant="primary" icon={<Save size={13} />} loading={saving} onClick={() => void save()}>
            {t('routine.save')}
          </Button>
        )}
        <IconButton label={t('tree.newQuery')} onClick={() => useWorkspace.getState().newQueryTab(session.id, editor.current?.getValue() ?? ddl, refObj.database)}>
          <Play size={14} />
        </IconButton>
        <IconButton label={t('common.refresh')} onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        <SqlEditor ref={editor} value={ddl} engine={session.info.engine} readOnly={!editable} onSave={() => editable && void save()} />
      </div>
    </div>
  )
}
