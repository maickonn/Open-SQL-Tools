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
  Search,
  ListTree,
  Network,
  PauseCircle,
  Play,
  Power,
  PowerOff,
  TerminalSquare
} from 'lucide-react'
import type { DbObjectInfo, DbObjectRef, ObjectKind } from '@shared/model'
import { ContextMenu, Input, Spinner, cx, type MenuItem } from '../../components/ui'
import { canRename, canToggle, creatableKinds, hasListView, hasOperations } from '@domain/objectCapabilities'
import { useWorkspace, objectsKey, type ObjectSubView, type SessionState } from '../../stores/workspaceStore'
import { useUi } from '../../stores/uiStore'
import { notify } from '../../stores/toast'
import { confirmDialog, promptDialog } from '../../components/ui/prompts'
import { formatBytes } from '../../lib/format'
import { EngineBadge } from '../common/EngineBadge'

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

  const inactive = row.type === 'object' && !!row.object.inactive
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
    } else if (row.type === 'group') {
      // Generators / sequences and exceptions open as an editable grid, like IBExpert.
      if (hasListView(row.session.info.engine, row.kind)) openList(row.session, row.kind, row.database, row.schema, t, !pin)
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
        title={row.type === 'object' ? [inactive ? t('tree.inactive') : '', row.object.comment ?? ''].filter(Boolean).join(' · ') || undefined : undefined}
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
        <span className={cx('flex shrink-0 items-center', inactive && 'opacity-50')}>{icon}</span>
        <span
          className={cx('truncate', (row.type === 'session' || row.type === 'group') && 'font-medium', inactive && 'text-subtle')}
          style={row.type === 'session' && row.session.profile.color ? { color: row.session.profile.color } : undefined}
        >
          {label}
        </span>
        {inactive && <PauseCircle size={12} className="shrink-0 text-warning" aria-label={t('tree.inactive')} />}
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
  const session = row.session
  const sid = session.id
  const engine = session.info.engine
  const items: MenuItem[] = []
  const refresh = (): void => {
    if (row.type === 'session') {
      if (engine === 'firebird') void ws.loadObjects(sid, undefined, undefined, true)
      else void ws.refreshDatabases(sid)
    } else if (row.type === 'database') {
      if (engine === 'postgres') void ws.loadSchemas(sid, row.database, true)
      else void ws.loadObjects(sid, row.database, undefined, true)
    } else void ws.loadObjects(sid, row.database, row.schema, true)
  }
  const database = row.type === 'session' ? undefined : row.database
  const schema = row.type === 'schema' || row.type === 'object' || row.type === 'group' ? row.schema : undefined
  const kindLabel = (kind: ObjectKind): string => t(`kinds.${kind}`)
  // Object containers: Firebird sessions, MySQL databases, PostgreSQL schemas.
  const isContainer = row.type === 'schema' || (row.type === 'database' && engine !== 'postgres') || (row.type === 'session' && engine === 'firebird')
  const newItem = (kind: ObjectKind, table?: string): MenuItem => ({
    label: t('tree.newObject', { kind: kindLabel(kind) }),
    icon: <Plus size={14} />,
    onSelect: () => void newObject(session, kind, database, schema ?? (engine === 'postgres' ? 'public' : undefined), table, t)
  })

  items.push({ label: t('tree.newQuery'), icon: <TerminalSquare size={14} />, onSelect: () => ws.newQueryTab(sid, undefined, database) })

  if (isContainer) {
    items.push({
      label: t('tree.newMenu'),
      icon: <Plus size={14} />,
      items: creatableKinds(engine).map((kind) => {
        const Icon = KIND_ICONS[kind] ?? FileCode2
        return { label: t(groupLabel(kind, session)), icon: <Icon size={14} />, onSelect: () => void newObject(session, kind, database, schema ?? (engine === 'postgres' ? 'public' : undefined), undefined, t) }
      })
    })
  }

  if (row.type === 'group') {
    if (creatableKinds(engine).includes(row.kind)) items.push(newItem(row.kind))
    if (hasListView(engine, row.kind)) {
      items.push({ label: t('tree.openList'), icon: <ListOrdered size={14} />, onSelect: () => openList(session, row.kind as 'sequence' | 'exception', database, schema, t) })
    }
    if (canToggle(engine, row.kind)) {
      const all = loadedObjects(sid, database, schema).filter((o) => o.kind === row.kind).map(toRef)
      items.push({ label: t('tree.activateAll'), icon: <Power size={14} />, disabled: !all.length, onSelect: () => void setEnabled(session, all, true, t) })
      items.push({ label: t('tree.deactivateAll'), icon: <PowerOff size={14} />, disabled: !all.length, onSelect: () => void setEnabled(session, all, false, t) })
    }
  }

  if (row.type === 'object') {
    const ref = refOf(row)
    const kind = ref.kind
    const isTableLike = kind === 'table' || kind === 'view' || kind === 'materialized_view'
    const open = (view: ObjectSubView): void => {
      ws.openTab({ sessionId: sid, kind: 'object', title: ref.name, ref, database, schema, view })
    }
    items.push({ separator: true })
    if (creatableKinds(engine).includes(kind)) items.push(newItem(kind, kind === 'trigger' ? ref.table : undefined))
    if (kind === 'table' && creatableKinds(engine).includes('trigger')) items.push({ ...newItem('trigger', ref.name), icon: <Zap size={14} /> })
    if (kind === 'table') items.push({ label: t('tree.editStructure'), icon: <Pencil size={14} />, onSelect: () => open('structure') })
    else if (hasListView(engine, kind)) items.push({ label: t('tree.editObject', { kind: kindLabel(kind) }), icon: <Pencil size={14} />, onSelect: () => openList(session, kind, database, schema, t) })
    else items.push({ label: t('tree.editObject', { kind: kindLabel(kind) }), icon: <Pencil size={14} />, onSelect: () => open(kind === 'trigger' ? 'trigger' : 'ddl') })
    items.push({
      label: t('tree.dropObject', { kind: kindLabel(kind) }),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (await confirmDialog(t('tree.drop'), t('tree.dropConfirm', { kind: kindLabel(kind), name: ref.name }), true)) await objectAction(session, ref, 'drop')
      }
    })

    if (canToggle(engine, kind)) {
      const all = loadedObjects(sid, database, schema).filter((o) => o.kind === kind).map(toRef)
      const plural = t(groupLabel(kind, session)).toLowerCase()
      items.push({ separator: true })
      items.push({
        label: t('tree.deactivate'),
        icon: <PowerOff size={14} />,
        items: [
          { label: t('tree.selectedOnly'), disabled: row.object.inactive, onSelect: () => void setEnabled(session, [ref], false, t) },
          { label: t('tree.allOfKind', { kinds: plural }), onSelect: () => void setEnabled(session, all, false, t) }
        ]
      })
      items.push({
        label: t('tree.activate'),
        icon: <Power size={14} />,
        items: [
          { label: t('tree.selectedOnly'), disabled: !row.object.inactive, onSelect: () => void setEnabled(session, [ref], true, t) },
          { label: t('tree.allOfKind', { kinds: plural }), onSelect: () => void setEnabled(session, all, true, t) }
        ]
      })
    }
    if (kind === 'procedure' || kind === 'function') {
      items.push({ label: t('tree.runObject', { kind: kindLabel(kind) }), icon: <Play size={14} />, onSelect: () => void runRoutine(session, ref) })
    }
    if (kind === 'sequence') items.push({ label: t('tree.setValue'), icon: <ListOrdered size={14} />, onSelect: () => void setSequenceValue(session, ref, t) })

    items.push({ separator: true })
    if (isTableLike) items.push({ label: t('tree.showData'), icon: <Table2 size={14} />, onSelect: () => open('data') })
    items.push({ label: t('tree.showDdl'), icon: <FileCode2 size={14} />, onSelect: () => open('ddl') })
    items.push({ label: t('tree.dependencies'), icon: <Network size={14} />, onSelect: () => open('dependencies') })
    if (hasOperations(engine, kind)) items.push({ label: t('tree.operations'), icon: <ListTree size={14} />, onSelect: () => open('operations') })
    items.push({ label: t('tree.copyName'), icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(ref.name) })
    if (kind === 'table') items.push({ label: t('copy.menu'), icon: <CopyPlus size={14} />, onSelect: () => ui.openDialog({ kind: 'copyTable', sessionId: sid, ref }) })
    if (isTableLike) items.push({ label: t('tree.exportData'), icon: <FileDown size={14} />, onSelect: () => ui.openDialog({ kind: 'export', sessionId: sid, source: { ref, database }, title: ref.name }) })

    const extra: MenuItem[] = []
    if (kind === 'table') {
      extra.push({
        label: t('common.duplicate'),
        icon: <CopyPlus size={14} />,
        onSelect: async () => {
          const r = await promptDialog(t('common.duplicate'), t('tree.duplicatePrompt'), `${ref.name}_copy`, t('tree.withData'))
          if (!r) return
          await objectAction(session, ref, 'duplicate', r.value, r.checked)
        }
      })
    }
    if (canRename(engine, kind)) {
      extra.push({
        label: t('common.rename'),
        icon: <Pencil size={14} />,
        onSelect: async () => {
          const r = await promptDialog(t('common.rename'), t('tree.renamePrompt', { name: ref.name }), ref.name)
          if (r && r.value !== ref.name) await objectAction(session, ref, 'rename', r.value)
        }
      })
    }
    if (kind === 'table') {
      extra.push({
        label: t('menu.maintenance'),
        items: (['analyze', 'optimize', 'check', 'repair', 'vacuum'] as const).map((a) => ({ label: a.toUpperCase(), onSelect: () => void objectAction(session, ref, a) }))
      })
      extra.push({
        label: t('tree.truncate'),
        icon: <Eraser size={14} />,
        danger: true,
        onSelect: async () => {
          if (await confirmDialog(t('tree.truncate'), t('tree.truncateConfirm', { name: ref.name }), true)) await objectAction(session, ref, 'truncate')
        }
      })
    }
    if (extra.length) items.push({ separator: true }, ...extra)
  }
  if (row.type === 'database') {
    items.push({ separator: true })
    if (engine !== 'postgres') items.push({ label: t('bulk.menu'), icon: <Pencil size={14} />, onSelect: () => ui.openDialog({ kind: 'bulkEdit', sessionId: sid, database: row.database }) })
    items.push({ label: t('menu.dumpSql'), icon: <FileDown size={14} />, onSelect: () => ui.openDialog({ kind: 'dump', sessionId: sid, database: row.database }) })
    items.push({ label: t('menu.importSql'), onSelect: () => ui.openDialog({ kind: 'importSql', sessionId: sid, database: row.database }) })
    items.push({
      label: t('tree.drop'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (await confirmDialog(t('tree.drop'), t('tree.dropConfirm', { kind: t('kinds.database'), name: row.database }), true)) {
          await objectAction(session, { name: row.database, kind: 'database' }, 'drop')
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
      disabled: engine === 'firebird',
      onSelect: async () => {
        const r = await promptDialog(t('tree.createDatabase'), t('common.name'))
        if (!r) return
        const q = engine === 'postgres' ? `"${r.value.replace(/"/g, '""')}"` : `\`${r.value.replace(/`/g, '``')}\``
        try {
          await session.client.call('executeStatements', { statements: [`CREATE DATABASE ${q}`] })
          void ws.refreshDatabases(sid)
        } catch (err) {
          notify.error(err)
        }
      }
    })
    items.push({ label: t('tabs.host'), icon: <Server size={14} />, onSelect: () => ws.openTab({ sessionId: sid, kind: 'host', title: session.profile.name }) })
    items.push({ separator: true })
    items.push({ label: t('menu.disconnect'), icon: <X size={14} />, onSelect: () => void ws.closeSession(sid) })
  }
  items.push({ separator: true })
  items.push({ label: t('common.refresh'), icon: <RefreshCw size={14} />, shortcut: 'F5', onSelect: refresh })
  return items
}

const toRef = (o: DbObjectInfo): DbObjectRef => ({ database: o.database, schema: o.schema, name: o.name, kind: o.kind, args: o.args, table: o.table })

/** Objects already loaded for a container (the "all triggers" scope). */
function loadedObjects(sessionId: string, database?: string, schema?: string): DbObjectInfo[] {
  const entry = useWorkspace.getState().objects[objectsKey(sessionId, database, schema)]
  return entry?.status === 'ok' ? entry.items.map((o) => ({ ...o, database: o.database ?? database, schema: o.schema ?? schema })) : []
}

/** Opens a query tab with the engine's starter script for a new object. */
async function newObject(session: SessionState, kind: ObjectKind, database: string | undefined, schema: string | undefined, table: string | undefined, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  const ws = useWorkspace.getState()
  if (kind === 'table') {
    ws.openTab({ sessionId: session.id, kind: 'object', title: t('structure.newTable'), ref: { database, schema, name: '', kind: 'table' }, database, schema, isNew: true, view: 'structure' })
    return
  }
  if (kind === 'trigger') {
    // Triggers have a form; the dialect builds the DDL.
    ws.openTab({ sessionId: session.id, kind: 'object', title: t('tree.newObject', { kind: t('kinds.trigger') }), ref: { database, schema, name: '', kind: 'trigger', table }, database, schema, isNew: true, view: 'trigger' })
    return
  }
  try {
    const sql = await session.client.call('createTemplate', { kind, database, schema, table })
    ws.newQueryTab(session.id, sql, database)
  } catch (err) {
    notify.error(err)
  }
}

export function openList(session: SessionState, listKind: 'sequence' | 'exception', database: string | undefined, schema: string | undefined, t: (k: string, o?: Record<string, unknown>) => string, preview = false): void {
  const title = schema && session.info.engine === 'postgres' ? `${schema} · ${t(groupLabel(listKind, session))}` : t(groupLabel(listKind, session))
  useWorkspace.getState().openTab({ sessionId: session.id, kind: 'list', listKind, title, database, schema }, { preview })
}

async function setEnabled(session: SessionState, refs: DbObjectRef[], enabled: boolean, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  if (!refs.length) return
  try {
    await session.client.call('setEnabled', { refs, enabled })
    notify.success(t(enabled ? 'tree.activated' : 'tree.deactivated', { count: refs.length }))
    void useWorkspace.getState().loadObjects(session.id, refs[0].database, refs[0].schema, true)
  } catch (err) {
    notify.error(err)
  }
}

async function runRoutine(session: SessionState, ref: DbObjectRef): Promise<void> {
  try {
    const sql = await session.client.call('getRoutineCall', { ref })
    useWorkspace.getState().newQueryTab(session.id, sql, ref.database)
  } catch (err) {
    notify.error(err)
  }
}

async function setSequenceValue(session: SessionState, ref: DbObjectRef, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  try {
    const current = (await session.client.call('listSequences', { database: ref.database, schema: ref.schema })).find((s) => s.name === ref.name)
    const r = await promptDialog(t('tree.setValue'), t('tree.setValuePrompt', { name: ref.name }), current?.value ?? '0')
    if (!r) return
    await session.client.call('setSequenceValue', { ref, value: r.value })
    notify.success(t('tree.valueSet', { name: ref.name, value: r.value }))
  } catch (err) {
    notify.error(err)
  }
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
