import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { BulkTableOperations, DbObjectInfo, DbObjectRef } from '@shared/model'
import { useWorkspace, objectsKey } from '../../stores/workspaceStore'
import { useUi, type DialogState } from '../../stores/uiStore'
import { Button, Checkbox, Dialog, Field, Input, Select, Spinner } from '../../components/ui'
import { notify } from '../../stores/toast'
import { copyTable } from '@application/copy/copyTable'

const ROW_FORMATS = ['DYNAMIC', 'COMPACT', 'COMPRESSED', 'REDUNDANT', 'FIXED']

type BulkResult = { table: string; statements: string[]; error?: string }

export function BulkEditDialog({ d }: { d: Extract<DialogState, { kind: 'bulkEdit' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const entry = useWorkspace((s) => s.objects[objectsKey(d.sessionId, d.database, d.schema)])
  const schemas = useWorkspace((s) => s.schemas[objectsKey(d.sessionId, d.database)])
  const engine = session?.info.engine
  const isMy = engine === 'mysql' || engine === 'mariadb'
  const tables = useMemo(() => (entry?.status === 'ok' ? entry.items.filter((o) => o.kind === 'table') : []), [entry])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ops, setOps] = useState<BulkTableOperations>({})
  const [engines, setEngines] = useState<string[]>([])
  const [collations, setCollations] = useState<{ charset: string; collation: string }[]>([])
  const [results, setResults] = useState<BulkResult[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!session) return
    void useWorkspace.getState().loadObjects(session.id, d.database, d.schema)
    if (isMy) {
      void session.client.call('listEngines', undefined).then(setEngines).catch(() => undefined)
      void session.client.call('listCollations', undefined).then(setCollations).catch(() => undefined)
    }
  }, [session, d.database, d.schema, isMy])

  if (!session) return null
  const refs: DbObjectRef[] = tables.filter((x) => selected.has(x.name)).map((x) => ({ database: x.database, schema: x.schema, name: x.name, kind: 'table' }))
  const set = (patch: Partial<BulkTableOperations>): void => {
    setResults(null)
    setOps((o) => ({ ...o, ...patch }))
  }

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await session.client.call('bulkAlterTables', { tables: refs, ops, dryRun })
      setResults(r.results)
      if (!dryRun) {
        const failed = r.results.filter((x) => x.error).length
        notify.success(t('bulk.done', { ok: r.results.length - failed, failed }))
        void useWorkspace.getState().loadObjects(session.id, d.database, d.schema, true)
        if (ops.moveTo) void useWorkspace.getState().loadObjects(session.id, isMy ? ops.moveTo : d.database, isMy ? undefined : ops.moveTo, true)
      }
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={`${t('bulk.title')} — ${d.schema ? `${d.database}.${d.schema}` : (d.database ?? '')}`}
      width={900}
      height={600}
      footer={
        <>
          <Button onClick={close} disabled={busy}>{t('common.close')}</Button>
          <Button onClick={() => void run(true)} disabled={busy || !refs.length || engine === 'firebird'}>{t('bulk.preview')}</Button>
          <Button variant="primary" loading={busy} disabled={!refs.length || engine === 'firebird'} onClick={() => void run(false)}>
            {t('bulk.run', { count: refs.length })}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <div className="flex w-64 shrink-0 flex-col border-r border-border">
          <div className="border-b border-border px-3 py-2">
            <Checkbox
              checked={tables.length > 0 && selected.size === tables.length}
              onChange={(v) => setSelected(v ? new Set(tables.map((x) => x.name)) : new Set())}
              label={`${t('bulk.selectAll')} (${tables.length})`}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-1">
            {entry?.status === 'loading' && <Spinner />}
            {tables.map((x: DbObjectInfo) => (
              <Checkbox
                key={x.name}
                block className="py-0.5"
                checked={selected.has(x.name)}
                onChange={(v) =>
                  setSelected((s) => {
                    const n = new Set(s)
                    if (v) n.add(x.name)
                    else n.delete(x.name)
                    return n
                  })
                }
                label={x.name}
              />
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {engine === 'firebird' ? (
            <div className="text-sm text-muted">{t('bulk.unsupported')}</div>
          ) : isMy ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('bulk.moveTo')}>
                <Select value={ops.moveTo ?? ''} onChange={(e) => set({ moveTo: e.target.value || undefined })}>
                  <option value="">{t('bulk.keep')}</option>
                  {(session.databases ?? []).filter((x) => x !== d.database).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('bulk.engine')}>
                <Select value={ops.engine ?? ''} onChange={(e) => set({ engine: e.target.value || undefined })}>
                  <option value="">{t('bulk.keep')}</option>
                  {engines.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('bulk.collation')}>
                <Select
                  value={ops.collation ?? ''}
                  onChange={(e) => set({ collation: e.target.value || undefined, charset: collations.find((c) => c.collation === e.target.value)?.charset })}
                >
                  <option value="">{t('bulk.keep')}</option>
                  {collations.map((c) => (
                    <option key={c.collation}>{c.collation}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('bulk.rowFormat')}>
                <Select value={ops.rowFormat ?? ''} onChange={(e) => set({ rowFormat: e.target.value || undefined })}>
                  <option value="">{t('bulk.keep')}</option>
                  {ROW_FORMATS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </Field>
              <Checkbox checked={!!ops.convertData} disabled={!ops.collation} onChange={(v) => set({ convertData: v })} label={t('bulk.convertData')} />
              <Checkbox checked={!!ops.resetAutoIncrement} onChange={(v) => set({ resetAutoIncrement: v })} label={t('bulk.resetAutoIncrement')} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('bulk.moveToSchema')}>
                <Select value={ops.moveTo ?? ''} onChange={(e) => set({ moveTo: e.target.value || undefined })}>
                  <option value="">{t('bulk.keep')}</option>
                  {(schemas ?? []).filter((x) => x !== d.schema && !x.startsWith('pg_') && x !== 'information_schema').map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('bulk.tablespace')}>
                <Input value={ops.tablespace ?? ''} onChange={(e) => set({ tablespace: e.target.value || undefined })} />
              </Field>
              <Field label={t('bulk.owner')}>
                <Input value={ops.owner ?? ''} onChange={(e) => set({ owner: e.target.value || undefined })} />
              </Field>
            </div>
          )}
          {results && (
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-sunken p-2 font-mono text-[11px]">
              {results.map((r) => (
                <div key={r.table} className="mb-1.5">
                  <div className="flex items-center gap-1.5 font-semibold">
                    {r.error ? <XCircle size={12} className="text-danger" /> : <CheckCircle2 size={12} className="text-success" />}
                    {r.table}
                  </div>
                  {r.statements.map((s, i) => (
                    <div key={i} className="whitespace-pre-wrap pl-4 text-muted">{s};</div>
                  ))}
                  {r.error && <div className="pl-4 text-danger">{r.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export function CopyTableDialog({ d }: { d: Extract<DialogState, { kind: 'copyTable' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const sessions = useWorkspace((s) => s.sessions)
  const source = sessions[d.sessionId]
  const family = (e: string): string => (e === 'mariadb' ? 'mysql' : e)
  const candidates = Object.values(sessions).filter((s) => source && family(s.info.engine) === family(source.info.engine))
  const [targetId, setTargetId] = useState(d.sessionId)
  const target = sessions[targetId]
  const [database, setDatabase] = useState(d.ref.database ?? '')
  const [schema, setSchema] = useState(d.ref.schema ?? 'public')
  const [name, setName] = useState(`${d.ref.name}_copy`)
  const [withData, setWithData] = useState(true)
  const [dropExisting, setDropExisting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState(0)
  const [controller] = useState(() => new AbortController())
  const schemas = useWorkspace((s) => (target ? s.schemas[objectsKey(target.id, database)] : undefined))

  useEffect(() => {
    if (target?.info.engine === 'postgres' && database) void useWorkspace.getState().loadSchemas(target.id, database)
  }, [target, database])

  if (!source || !target) return null
  const engine = target.info.engine

  const run = async (): Promise<void> => {
    setBusy(true)
    setRows(0)
    try {
      const r = await copyTable({
        source,
        ref: d.ref,
        target,
        targetDatabase: engine === 'firebird' ? undefined : database || undefined,
        targetSchema: engine === 'postgres' ? schema : undefined,
        newName: name.trim(),
        withData,
        dropExisting,
        onProgress: setRows,
        signal: controller.signal
      })
      notify.success(t('copy.done', { rows: r.rows, name }))
      if (r.droppedForeignKeys) notify.info(t('copy.fksDropped', { count: r.droppedForeignKeys }))
      void useWorkspace.getState().loadObjects(target.id, engine === 'firebird' ? undefined : database, engine === 'postgres' ? schema : undefined, true)
      close()
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={`${t('copy.title')} — ${d.ref.name}`}
      width={560}
      footer={
        <>
          {busy && <span className="mr-auto flex items-center gap-2 text-xs text-muted"><Spinner size={12} />{t('copy.progress', { rows: rows.toLocaleString() })}</span>}
          {busy ? <Button onClick={() => controller.abort()}>{t('common.cancel')}</Button> : <Button onClick={close}>{t('common.cancel')}</Button>}
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void run()}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label={t('copy.targetSession')} className="col-span-2">
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.profile.name} · {s.info.label}
              </option>
            ))}
          </Select>
        </Field>
        {engine !== 'firebird' && (
          <Field label={t('copy.targetDatabase')}>
            <Select value={database} onChange={(e) => setDatabase(e.target.value)}>
              {(target.databases ?? []).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
        )}
        {engine === 'postgres' && (
          <Field label={t('copy.targetSchema')}>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>
              {(schemas ?? [schema]).filter((x) => !x.startsWith('pg_') && x !== 'information_schema').map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('copy.newName')} className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Checkbox checked={withData} onChange={setWithData} label={t('copy.withData')} />
        <Checkbox checked={dropExisting} onChange={setDropExisting} label={t('copy.dropExisting')} />
      </div>
    </Dialog>
  )
}
