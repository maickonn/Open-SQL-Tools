import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import type { CellValue, ColumnMeta } from '@shared/model'
import type { ResultSet } from '../../lib/resultSet'
import { displayValue } from '../../lib/format'
import { useSettings } from '../../stores/settingsStore'
import { useGridTheme } from './useGridTheme'

export type RowStatus = 'inserted' | 'deleted' | 'modified' | undefined

export interface GridOverlay {
  /** Total rows including appended (inserted) rows. */
  rowCount: number
  /** Value override for edited/inserted cells; undefined = no override. */
  value(row: number, col: number): CellValue | undefined
  status(row: number): RowStatus
  cellEdited(row: number, col: number): boolean
  /** Columns that can't be edited (expressions in a query result). */
  readOnlyColumn?(col: number): boolean
  /** Text shown instead of the value (unloaded or binary large objects); such cells open the value editor. */
  placeholder?(row: number, col: number): string | undefined
}

export interface ResultGridProps {
  result: ResultSet
  overlay?: GridOverlay
  editable?: boolean
  sort?: { column: string; desc: boolean }[]
  onSort?(column: ColumnMeta): void
  onEdit?(row: number, col: number, value: CellValue): void
  onContextMenu?(info: { row: number; col: number; x: number; y: number; selection: GridSelection }): void
  onSelectionChange?(selection: GridSelection): void
  onEditRequest?(row: number, col: number): void
  /** Bumped by the parent to force a repaint (e.g. after edits). */
  revision?: number
}

const NUMERIC = new Set(['integer', 'decimal', 'float'])

function initialWidth(c: ColumnMeta): number {
  const base = Math.max(c.name.length * 8 + 36, 70)
  switch (c.category) {
    case 'integer':
    case 'boolean':
      return Math.min(Math.max(base, 80), 160)
    case 'datetime':
      return Math.max(base, 160)
    case 'text':
    case 'json':
      return Math.max(base, 240)
    default:
      return Math.min(Math.max(base, 120), 320)
  }
}

export function ResultGrid({ result, overlay, editable, sort, onSort, onEdit, onContextMenu, onSelectionChange, onEditRequest, revision }: ResultGridProps) {
  const settings = useSettings((s) => s.settings)
  const { theme, colors } = useGridTheme(settings.gridFontSize)
  const ref = useRef<DataEditorRef>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const version = useSyncExternalStore(
    useCallback((cb) => result.subscribe(cb), [result]),
    () => result.version
  )
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })

  useEffect(() => {
    setWidths({})
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
  }, [result])

  const columns: GridColumn[] = useMemo(
    () =>
      result.columns.map((c, i) => {
        const s = sort?.find((x) => x.column === c.name)
        return {
          id: `${i}`,
          title: c.name + (s ? (s.desc ? ' ↓' : ' ↑') : ''),
          width: widths[`${i}`] ?? initialWidth(c),
          hasMenu: false,
          themeOverride: undefined
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, result.columns, widths, sort]
  )

  const rows = overlay?.rowCount ?? result.rowCount

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const meta = result.columns[col]
      const override = overlay?.value(row, col)
      const placeholder = overlay?.placeholder?.(row, col)
      const v = override !== undefined ? override : row < result.rowCount ? result.get(col, row) : null
      const isNull = v === null
      const status = overlay?.status(row)
      if (placeholder !== undefined) {
        return {
          kind: GridCellKind.Text,
          data: placeholder,
          displayData: placeholder,
          allowOverlay: false,
          readonly: true,
          themeOverride:
            status === 'deleted'
              ? { textDark: colors.danger, bgCell: colors.dangerSoft }
              : overlay?.cellEdited(row, col) || status === 'inserted'
                ? { textDark: colors.null, bgCell: colors.editedBg }
                : { textDark: colors.null }
        }
      }
      const edited = overlay?.cellEdited(row, col)
      const text = isNull ? settings.nullText : displayValue(v, settings.nullText)
      const themeOverride: Partial<Theme> | undefined = isNull
        ? { textDark: colors.null, baseFontStyle: `italic ${settings.gridFontSize}px` }
        : status === 'deleted'
          ? { textDark: colors.danger, bgCell: colors.dangerSoft }
          : edited || status === 'inserted'
            ? { bgCell: colors.editedBg }
            : NUMERIC.has(meta?.category ?? '')
              ? { textDark: colors.number }
              : meta?.category === 'datetime'
                ? { textDark: colors.date }
                : undefined
      return {
        kind: GridCellKind.Text,
        data: isNull ? '' : typeof v === 'string' ? v : text,
        displayData: text,
        allowOverlay: !!editable && !(v instanceof Uint8Array) && status !== 'deleted' && !overlay?.readOnlyColumn?.(col),
        readonly: !editable || !!overlay?.readOnlyColumn?.(col),
        contentAlign: NUMERIC.has(meta?.category ?? '') ? 'right' : undefined,
        themeOverride
      }
    },
    // version/revision force a fresh callback so the canvas repaints with new rows/edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, overlay, editable, settings.nullText, settings.gridFontSize, colors, version, revision]
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, value: EditableGridCell) => {
      if (value.kind === GridCellKind.Text) onEdit?.(row, col, value.data)
    },
    [onEdit]
  )

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" data-testid="result-grid">
      <DataEditor
        ref={ref}
        theme={theme}
        columns={columns}
        rows={rows}
        getCellContent={getCellContent}
        getCellsForSelection
        rowMarkers={{ kind: 'number', width: Math.max(44, String(rows).length * 8 + 18) }}
        smoothScrollX
        smoothScrollY
        width="100%"
        height="100%"
        rowHeight={Math.round(settings.gridFontSize * 1.9)}
        headerHeight={30}
        overscrollX={40}
        gridSelection={selection}
        onGridSelectionChange={(s) => {
          setSelection(s)
          onSelectionChange?.(s)
        }}
        onColumnResize={(col, w) => setWidths((p) => ({ ...p, [col.id as string]: w }))}
        onHeaderClicked={(i) => onSort?.(result.columns[i])}
        onCellEdited={editable ? onCellEdited : undefined}
        onCellActivated={([col, row]) => {
          const override = overlay?.value(row, col)
          if (overlay?.placeholder?.(row, col) !== undefined) return onEditRequest?.(row, col)
          const v = override !== undefined ? override : result.columns[col] && row < result.rowCount ? result.get(col, row) : null
          if (v instanceof Uint8Array || (typeof v === 'string' && v.length > 200)) onEditRequest?.(row, col)
        }}
        onCellContextMenu={([col, row], e) => {
          e.preventDefault()
          const bounds = e.bounds as Rectangle
          let sel = selection
          if (!selection.current || !rangeContains(selection.current.range, col, row)) {
            sel = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } }
            setSelection(sel)
          }
          onContextMenu?.({ row, col, x: bounds.x + e.localEventX, y: bounds.y + e.localEventY, selection: sel })
        }}
        keybindings={{ search: true, selectAll: true, copy: true, paste: !!editable, downFill: false, rightFill: false }}
        experimental={{ strict: true }}
      />
    </div>
  )
}

function rangeContains(r: Rectangle, col: number, row: number): boolean {
  return col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height
}

/** Row indexes covered by a grid selection (rows, or the current range). */
export function selectedRows(sel: GridSelection): number[] {
  const out = new Set<number>()
  for (const r of sel.rows) out.add(r)
  if (sel.current) {
    const { y, height } = sel.current.range
    for (let r = y; r < y + height; r++) out.add(r)
    for (const extra of sel.current.rangeStack) for (let r = extra.y; r < extra.y + extra.height; r++) out.add(r)
  }
  return [...out].sort((a, b) => a - b)
}
