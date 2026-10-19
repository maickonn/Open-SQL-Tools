import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, RefreshCw, Search } from 'lucide-react'
import type { ColumnMeta } from '@shared/model'
import { useWorkspace, objectsKey, type Tab } from '../../stores/workspaceStore'
import { Empty, IconButton, Input, Spinner } from '../../components/ui'
import { ResultGrid } from '../../components/grid/ResultGrid'
import { ResultSet } from '../../lib/resultSet'
import { formatBytes } from '../../lib/format'
import { useUi } from '../../stores/uiStore'

/** Lists the objects of a database/schema with size, rows and comment (HeidiSQL "Database" tab). */
export function DatabaseView({ tab }: { tab: Tab }) {
  const { t } = useTranslation()
  const session = useWorkspace((s) => s.sessions[tab.sessionId])
  const isPg = session?.info.engine === 'postgres'
  const schema = tab.schema
  const key = objectsKey(tab.sessionId, tab.database, schema)
  const entry = useWorkspace((s) => s.objects[key])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!session) return
    if (isPg && !tab.schema) void useWorkspace.getState().loadSchemas(session.id, tab.database!)
    else void useWorkspace.getState().loadObjects(session.id, tab.database, schema)
  }, [session, isPg, tab.database, tab.schema, schema])

  const result = useMemo(() => {
    const columns: ColumnMeta[] = [
      { name: t('common.name'), type: 'VARCHAR', category: 'string' },
      { name: t('common.type'), type: 'VARCHAR', category: 'string' },
      { name: t('database.rows'), type: 'BIGINT', category: 'integer' },
      { name: t('database.size'), type: 'VARCHAR', category: 'string' },
      { name: t('database.engine'), type: 'VARCHAR', category: 'string' },
      { name: t('database.collation'), type: 'VARCHAR', category: 'string' },
      { name: t('database.updated'), type: 'DATETIME', category: 'datetime' },
      { name: t('common.comment'), type: 'VARCHAR', category: 'string' }
    ]
    if (entry?.status !== 'ok') return ResultSet.fromRows(columns, [])
    const f = filter.trim().toLowerCase()
    const rows = entry.items
      .filter((o) => !f || o.name.toLowerCase().includes(f))
      .map((o) => [
        o.args !== undefined ? `${o.name}(${o.args})` : o.name,
        t(`kinds.${o.kind}`),
        o.rows ?? null,
        o.sizeBytes ? formatBytes(o.sizeBytes) : null,
        o.engine ?? null,
        o.collation ?? null,
        o.updatedAt ?? o.createdAt ?? null,
        o.comment ?? null
      ])
    return ResultSet.fromRows(columns, rows)
  }, [entry, filter, t])

  if (!session) return null
  if (isPg && !tab.schema) {
    return <Empty title={tab.database ?? ''}>{t('tree.databases')}</Empty>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3">
        <span className="text-sm font-semibold">{tab.title}</span>
        {entry?.status === 'ok' && <span className="text-xs text-muted">{t('database.objects', { count: entry.items.length })}</span>}
        <div className="flex-1" />
        <div className="relative w-56">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('common.filter')} className="h-7 pl-7 text-xs" />
        </div>
        {session.info.engine !== 'firebird' && (
          <IconButton label={t('bulk.menu')} onClick={() => useUi.getState().openDialog({ kind: 'bulkEdit', sessionId: session.id, database: tab.database, schema })}>
            <Layers size={15} />
          </IconButton>
        )}
        <IconButton label={t('common.refresh')} onClick={() => void useWorkspace.getState().loadObjects(session.id, tab.database, schema, true)}>
          {entry?.status === 'loading' ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        {entry?.status === 'error' ? <Empty title={entry.error} /> : <ResultGrid result={result} />}
      </div>
    </div>
  )
}
