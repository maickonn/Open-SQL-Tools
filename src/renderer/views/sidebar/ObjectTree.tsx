import { memo, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  Copy,
  Database,
  Eye,
  FileCode2,
  FolderTree,
  Layers,
  ListOrdered,
  Package,
  Plus,
  RefreshCw,
  Shapes,
  Sigma,
  Table2,
  Trash2,
  Type,
  Workflow,
  X,
  Zap,
  Pencil,
  CopyPlus,
  Eraser,
  FileDown,
  Server,
  Search
} from 'lucide-react'
import type { DbObjectInfo, DbObjectRef, ObjectKind } from '@shared/model'
import { ContextMenu, Input, Spinner, cx, type MenuItem } from '../../components/ui'
import { useWorkspace, objectsKey, type SessionState } from '../../stores/workspaceStore'
import { useUi } from '../../stores/uiStore'
import { notify } from '../../stores/toast'
import { confirmDialog, promptDialog } from '../../components/ui/prompts'
import { formatBytes } from '../../lib/format'
import { EngineBadge } from '../common/EngineBadge'
import { routineTemplate, viewTemplate } from './templates'

const KIND_ORDER: ObjectKind[] = ['table', 'view', 'materialized_view', 'procedure', 'function', 'package', 'trigger', 'event', 'sequence', 'domain', 'type', 'exception']

export const KIND_ICONS: Record<string, typeof Table2> = {
  table: Table2,
  view: Eye,
  materialized_view: Layers,
  procedure: Workflow,
  function: Sigma,
  trigger: Zap,
  event: CalendarClock,
  sequence: ListOrdered,
  domain: Shapes,
  exception: AlertTriangle,
  package: Package,
  type: Type,
  schema: FolderTree,
  database: Database
}

/** i18n key of the category node grouping each object kind. */
const GROUP_LABELS: Partial<Record<ObjectKind, string>> = {
  table: 'tree.tables',
  view: 'tree.views',
  materialized_view: 'tree.materializedViews',
  procedure: 'tree.procedures',
  function: 'tree.functions',
  package: 'tree.packages',
  trigger: 'tree.triggers',
  event: 'tree.events',
  sequence: 'tree.sequences',
  domain: 'tree.domains',
  type: 'tree.types',
  exception: 'tree.exceptions'
}

const groupLabel = (kind: ObjectKind, session: SessionState): string =>
  kind === 'sequence' && session.info.engine === 'firebird' ? 'tree.generators' : (GROUP_LABELS[kind] ?? `kinds.${kind}`)

type Row =
  | { type: 'session'; key: string; depth: number; session: SessionState }
  | { type: 'database'; key: string; depth: number; session: SessionState; database: string }
  | { type: 'schema'; key: string; depth: number; session: SessionState; database: string; schema: string }
  | { type: 'group'; key: string; depth: number; session: SessionState; database?: string; schema?: string; kind: ObjectKind; count: number; open: boolean }
  | { type: 'object'; key: string; depth: number; session: SessionState; database?: string; schema?: string; object: DbObjectInfo }
  | { type: 'status'; key: string; depth: number; text: string; loading?: boolean; error?: boolean }

const ROW_HEIGHT = 24

export function ObjectTree() {
  const { t } = useTranslation()
  const sessions = useWorkspace((s) => s.sessions)
  const objects = useWorkspace((s) => s.objects)
  const schemas = useWorkspace((s) => s.schemas)
  const expanded = useWorkspace((s) => s.expanded)
  const selected = useWorkspace((s) => s.selectedNode)
  const [filter, setFilter] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: Row[] = []
    const f = filter.trim().toLowerCase()
    const pushObjects = (session: SessionState, depth: number, database?: string, schema?: string): void => {
      const entry = objects[objectsKey(session.id, database, schema)]
      const base = `${session.id}|${database ?? ''}|${schema ?? ''}`
      if (!entry || entry.status === 'loading') {
        out.push({ type: 'status', key: `${base}|loading`, depth, text: t('common.loading'), loading: true })
        return
      }
      if (entry.status === 'error') {
        out.push({ type: 'status', key: `${base}|error`, depth, text: entry.error, error: true })
        return
      }
      const byKind = new Map<ObjectKind, DbObjectInfo[]>()
      for (const o of entry.items) {
        if (f && !o.name.toLowerCase().includes(f)) continue
        const list = byKind.get(o.kind)
        if (list) list.push(o)
        else byKind.set(o.kind, [o])
      }
      if (!byKind.size) out.push({ type: 'status', key: `${base}|empty`, depth, text: t('tree.empty') })
      const kinds = [...byKind.keys()].sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99))
      for (const kind of kinds) {
        const list = byKind.get(kind)!.sort((a, b) => a.name.localeCompare(b.name))
        const key = `${base}|group|${kind}`
        // Tables start expanded; a filter opens every category that has matches.
        const open = f ? true : (expanded[key] ?? kind === 'table')
        out.push({ type: 'group', key, depth, session, database, schema, kind, count: list.length, open })
        if (!open) continue
        for (const o of list) out.push({ type: 'object', key: `${base}|${o.kind}|${o.name}|${o.args ?? ''}`, depth: depth + 1, session, database, schema, object: o })
      }
    }
    for (const session of Object.values(sessions)) {
      out.push({ type: 'session', key: session.id, depth: 0, session })
      if (!expanded[session.id]) continue
      if (session.info.engine === 'firebird') {
        pushObjects(session, 1)
        continue
      }
      if (!session.databases) {
        out.push({ type: 'status', key: `${session.id}|dbloading`, depth: 1, text: t('common.loading'), loading: true })
        continue
      }
      for (const db of session.databases) {
        const dbKey = `${session.id}|db|${db}`
        out.push({ type: 'database', key: dbKey, depth: 1, session, database: db })
        if (!expanded[dbKey]) continue
        if (session.info.engine === 'postgres') {
          const list = schemas[objectsKey(session.id, db)]
          if (!list) {
            out.push({ type: 'status', key: `${dbKey}|loading`, depth: 2, text: t('common.loading'), loading: true })
            continue
          }
          for (const schema of list) {
            const sKey = `${dbKey}|schema|${schema}`
            out.push({ type: 'schema', key: sKey, depth: 2, session, database: db, schema })
            if (expanded[sKey]) pushObjects(session, 3, db, schema)
          }
        } else pushObjects(session, 2, db)
      }
    }
    return out
  }, [sessions, objects, schemas, expanded, filter, t])

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT, overscan: 20 })

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('tree.filter')} className="h-7 pl-7 text-xs" />
          {filter && (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-subtle hover:text-fg" onClick={() => setFilter('')}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1" role="tree">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            return (
              <div key={row.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}>
                <TreeRow row={row} selected={selected === row.key} expanded={row.type === 'group' ? row.open : !!expanded[row.key]} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const TreeRow = memo(function TreeRow({ row, selected, expanded }: { row: Row; selected: boolean; expanded: boolean }) {
  const { t } = useTranslation()
  const ws = useWorkspace.getState
  const pad = 6 + row.depth * 14

  if (row.type === 'status') {
    return (
      <div className={cx('flex h-6 items-center gap-1.5 truncate text-xs', row.error ? 'text-danger' : 'text-subtle')} style={{ paddingLeft: pad + 18 }} title={row.text}>
        {row.loading && <Spinner size={12} />}
        <span className="truncate">{row.text}</span>
      </div>
    )
  }

  const expandable = row.type !== 'object'
  const toggle = (): void => {
    const open = !expanded
    ws().toggleNode(row.key, open)
    if (!open) return
    if (row.type === 'session' && row.session.info.engine === 'firebird') void ws().loadObjects(row.session.id)
    if (row.type === 'database') {
      if (row.session.info.engine === 'postgres') void ws().loadSchemas(row.session.id, row.database)
      else void ws().loadObjects(row.session.id, row.database)
    }
    if (row.type === 'schema') void ws().loadObjects(row.session.id, row.database, row.schema)
  }

  const activate = (pin: boolean): void => {
    ws().selectNode(row.key)
    if (row.type === 'session') {
      ws().openTab({ sessionId: row.session.id, kind: 'host', title: row.session.profile.name }, { preview: !pin })
    } else if (row.type === 'database' || row.type === 'schema') {
      ws().openTab(
        { sessionId: row.session.id, kind: 'database', title: row.type === 'schema' ? `${row.database}.${row.schema}` : row.database, database: row.database, schema: row.type === 'schema' ? row.schema : undefined },
        { preview: !pin }
      )
      if (row.type === 'database' && row.session.info.engine !== 'postgres') void ws().loadObjects(row.session.id, row.database)
    } else if (row.type === 'object') {
      const ref = refOf(row)
      ws().openTab(
        { sessionId: row.session.id, kind: 'object', title: row.object.name, ref, database: row.database, schema: row.schema, view: pin && (ref.kind === 'table' || ref.kind === 'view') ? 'data' : undefined },
        { preview: !pin }
      )
    }
  }

  let icon
  let label: string
  let detail: string | undefined
  let count: number | undefined
  if (row.type === 'session') {
    icon = <EngineBadge engine={row.session.info.engine} />
    label = row.session.profile.name
    detail = row.session.info.label
  } else if (row.type === 'database') {
    icon = <Database size={14} className="text-warning" />
    label = row.database
  } else if (row.type === 'schema') {
    icon = <FolderTree size={14} className="text-muted" />
    label = row.schema
  } else if (row.type === 'group') {
    const Icon = KIND_ICONS[row.kind] ?? FileCode2
    icon = <Icon size={14} className={row.kind === 'table' ? 'text-accent' : 'text-muted'} />
    label = t(groupLabel(row.kind, row.session))
    count = row.count
  } else {
    const Icon = KIND_ICONS[row.object.kind] ?? FileCode2
    icon = <Icon size={14} className={row.object.kind === 'table' ? 'text-accent' : 'text-muted'} />
    label = row.object.args !== undefined ? `${row.object.name}(${row.object.args})` : row.object.name
    detail = row.object.kind === 'table' && row.object.sizeBytes ? formatBytes(row.object.sizeBytes) : undefined
  }

  return (
    <ContextMenu items={() => contextItems(row, t)}>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? expanded : undefined}
        tabIndex={-1}
        onClick={() => activate(false)}
        onDoubleClick={() => (expandable ? toggle() : activate(true))}
        className={cx(
          'group mx-1 flex h-6 cursor-default items-center gap-1.5 rounded-md pr-2 text-[13px]',
          selected ? 'bg-accent-soft text-fg' : 'hover:bg-hover'
        )}
        style={{ paddingLeft: pad }}
        title={row.type === 'object' && row.object.comment ? row.object.comment : undefined}
      >
        <span
          className={cx('flex h-4 w-4 shrink-0 items-center justify-center text-subtle', !expandable && 'invisible')}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          <ChevronRight size={13} className={cx('transition-transform', expanded && 'rotate-90')} />
        </span>
        <span className="flex shrink-0 items-center">{icon}</span>
        <span className={cx('truncate', (row.type === 'session' || row.type === 'group') && 'font-medium')} style={row.type === 'session' && row.session.profile.color ? { color: row.session.profile.color } : undefined}>
          {label}
        </span>
        {count !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-accent">({count})</span>}
        {row.type === 'session' && row.session.lost && <AlertTriangle size={12} className="shrink-0 text-danger" />}
        {detail && <span className="ml-auto shrink-0 pl-2 text-[11px] text-subtle">{detail}</span>}
      </div>
    </ContextMenu>
  )
})

function refOf(row: Extract<Row, { type: 'object' }>): DbObjectRef {
  return { database: row.database, schema: row.schema, name: row.object.name, kind: row.object.kind, args: row.object.args, table: row.object.table }
}

function contextItems(row: Row, t: (k: string, o?: Record<string, unknown>) => string): MenuItem[] {
  const ws = useWorkspace.getState()
  const ui = useUi.getState()
  if (row.type === 'status') return []
  const sid = row.session.id
  const items: MenuItem[] = []
  const refresh = (): void => {
    if (row.type === 'session') {
      if (row.session.info.engine === 'firebird') void ws.loadObjects(sid, undefined, undefined, true)
      else void ws.refreshDatabases(sid)
    } else if (row.type === 'database') {
      if (row.session.info.engine === 'postgres') void ws.loadSchemas(sid, row.database, true)
      else void ws.loadObjects(sid, row.database, undefined, true)
    } else void ws.loadObjects(sid, row.database, row.schema, true)
  }
  const database = row.type === 'session' ? undefined : row.database
  const schema = row.type === 'schema' || row.type === 'object' || row.type === 'group' ? row.schema : undefined

  items.push({ label: t('tree.newQuery'), icon: <Plus size={14} />, onSelect: () => ws.newQueryTab(sid, undefined, database) })
  if (row.type !== 'object') {
    items.push({
      label: t('tree.createTable'),
      icon: <Table2 size={14} />,
      disabled: row.type === 'session' && row.session.info.engine !== 'firebird',
      onSelect: () =>
        ws.openTab({ sessionId: sid, kind: 'object', title: t('structure.newTable'), ref: { database, schema: schema ?? (row.session.info.engine === 'postgres' ? 'public' : undefined), name: '', kind: 'table' }, database, schema, isNew: true, view: 'structure' })
    })
  }
  if (row.type !== 'object' && (row.type !== 'session' || row.session.info.engine === 'firebird')) {
    const engine = row.session.info.engine
    const qualifier = engine === 'postgres' ? `${schema ?? 'public'}.` : engine === 'firebird' || !database ? '' : `\`${database}\`.`
    items.push({ label: t('tree.createView'), icon: <Eye size={14} />, onSelect: () => ws.newQueryTab(sid, viewTemplate(engine, qualifier), database) })
    items.push({ label: t('tree.createRoutine'), icon: <Workflow size={14} />, onSelect: () => ws.newQueryTab(sid, routineTemplate(engine, qualifier), database) })
  }
  if (row.type === 'object') {
    const ref = refOf(row)
    const isTableLike = ref.kind === 'table' || ref.kind === 'view' || ref.kind === 'materialized_view'
    if (isTableLike) {
      items.push({ label: t('tree.showData'), icon: <Table2 size={14} />, onSelect: () => ws.openTab({ sessionId: sid, kind: 'object', title: ref.name, ref, database, schema, view: 'data' }) })
    }
    if (ref.kind === 'table') items.push({ label: t('tree.editStructure'), icon: <Pencil size={14} />, onSelect: () => ws.openTab({ sessionId: sid, kind: 'object', title: ref.name, ref, database, schema, view: 'structure' }) })
    items.push({ label: t('tree.showDdl'), icon: <FileCode2 size={14} />, onSelect: () => ws.openTab({ sessionId: sid, kind: 'object', title: ref.name, ref, database, schema, view: 'ddl' }) })
    items.push({ label: t('tree.copyName'), icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(ref.name) })
    if (ref.kind === 'table') items.push({ label: t('copy.menu'), icon: <CopyPlus size={14} />, onSelect: () => ui.openDialog({ kind: 'copyTable', sessionId: sid, ref }) })
    if (isTableLike) items.push({ label: t('tree.exportData'), icon: <FileDown size={14} />, onSelect: () => ui.openDialog({ kind: 'export', sessionId: sid, source: { ref, database }, title: ref.name }) })
    items.push({ separator: true })
    if (ref.kind === 'table') {
      items.push({
        label: t('common.duplicate'),
        icon: <CopyPlus size={14} />,
        onSelect: async () => {
          const r = await promptDialog(t('common.duplicate'), t('tree.duplicatePrompt'), `${ref.name}_copy`, t('tree.withData'))
          if (!r) return
          await objectAction(row.session, ref, 'duplicate', r.value, r.checked)
        }
      })
    }
    items.push({
      label: t('common.rename'),
      icon: <Pencil size={14} />,
      onSelect: async () => {
        const r = await promptDialog(t('common.rename'), t('tree.renamePrompt', { name: ref.name }), ref.name)
        if (r && r.value !== ref.name) await objectAction(row.session, ref, 'rename', r.value)
      }
    })
    if (ref.kind === 'table') {
      items.push({
        label: t('menu.maintenance'),
        items: (['analyze', 'optimize', 'check', 'repair', 'vacuum'] as const).map((a) => ({ label: a.toUpperCase(), onSelect: () => void objectAction(row.session, ref, a) }))
      })
      items.push({
        label: t('tree.truncate'),
        icon: <Eraser size={14} />,
        danger: true,
        onSelect: async () => {
          if (await confirmDialog(t('tree.truncate'), t('tree.truncateConfirm', { name: ref.name }), true)) await objectAction(row.session, ref, 'truncate')
        }
      })
    }
    items.push({
      label: t('tree.drop'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (await confirmDialog(t('tree.drop'), t('tree.dropConfirm', { kind: t(`kinds.${ref.kind}`), name: ref.name }), true)) await objectAction(row.session, ref, 'drop')
      }
    })
  }
  if (row.type === 'database') {
    items.push({ separator: true })
    if (row.session.info.engine !== 'postgres') items.push({ label: t('bulk.menu'), icon: <Pencil size={14} />, onSelect: () => ui.openDialog({ kind: 'bulkEdit', sessionId: sid, database: row.database }) })
    items.push({ label: t('menu.dumpSql'), icon: <FileDown size={14} />, onSelect: () => ui.openDialog({ kind: 'dump', sessionId: sid, database: row.database }) })
    items.push({ label: t('menu.importSql'), onSelect: () => ui.openDialog({ kind: 'importSql', sessionId: sid, database: row.database }) })
    items.push({
      label: t('tree.drop'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (await confirmDialog(t('tree.drop'), t('tree.dropConfirm', { kind: t('kinds.database'), name: row.database }), true)) {
          await objectAction(row.session, { name: row.database, kind: 'database' }, 'drop')
          void ws.refreshDatabases(sid)
        }
      }
    })
  }
  if (row.type === 'schema') {
    items.push({ separator: true })
    items.push({ label: t('bulk.menu'), icon: <Pencil size={14} />, onSelect: () => ui.openDialog({ kind: 'bulkEdit', sessionId: sid, database: row.database, schema: row.schema }) })
  }
  if (row.type === 'session') {
    items.push({
      label: t('tree.createDatabase'),
      icon: <Database size={14} />,
      disabled: row.session.info.engine === 'firebird',
      onSelect: async () => {
        const r = await promptDialog(t('tree.createDatabase'), t('common.name'))
        if (!r) return
        const q = row.session.info.engine === 'postgres' ? `"${r.value.replace(/"/g, '""')}"` : `\`${r.value.replace(/`/g, '``')}\``
        try {
          await row.session.client.call('executeStatements', { statements: [`CREATE DATABASE ${q}`] })
          void ws.refreshDatabases(sid)
        } catch (err) {
          notify.error(err)
        }
      }
    })
    items.push({ label: t('tabs.host'), icon: <Server size={14} />, onSelect: () => ws.openTab({ sessionId: sid, kind: 'host', title: row.session.profile.name }) })
    items.push({ separator: true })
    items.push({ label: t('menu.disconnect'), icon: <X size={14} />, onSelect: () => void ws.closeSession(sid) })
  }
  items.push({ separator: true })
  items.push({ label: t('common.refresh'), icon: <RefreshCw size={14} />, shortcut: 'F5', onSelect: refresh })
  return items
}

async function objectAction(
  session: SessionState,
  ref: DbObjectRef,
  action: 'drop' | 'truncate' | 'rename' | 'duplicate' | 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum',
  newName?: string,
  withData?: boolean
): Promise<void> {
  try {
    await session.client.call('objectAction', { ref, action, newName, withData })
    const ws = useWorkspace.getState()
    if (action === 'drop' || action === 'rename') {
      for (const tab of ws.tabs.filter((x) => x.sessionId === session.id && x.ref?.name === ref.name && x.ref?.kind === ref.kind)) ws.closeTab(tab.id)
    }
    if (ref.kind !== 'database') void ws.loadObjects(session.id, ref.database, ref.schema, true)
  } catch (err) {
    notify.error(err)
  }
}
