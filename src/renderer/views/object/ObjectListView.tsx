import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { DbObjectRef, ExceptionInfo, SequenceInfo } from '@shared/model'
import { useWorkspace, type Tab } from '../../stores/workspaceStore'
import { Button, Empty, IconButton, Input, Spinner, cx } from '../../components/ui'
import { confirmDialog } from '../../components/ui/prompts'
import { notify } from '../../stores/toast'
import { errorMessage } from '../../gateways/api'

interface Row {
  name: string
  /** Editable value: the generator's current value or the exception's message. */
  value: string
  number?: number
  increment?: number
  comment?: string
}

/**
 * Grid of generators / sequences (current values) or Firebird exceptions (messages),
 * opened from the tree's category node. Values are edited in place.
 */
export default function ObjectListView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation()
  const session = useWorkspace((s) => s.sessions[tab.sessionId])
  const kind = tab.listKind!
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const loaded = useRef(false)

  const load = useCallback(async () => {
    if (!session) return
    try {
      if (kind === 'sequence') {
        const list: SequenceInfo[] = await session.client.call('listSequences', { database: tab.database, schema: tab.schema })
        setRows(list.map((s) => ({ name: s.name, value: s.value, increment: s.increment, comment: s.comment })))
      } else {
        const list: ExceptionInfo[] = await session.client.call('listExceptions', undefined)
        setRows(list.map((e) => ({ name: e.name, value: e.message, number: e.number, comment: e.comment })))
      }
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [session, kind, tab.database, tab.schema])

  useEffect(() => {
    if (active && !loaded.current) {
      loaded.current = true
      void load()
    }
  }, [active, load])

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (rows ?? []).filter((r) => !f || r.name.toLowerCase().includes(f) || r.value.toLowerCase().includes(f))
  }, [rows, filter])

  if (!session) return null
  const refOf = (name: string): DbObjectRef => ({ database: tab.database, schema: tab.schema, name, kind })

  const save = async (row: Row, value: string): Promise<void> => {
    setEditing(null)
    if (value === row.value) return
    try {
      if (kind === 'sequence') await session.client.call('setSequenceValue', { ref: refOf(row.name), value })
      else await session.client.call('setExceptionMessage', { ref: refOf(row.name), message: value })
      setRows((list) => list?.map((r) => (r.name === row.name ? { ...r, value } : r)) ?? null)
      notify.success(t('list.saved', { name: row.name }))
    } catch (err) {
      notify.error(err)
    }
  }

  const create = async (): Promise<void> => {
    try {
      const sql = await session.client.call('createTemplate', { kind, database: tab.database, schema: tab.schema })
      useWorkspace.getState().newQueryTab(session.id, sql, tab.database)
    } catch (err) {
      notify.error(err)
    }
  }

  const drop = async (): Promise<void> => {
    if (!selected) return
    if (!(await confirmDialog(t('tree.drop'), t('tree.dropConfirm', { kind: t(`kinds.${kind}`), name: selected }), true))) return
    try {
      await session.client.call('objectAction', { ref: refOf(selected), action: 'drop' })
      setSelected(null)
      void load()
      void useWorkspace.getState().loadObjects(session.id, tab.database, tab.schema, true)
    } catch (err) {
      notify.error(err)
    }
  }

  const columns = kind === 'sequence' ? ['name', 'value', 'increment', 'description'] : ['number', 'name', 'message', 'description']

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => void create()}>
          {t('tree.newObject', { kind: t(`kinds.${kind}`) })}
        </Button>
        <IconButton label={t('tree.drop')} disabled={!selected} onClick={() => void drop()}>
          <Trash2 size={14} />
        </IconButton>
        <IconButton label={t('common.refresh')} onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
        <div className="relative ml-2 w-64">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('list.filter')} className="h-7 pl-7 text-xs" />
        </div>
        <span className="ml-auto truncate text-[11px] text-subtle">{t('list.editHint')}</span>
      </div>
      {error ? (
        <Empty title={error} />
      ) : !rows ? (
        <div className="flex h-full items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : !visible.length ? (
        <Empty title={t('list.empty')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]" role="grid">
            <thead className="sticky top-0 z-10 bg-panel text-left text-muted">
              <tr>
                {columns.map((c) => (
                  <th key={c} className={cx('border-b border-border px-2 py-1.5 font-medium', (c === 'value' || c === 'increment' || c === 'number') && kind === 'sequence' && 'text-right')}>
                    {t(`list.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.name}
                  onClick={() => setSelected(r.name)}
                  className={cx('cursor-default border-b border-border/60', r.name === selected ? 'bg-accent-soft' : 'hover:bg-hover')}
                >
                  {kind === 'exception' && <td className="w-16 px-2 py-1 text-right tabular-nums text-muted">{r.number}</td>}
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{r.name}</td>
                  <td
                    className={cx('px-2 py-1 font-mono', kind === 'sequence' ? 'w-40 text-right tabular-nums' : 'w-full')}
                    onDoubleClick={() => setEditing(r.name)}
                  >
                    {editing === r.name ? (
                      <input
                        autoFocus
                        defaultValue={r.value}
                        aria-label={t(kind === 'sequence' ? 'list.value' : 'list.message')}
                        className={cx('h-6 w-full rounded border border-accent bg-sunken px-1.5 outline-none', kind === 'sequence' && 'text-right')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void save(r, e.currentTarget.value)
                          else if (e.key === 'Escape') setEditing(null)
                        }}
                        onBlur={(e) => void save(r, e.currentTarget.value)}
                      />
                    ) : (
                      r.value
                    )}
                  </td>
                  {kind === 'sequence' && <td className="w-24 px-2 py-1 text-right tabular-nums text-muted">{r.increment}</td>}
                  <td className="truncate px-2 py-1 text-muted">{r.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
