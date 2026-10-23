import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Check, Download, Pencil, Plus, Trash2, Undo2, Upload } from 'lucide-react'
import type { CellValue, DbObjectRef, LobKind, RowChange, TableStructure } from '@shared/model'
import { LOB_CUT_MARK, lobColumnKind } from '@domain/lob'
import { binaryText, blobLabel, detectFileType, singleByteCharset } from '@domain/fileType'
import type { SessionState } from '../../stores/workspaceStore'
import { ResultGrid, selectedRows, type GridOverlay, type RowStatus } from '../../components/grid/ResultGrid'
import { GridContextMenu, type GridMenuState } from '../workspace/GridContextMenu'
import { ResultSet } from '../../lib/resultSet'
import { Badge, Button, Dialog, IconButton, Spinner } from '../../components/ui'
import { notify } from '../../stores/toast'
import { ValueEditorDialog } from './ValueEditorDialog'
import { exportValueFile, importValueFile } from '../../lib/valueFiles'

/** Pending grid edits, by result row and column. */
export interface Edits {
  updates: Map<number, Map<number, CellValue>>
  inserts: Map<number, CellValue>[]
  deletes: Set<number>
}

export const emptyEdits = (): Edits => ({ updates: new Map(), inserts: [], deletes: new Set() })

/** Columns identifying a row: the primary key, else a unique key over NOT NULL columns. */
export function tableKey(structure: TableStructure | null): string[] | null {
  if (!structure) return null
  const pk = structure.indexes.find((i) => i.type === 'PRIMARY')
  if (pk?.columns.length) return pk.columns
  const notNull = new Set(structure.columns.filter((c) => !c.nullable).map((c) => c.name))
  const uq = structure.indexes.find((i) => i.type === 'UNIQUE' && i.columns.length && i.columns.every((c) => notNull.has(c)))
  return uq?.columns ?? null
}

/**
 * A result grid whose rows map to a table: inline edits, inserts and deletes posted as SQL, the
 * value editor, and large objects loaded on demand (previews from the Data tab) with file import
 * and export. Used by the Data tab and by query results that come from a single table.
 */
export function EditableGrid({
  session,
  refObj,
  structure,
  result,
  columnNames,
  editable,
  lazyCols,
  revision: outerRevision = 0,
  sort,
  onSort,
  toolbarStart,
  toolbarEnd,
  footer,
  onApplied
}: {
  session: SessionState
  /** Table the rows belong to. */
  refObj: DbObjectRef
  structure: TableStructure | null
  result: ResultSet
  /** Table column of each result column; null keeps it read-only (expressions). Default: the result names. */
  columnNames?: (string | null)[]
  editable: boolean
  /** LOB columns (by index) holding previews or sizes instead of values. */
  lazyCols?: Map<number, LobKind>
  /** Bumped by the owner when rows were appended to the result. */
  revision?: number
  sort?: { column: string; desc: boolean }[]
  onSort?(column: string): void
  toolbarStart?: ReactNode
  toolbarEnd?: ReactNode
  footer?(selection: number): ReactNode
  /** Called once the edits were posted: reload or patch the result. */
  onApplied(edits: Edits): Promise<void> | void
}) {
  const { t } = useTranslation()
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [ownRevision, setRevision] = useState(0)
  const revision = outerRevision + ownRevision
  const [menu, setMenu] = useState<GridMenuState | null>(null)
  const [valueEdit, setValueEdit] = useState<{ row: number; col: number } | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [posting, setPosting] = useState(false)
  const previews = lazyCols ?? new Map<number, LobKind>()

  /** Full LOB values fetched so far, by `row:col`; a new result starts over. */
  const fetched = useRef(new Map<string, CellValue>())
  const fetchedFor = useRef(result)
  if (fetchedFor.current !== result) {
    fetchedFor.current = result
    fetched.current = new Map()
  }
  useEffect(() => setEdits(emptyEdits()), [result])

  const names = useMemo(() => columnNames ?? result.columns.map((c) => c.name), [columnNames, result])
  const nameOf = (col: number): string | null => names[col] ?? null
  const keyColumns = useMemo(() => tableKey(structure), [structure])

  /** Every LOB column of the result (by index): binary content shows as a label, files go in and out. */
  const lobCols = useMemo(() => {
    const map = new Map<number, { kind: LobKind; charset?: string; blob: boolean }>()
    for (const c of structure?.columns ?? []) {
      const kind = lobColumnKind(session.info.engine, c)
      const index = kind ? names.indexOf(c.name) : -1
      // BLOB columns (text sub-types too) show their content type; long TEXT columns show text.
      if (kind && index >= 0) map.set(index, { kind, charset: c.charset, blob: /BLOB|BYTEA/i.test(c.dataType) })
    }
    return map
  }, [structure, names, session.info.engine])

  const baseRows = result.rowCount

  /** Value as loaded (or fetched), without pending edits. */
  const baseValue = (row: number, col: number): CellValue => {
    const key = `${row}:${col}`
    return fetched.current.has(key) ? fetched.current.get(key)! : result.get(col, row)
  }

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
      readOnlyColumn: (col) => nameOf(col) === null,
      placeholder: (row, col) => {
        const lob = lobCols.get(col)
        if (!lob) return undefined
        const edited = row >= baseRows ? edits.inserts[row - baseRows]?.get(col) : edits.updates.get(row)?.get(col)
        const key = `${row}:${col}`
        const preview = edited === undefined && row < baseRows && !fetched.current.has(key) ? previews.get(col) : undefined
        const v = edited !== undefined ? edited : row < baseRows ? baseValue(row, col) : null
        if (v === null) return undefined
        // An unloaded binary LOB arrives as its size.
        if (preview === 'binary') return blobLabel(undefined)
        if (v instanceof Uint8Array) return blobLabel(detectFileType(v)?.label)
        if (typeof v !== 'string') return undefined
        const cut = preview === 'text' && v.endsWith(LOB_CUT_MARK)
        const text = cut ? v.slice(0, -LOB_CUT_MARK.length) : v
        const binary = binaryText(text, lob.charset)
        // In a BLOB column anything that isn't a known file is just a (BLOB).
        if (binary || lob.blob) return blobLabel(binary?.type?.label)
        return cut ? `${text}…` : undefined
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, baseRows, revision, previews, lobCols, result, names]
  )

  const valueAt = (row: number, col: number): CellValue => {
    const o = overlay.value(row, col)
    return o !== undefined ? o : row < baseRows ? result.get(col, row) : null
  }

  const keyFor = (row: number): Record<string, CellValue> => {
    const key: Record<string, CellValue> = {}
    if (keyColumns) {
      for (const k of keyColumns) {
        const idx = names.indexOf(k)
        if (idx >= 0) key[k] = result.get(idx, row)
      }
      return key
    }
    names.forEach((n, i) => {
      if (n !== null) key[n] = result.get(i, row)
    })
    return key
  }

  /**
   * LOB cells whose value must still be fetched: previews and sizes, and files kept in single-byte
   * text columns, which the server sent transliterated (the bytes the charset lacks became 0x00).
   */
  const needsFetch = (row: number, col: number): boolean => {
    const lob = lobCols.get(col)
    if (!lob || row >= baseRows || fetched.current.has(`${row}:${col}`) || edits.updates.get(row)?.has(col)) return false
    const v = result.get(col, row)
    if (v === null) return false
    const kind = previews.get(col)
    if (kind === 'binary' || (kind === 'text' && typeof v === 'string' && v.endsWith(LOB_CUT_MARK))) return true
    return lob.kind === 'text' && !!singleByteCharset(lob.charset) && typeof v === 'string' && !!binaryText(v, lob.charset)
  }

  /** Fetches the LOB values of these rows (all LOB columns, or `only`) still shown as previews. */
  const fetchLobs = async (rows: number[], only?: number): Promise<void> => {
    let changed = false
    for (const row of rows) {
      const cols = [...lobCols.keys()].filter((c) => (only === undefined || c === only) && needsFetch(row, c))
      if (!cols.length) continue
      // Files kept in single-byte text columns are read as stored bytes: the text the server sends
      // has lost the bytes the charset lacks.
      const asBytes = (c: number): boolean => {
        const lob = lobCols.get(c)
        const preview = result.get(c, row)
        return lob?.kind === 'text' && !!singleByteCharset(lob.charset) && typeof preview === 'string' && !!binaryText(preview, lob.charset)
      }
      const key = keyFor(row)
      const textCols = cols.filter((c) => !asBytes(c))
      if (textCols.length) {
        const values = await session.client.call('fetchCellValues', { ref: refObj, key, columns: textCols.map((c) => nameOf(c)!) })
        textCols.forEach((c, i) => fetched.current.set(`${row}:${c}`, values[i]))
      }
      for (const c of cols.filter(asBytes)) {
        fetched.current.set(`${row}:${c}`, await session.client.call('fetchCellBytes', { ref: refObj, key, column: nameOf(c)! }))
      }
      changed = true
    }
    if (changed) setRevision((r) => r + 1)
  }

  /** Cell whose editor is opening: a double click activates the cell twice. */
  const opening = useRef<string | null>(null)
  /** Column whose large values are being fetched, shown in a loading dialog. */
  const [loadingLob, setLoadingLob] = useState<string | null>(null)
  /** Bumped by the loading dialog's Cancel: a fetch that finishes afterwards is dropped. */
  const loadRun = useRef(0)

  /** Fetches LOB values with the loading dialog up; false when the user cancelled. */
  const loadLobs = async (rows: number[], col?: number): Promise<boolean> => {
    const run = ++loadRun.current
    const cols = col === undefined ? [...lobCols.keys()] : [col]
    if (rows.some((r) => cols.some((c) => needsFetch(r, c)))) setLoadingLob(result.columns[cols[0]]?.name ?? '')
    try {
      await fetchLobs(rows, col)
    } finally {
      if (run === loadRun.current) setLoadingLob(null)
    }
    return run === loadRun.current
  }

  const openValueEditor = async (row: number, col: number): Promise<void> => {
    const key = `${row}:${col}`
    if (opening.current === key) return
    opening.current = key
    try {
      if (await loadLobs([row], col)) setValueEdit({ row, col })
    } catch (err) {
      notify.error(err)
    } finally {
      opening.current = null
    }
  }

  /** Rows with every LOB loaded, for copying. */
  const resolveRows = async (rows: number[]): Promise<ResultSet> => {
    if (!(await loadLobs(rows.filter((r) => r < baseRows)))) throw new Error(t('data.loadCancelled'))
    return ResultSet.fromRows(
      result.columns,
      rows.map((r) => result.columns.map((_, c) => (r < baseRows ? baseValue(r, c) : valueAt(r, c))))
    )
  }

  const pending = edits.updates.size + edits.inserts.length + edits.deletes.size

  const setCell = (row: number, col: number, value: CellValue): void => {
    if (nameOf(col) === null) return
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

  const columnValues = (cols: Map<number, CellValue>): Record<string, CellValue> => {
    const values: Record<string, CellValue> = {}
    for (const [c, v] of cols) {
      const n = nameOf(c)
      if (n !== null) values[n] = v
    }
    return values
  }

  const apply = async (): Promise<void> => {
    const changes: RowChange[] = []
    for (const row of edits.deletes) changes.push({ kind: 'delete', key: keyFor(row) })
    for (const [row, cols] of edits.updates) {
      if (edits.deletes.has(row)) continue
      changes.push({ kind: 'update', key: keyFor(row), values: columnValues(cols) })
    }
    for (const ins of edits.inserts) changes.push({ kind: 'insert', values: columnValues(ins) })
    if (!changes.length) return
    setPosting(true)
    try {
      await session.client.call('applyRowChanges', { ref: refObj, changes })
      const posted = edits
      await onApplied(posted)
      setEdits(emptyEdits())
    } catch (err) {
      notify.error(err)
    } finally {
      setPosting(false)
    }
  }

  const charsetOf = (col: number): string | undefined => structure?.columns.find((c) => c.name === nameOf(col))?.charset
  /** Imported files keep their bytes in binary columns and in text LOBs of single-byte charsets. */
  const storesBytes = (col: number): boolean =>
    result.columns[col]?.category === 'binary' || (lobCols.get(col)?.kind === 'text' && !!singleByteCharset(lobCols.get(col)?.charset))

  const importInto = async (row: number, col: number): Promise<void> => {
    try {
      const value = await importValueFile(storesBytes(col))
      if (value !== undefined) setCell(row, col, value)
    } catch (err) {
      notify.error(err)
    }
  }

  const exportFrom = async (row: number, col: number): Promise<void> => {
    try {
      if (await loadLobs([row], col)) await exportValueFile(result.columns[col].name, valueAt(row, col), charsetOf(col))
    } catch (err) {
      notify.error(err)
    }
  }

  const cellEditable = (col: number): boolean => editable && nameOf(col) !== null
  // Large objects: files go in and out through Import/Export instead of the clipboard.
  const lobMenu = menu && lobCols.has(menu.col)
  const fileMenu = lobMenu
    ? [
        ...(cellEditable(menu.col) ? [{ label: t('data.importValue'), icon: <Upload size={14} />, onSelect: () => void importInto(menu.row, menu.col) }] : []),
        ...(valueAt(menu.row, menu.col) !== null || overlay.placeholder?.(menu.row, menu.col) !== undefined
          ? [{ label: t('data.exportValue'), icon: <Download size={14} />, onSelect: () => void exportFrom(menu.row, menu.col) }]
          : [])
      ]
    : []
  const extraMenu =
    editable && menu
      ? [
          ...(cellEditable(menu.col)
            ? [
                { label: t('data.editCell'), icon: <Pencil size={14} />, onSelect: () => void openValueEditor(menu.row, menu.col) },
                ...fileMenu,
                { label: t('data.setNull'), icon: <Ban size={14} />, onSelect: () => setCell(menu.row, menu.col, null) }
              ]
            : fileMenu),
          { label: t('data.insertRow'), icon: <Plus size={14} />, onSelect: insertRow },
          { label: t('data.deleteRows'), icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteRows(selectedRows(menu.selection).length ? selectedRows(menu.selection) : [menu.row]) }
        ]
      : fileMenu

  const cancelLoading = (): void => {
    loadRun.current++
    setLoadingLob(null)
  }

  const showToolbar = editable || toolbarStart || toolbarEnd
  return (
    <div className="flex h-full flex-col">
      {showToolbar && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
          {toolbarStart}
          {editable && (
            <>
              <IconButton label={t('data.insertRow')} onClick={insertRow}>
                <Plus size={15} />
              </IconButton>
              <IconButton label={t('data.deleteRows')} disabled={!selection.length} onClick={() => deleteRows(selection)}>
                <Trash2 size={15} />
              </IconButton>
              <IconButton label={t('data.applyChanges')} disabled={!pending || posting} onClick={() => void apply()}>
                {posting ? <Spinner /> : <Check size={15} className={pending ? 'text-success' : ''} />}
              </IconButton>
              <IconButton label={t('data.discardChanges')} disabled={!pending} onClick={() => setEdits(emptyEdits())}>
                <Undo2 size={15} />
              </IconButton>
              {pending > 0 && <Badge tone="warning">{t('data.pending', { count: pending })}</Badge>}
            </>
          )}
          {toolbarEnd}
        </div>
      )}
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
          onSort={onSort ? (c) => onSort(c.name) : undefined}
          onEdit={(row, col, v) => setCell(row, col, v)}
          onEditRequest={(row, col) => (cellEditable(col) || lobCols.has(col)) && void openValueEditor(row, col)}
          onSelectionChange={(s) => setSelection(selectedRows(s))}
          onContextMenu={(e) => setMenu(e)}
        />
      </div>
      {footer?.(selection.length)}
      <GridContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        result={result}
        resolveRows={lobCols.size ? resolveRows : undefined}
        copy={!lobMenu}
        sessionId={session.id}
        extra={extraMenu}
        tableName={refObj.name}
      />
      {loadingLob !== null && (
        <Dialog
          open
          onOpenChange={(o) => !o && cancelLoading()}
          title={`${t('data.blobEditor')} — ${loadingLob}`}
          width={360}
          footer={<Button onClick={cancelLoading}>{t('common.cancel')}</Button>}
        >
          <div className="flex items-center gap-3 px-4 py-6 text-sm text-muted">
            <Spinner size={18} />
            {t('data.loadingValue')}
          </div>
        </Dialog>
      )}
      {valueEdit && (
        <ValueEditorDialog
          column={result.columns[valueEdit.col]?.name ?? ''}
          value={valueAt(valueEdit.row, valueEdit.col)}
          charset={charsetOf(valueEdit.col)}
          storesBytes={storesBytes(valueEdit.col)}
          blob={!!lobCols.get(valueEdit.col)?.blob || result.columns[valueEdit.col]?.category === 'binary'}
          readOnly={!cellEditable(valueEdit.col)}
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
