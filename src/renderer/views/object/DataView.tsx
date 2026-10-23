import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsDown, Filter, RefreshCw, X } from 'lucide-react'
import type { DbObjectRef, LobKind, TableDataRequest, TableStructure } from '@shared/model'
import { lobKind } from '@domain/lob'
import type { SessionState } from '../../stores/workspaceStore'
import { useSettings } from '../../stores/settingsStore'
import { ResultSet } from '../../lib/resultSet'
import { runScript } from '../../stores/queryStore'
import { Button, IconButton, Input, Spinner, Tooltip } from '../../components/ui'
import { notify } from '../../stores/toast'
import { exportSources } from '../commands'
import { EditableGrid, tableKey } from './EditableGrid'

export function DataView({
  session,
  refObj,
  tabId,
  active,
  structure,
  structurePending
}: {
  session: SessionState
  refObj: DbObjectRef
  tabId: string
  active: boolean
  structure: TableStructure | null
  /** The table structure is still loading: wait for it to know the key and the LOB columns. */
  structurePending: boolean
}) {
  const { t } = useTranslation()
  const settings = useSettings((s) => s.settings)
  const [result, setResult] = useState<ResultSet>(() => new ResultSet())
  const [loading, setLoading] = useState(false)
  const [where, setWhere] = useState('')
  const [appliedWhere, setAppliedWhere] = useState('')
  const [sort, setSort] = useState<{ column: string; desc: boolean }[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const loaded = useRef(false)
  /** Filter + sort of the last full load; a reload happens only when they change. */
  const loadedKey = useRef<string | null>(null)
  const editable = refObj.kind === 'table'

  // Large objects load on demand, located by key: without one the grid reads them eagerly.
  const lazy = useMemo(() => {
    const keyColumns = tableKey(structure)
    if (!structure || !keyColumns) return []
    return structure.columns.flatMap((c) => {
      const kind = lobKind(session.info.engine, c)
      return kind && !keyColumns.includes(c.name) ? [{ column: c.name, kind, charset: c.charset }] : []
    })
  }, [structure, session.info.engine])
  /** LOB columns of the loaded result (by index) holding previews instead of values. */
  const [lazyCols, setLazyCols] = useState<Map<number, LobKind>>(() => new Map())

  const load = useCallback(
    async (opts?: { append?: boolean; all?: boolean }) => {
      setLoading(true)
      try {
        if (!opts?.append) loadedKey.current = JSON.stringify([appliedWhere, sort])
        const offset = opts?.append ? result.rowCount : 0
        const limit = opts?.all ? Number.MAX_SAFE_INTEGER : settings.dataPageSize
        const req: TableDataRequest = { ref: refObj, where: appliedWhere || undefined, orderBy: sort, offset, limit: Math.min(limit, 2_147_483_647) }
        const columns = structure?.columns.filter((c) => !c.invisible).map((c) => c.name)
        const lazyReq = lazy.length && columns ? { ...req, columns, lazy } : null
        const sql = await session.client.call('tableDataSql', lazyReq ?? req)
        // Exports re-run the result's SQL: they get the full values.
        const fullSql = lazyReq ? await session.client.call('tableDataSql', req) : sql
        let page: ResultSet | null = null
        const summary = await runScript(session.client, sql, {
          database: refObj.database,
          maxRows: opts?.all ? Number.MAX_SAFE_INTEGER : settings.dataPageSize,
          onResult: (rs) => {
            rs.sql = fullSql
            page = rs
            if (!opts?.append) {
              setLazyCols(new Map(lazyReq ? lazy.map((l) => [rs.columns.findIndex((c) => c.name === l.column), l.kind] as const) : []))
              setResult(rs)
            }
          }
        })
        const err = summary.statements.find((s) => s.error)?.error
        if (err) throw new Error(err.message)
        if (opts?.append && page) {
          result.mergeFrom(page)
          setRevision((r) => r + 1)
        }
        if (!opts?.append) {
          void session.client
            .call('countRows', { ref: refObj, where: appliedWhere || undefined })
            .then(setTotal)
            .catch(() => setTotal(null))
        }
      } catch (err) {
        notify.error(err)
      } finally {
        setLoading(false)
      }
    },
    [session, refObj, appliedWhere, sort, settings.dataPageSize, result, structure, lazy]
  )

  useEffect(() => {
    if (!active || structurePending) return
    if (!loaded.current) {
      loaded.current = true
      void load()
    }
  }, [active, structurePending, load])

  // Reload when filter or sort change after the first load. Comparing with what was loaded (instead
  // of skipping the first run) keeps StrictMode's double effect run from issuing a second SELECT.
  useEffect(() => {
    if (!loaded.current || loadedKey.current === JSON.stringify([appliedWhere, sort])) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedWhere, sort])

  useEffect(() => {
    exportSources.set(tabId, () => ({ result, ref: refObj, database: refObj.database }))
    return () => {
      exportSources.delete(tabId)
    }
  }, [tabId, result, refObj])

  const sortBy = (column: string): void => {
    setSort((s) => {
      const cur = s.find((x) => x.column === column)
      if (!cur) return [{ column, desc: false }]
      if (!cur.desc) return [{ column, desc: true }]
      return []
    })
  }

  return (
    <EditableGrid
      session={session}
      refObj={refObj}
      structure={structure}
      result={result}
      editable={editable}
      lazyCols={lazyCols}
      revision={revision}
      sort={sort}
      onSort={sortBy}
      onApplied={() => load()}
      toolbarStart={
        <>
          <Filter size={14} className="ml-1 shrink-0 text-subtle" />
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setAppliedWhere(where.trim())
            }}
          >
            <Input value={where} onChange={(e) => setWhere(e.target.value)} placeholder={t('data.where')} className="h-7 font-mono text-xs" />
            <Button size="sm" type="submit">
              {t('data.applyFilter')}
            </Button>
            {appliedWhere && (
              <IconButton
                label={t('data.clearFilter')}
                onClick={() => {
                  setWhere('')
                  setAppliedWhere('')
                }}
              >
                <X size={14} />
              </IconButton>
            )}
          </form>
          <div className="mx-1 h-5 w-px bg-border" />
        </>
      }
      toolbarEnd={
        <IconButton label={t('common.refresh')} onClick={() => void load()}>
          {loading ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      }
      footer={(selected) => (
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-muted">
          <span>{total !== null ? t('data.total', { shown: result.rowCount.toLocaleString(), total: total.toLocaleString() }) : t('status.rows', { count: result.rowCount })}</span>
          {total !== null && result.rowCount < total && (
            <>
              <Tooltip content={t('data.loadMore')}>
                <Button size="sm" variant="ghost" icon={<ChevronsDown size={13} />} onClick={() => void load({ append: true })} disabled={loading}>
                  {t('data.loadMore')}
                </Button>
              </Tooltip>
              <Button size="sm" variant="ghost" onClick={() => void load({ all: true })} disabled={loading}>
                {t('data.loadAll')}
              </Button>
            </>
          )}
          {selected > 0 && <span>{t('status.selected', { count: selected })}</span>}
        </div>
      )}
    />
  )
}
