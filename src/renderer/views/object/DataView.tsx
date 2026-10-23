import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsDown, Filter, Plus, RefreshCw, Trash2, Undo2, X, Ban, Pencil } from 'lucide-react'
import type { CellValue, DbObjectRef, LobKind, RowChange, TableDataRequest, TableStructure } from '@shared/model'
import { LOB_CUT_MARK, lobKind } from '@domain/lob'
import type { SessionState } from '../../stores/workspaceStore'
import { useSettings } from '../../stores/settingsStore'
import { ResultGrid, selectedRows, type GridOverlay, type RowStatus } from '../../components/grid/ResultGrid'
import { GridContextMenu, type GridMenuState } from '../workspace/GridContextMenu'
import { ResultSet } from '../../lib/resultSet'
import { runScript } from '../../stores/queryStore'
import { Badge, Button, IconButton, Input, Spinner, Tooltip } from '../../components/ui'
import { notify } from '../../stores/toast'
import { exportSources } from '../commands'
import { ValueEditorDialog } from './ValueEditorDialog'
import { formatBytes } from '../../lib/format'

interface Edits {
  updates: Map<number, Map<number, CellValue>>
  inserts: Map<number, CellValue>[]
  deletes: Set<number>
}

const emptyEdits = (): Edits => ({ updates: new Map(), inserts: [], deletes: new Set() })

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
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState<GridMenuState | null>(null)
  const [valueEdit, setValueEdit] = useState<{ row: number; col: number } | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const loaded = useRef(false)
  /** Filter + sort of the last full load; a reload happens only when they change. */
  const loadedKey = useRef<string | null>(null)
  const editable = refObj.kind === 'table'

  const keyColumns = useMemo(() => {
    if (!structure) return null
    const pk = structure.indexes.find((i) => i.type === 'PRIMARY')
    if (pk?.columns.length) return pk.columns
    const notNull = new Set(structure.columns.filter((c) => !c.nullable).map((c) => c.name))
    const uq = structure.indexes.find((i) => i.type === 'UNIQUE' && i.columns.length && i.columns.every((c) => notNull.has(c)))
    return uq?.columns ?? null
  }, [structure])

  // Large objects load on demand, located by key: without one the grid reads them eagerly.
  const lazy = useMemo(() => {
    if (!structure || !keyColumns) return []
    return structure.columns.flatMap((c) => {
      const kind = lobKind(session.info.engine, c)
      return kind && !keyColumns.includes(c.name) ? [{ column: c.name, kind }] : []
    })
  }, [structure, keyColumns, session.info.engine])
  /** LOB columns of the loaded result (by index) holding previews instead of values. */
  const [lazyCols, setLazyCols] = useState<Map<number, LobKind>>(() => new Map())
  /** Full LOB values fetched so far, by `row:col`. */
  const fetched = useRef(new Map<string, CellValue>())

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
              fetched.current = new Map()
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
          setEdits(emptyEdits())
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

  const baseRows = result.rowCount
  const overlay: GridOverlay = useMemo(
    () => ({
      rowCount: baseRows + edits.inserts.length,
      value: (row, col) => {
        if (row >= baseRows) {
          const ins = edits.inserts[row - baseRows]
          return ins?.has(col) ? ins.get(col)! : null
        }
        const u = edits.updates.get(row)
        return u?.has(col) ? u.get(col)! : fetched.current.get(`${row}:${col}`)
      },
      status: (row): RowStatus => (row >= baseRows ? 'inserted' : edits.deletes.has(row) ? 'deleted' : edits.updates.has(row) ? 'modified' : undefined),
      cellEdited: (row, col) => row < baseRows && !!edits.updates.get(row)?.has(col),
      placeholder: (row, col) => {
        const kind = row < baseRows ? lazyCols.get(col) : undefined
        if (!kind || fetched.current.has(`${row}:${col}`)) return undefined
        const v = result.get(col, row)
        if (v === null) return undefined
        if (kind === 'binary') return t('data.lobBinary', { size: formatBytes(Number(v)) })
        // Uncut previews are the whole value.
        return typeof v === 'string' && v.endsWith(LOB_CUT_MARK) ? `${v.slice(0, -LOB_CUT_MARK.length)}…` : undefined
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, baseRows, revision, lazyCols, result]
  )

  /** Value as loaded (or fetched), without pending edits. */
  const baseValue = (row: number, col: number): CellValue => {
    const key = `${row}:${col}`
    return fetched.current.has(key) ? fetched.current.get(key)! : result.get(col, row)
  }

  /** Fetches the LOB values of these rows (all LOB columns, or `only`) still shown as previews. */
  const fetchLobs = async (rows: number[], only?: number): Promise<void> => {
    let changed = false
    for (const row of rows) {
      const cols = [...lazyCols.keys()].filter((c) => (only === undefined || c === only) && overlay.placeholder!(row, c) !== undefined)
      if (!cols.length) continue
      const values = await session.client.call('fetchCellValues', { ref: refObj, key: keyFor(row), columns: cols.map((c) => result.columns[c].name) })
      cols.forEach((c, i) => fetched.current.set(`${row}:${c}`, values[i]))
      changed = true
    }
    if (changed) setRevision((r) => r + 1)
  }

  const openValueEditor = async (row: number, col: number): Promise<void> => {
    try {
      await fetchLobs([row], col)
      setValueEdit({ row, col })
    } catch (err) {
      notify.error(err)
    }
  }

  /** Rows with every LOB loaded, for copying. */
  const resolveRows = async (rows: number[]): Promise<ResultSet> => {
    await fetchLobs(rows.filter((r) => r < baseRows))
    return ResultSet.fromRows(
      result.columns,
      rows.map((r) => result.columns.map((_, c) => (r < baseRows ? baseValue(r, c) : valueAt(r, c))))
    )
  }

  const pending = edits.updates.size + edits.inserts.length + edits.deletes.size

  const setCell = (row: number, col: number, value: CellValue): void => {
    setEdits((e) => {
      const next: Edits = { updates: new Map(e.updates), inserts: [...e.inserts], deletes: new Set(e.deletes) }
      if (row >= baseRows) {
        const ins = new Map(next.inserts[row - baseRows])
        ins.set(col, value)
        next.inserts[row - baseRows] = ins
      } else {
        const original = baseValue(row, col)
        const m = new Map(next.updates.get(row))
        if (value === original) m.delete(col)
        else m.set(col, value)
        if (m.size) next.updates.set(row, m)
        else next.updates.delete(row)
      }
      return next
    })
  }

  const insertRow = (): void => setEdits((e) => ({ ...e, inserts: [...e.inserts, new Map()] }))

  const deleteRows = (rows: number[]): void => {
    setEdits((e) => {
      const next: Edits = { updates: new Map(e.updates), inserts: [...e.inserts], deletes: new Set(e.deletes) }
      const removeInserted = rows.filter((r) => r >= baseRows).map((r) => r - baseRows)
      next.inserts = next.inserts.filter((_, i) => !removeInserted.includes(i))
      for (const r of rows) if (r < baseRows) next.deletes.add(r)
      return next
    })
  }

  const keyFor = (row: number): Record<string, CellValue> => {
    const names = keyColumns ?? result.columns.map((c) => c.name)
    const key: Record<string, CellValue> = {}
    for (const n of names) {
      const idx = result.columns.findIndex((c) => c.name === n)
      if (idx >= 0) key[n] = result.get(idx, row)
    }
    return key
  }

  const apply = async (): Promise<void> => {
    const changes: RowChange[] = []
    for (const row of edits.deletes) changes.push({ kind: 'delete', key: keyFor(row) })
    for (const [row, cols] of edits.updates) {
      if (edits.deletes.has(row)) continue
      const values: Record<string, CellValue> = {}
      for (const [c, v] of cols) values[result.columns[c].name] = v
      changes.push({ kind: 'update', key: keyFor(row), values })
    }
    for (const ins of edits.inserts) {
      const values: Record<string, CellValue> = {}
      for (const [c, v] of ins) values[result.columns[c].name] = v
      changes.push({ kind: 'insert', values })
    }
    if (!changes.length) return
    setLoading(true)
    try {
      await session.client.call('applyRowChanges', { ref: refObj, changes })
      await load()
    } catch (err) {
      notify.error(err)
      setLoading(false)
    }
  }

  const sortBy = (column: string): void => {
    setSort((s) => {
      const cur = s.find((x) => x.column === column)
      if (!cur) return [{ column, desc: false }]
      if (!cur.desc) return [{ column, desc: true }]
      return []
    })
  }

  const extraMenu = editable && menu
    ? [
        { label: t('data.editCell'), icon: <Pencil size={14} />, onSelect: () => void openValueEditor(menu.row, menu.col) },
        { label: t('data.setNull'), icon: <Ban size={14} />, onSelect: () => setCell(menu.row, menu.col, null) },
        { label: t('data.insertRow'), icon: <Plus size={14} />, onSelect: insertRow },
        { label: t('data.deleteRows'), icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteRows(selectedRows(menu.selection).length ? selectedRows(menu.selection) : [menu.row]) }
      ]
    : []

  const valueAt = (row: number, col: number): CellValue => {
    const o = overlay.value(row, col)
    return o !== undefined ? o : row < baseRows ? result.get(col, row) : null
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
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
        {editable && (
          <>
            <IconButton label={t('data.insertRow')} onClick={insertRow}>
              <Plus size={15} />
            </IconButton>
            <IconButton label={t('data.deleteRows')} disabled={!selection.length} onClick={() => deleteRows(selection)}>
              <Trash2 size={15} />
            </IconButton>
            <IconButton label={t('data.applyChanges')} disabled={!pending} onClick={() => void apply()}>
              <Check size={15} className={pending ? 'text-success' : ''} />
            </IconButton>
            <IconButton label={t('data.discardChanges')} disabled={!pending} onClick={() => setEdits(emptyEdits())}>
              <Undo2 size={15} />
            </IconButton>
            {pending > 0 && <Badge tone="warning">{t('data.pending', { count: pending })}</Badge>}
          </>
        )}
        <IconButton label={t('common.refresh')} onClick={() => void load()}>
          {loading ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      </div>
      {editable && structure && !keyColumns && (
        <div className="shrink-0 border-b border-border bg-warning/10 px-3 py-1 text-[11px] text-warning">{t('data.noKey')}</div>
      )}
      <div className="min-h-0 flex-1">
        <ResultGrid
          result={result}
          overlay={overlay}
          editable={editable}
          revision={revision}
          sort={sort}
          onSort={(c) => sortBy(c.name)}
          onEdit={(row, col, v) => setCell(row, col, v)}
          onEditRequest={(row, col) => editable && void openValueEditor(row, col)}
          onSelectionChange={(s) => setSelection(selectedRows(s))}
          onContextMenu={(e) => setMenu(e)}
        />
      </div>
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
        {selection.length > 0 && <span>{t('status.selected', { count: selection.length })}</span>}
      </div>
      <GridContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        result={result}
        resolveRows={lazyCols.size ? resolveRows : undefined}
        sessionId={session.id}
        extra={extraMenu}
        tableName={refObj.name}
      />
      {valueEdit && (
        <ValueEditorDialog
          column={result.columns[valueEdit.col]?.name ?? ''}
          value={valueAt(valueEdit.row, valueEdit.col)}
          charset={structure?.columns.find((c) => c.name === result.columns[valueEdit.col]?.name)?.charset}
          readOnly={!editable}
          onClose={() => setValueEdit(null)}
          onSave={(v) => {
            setCell(valueEdit.row, valueEdit.col, v)
            setValueEdit(null)
          }}
        />
      )}
    </div>
  )
}
