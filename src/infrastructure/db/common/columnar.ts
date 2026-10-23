import type { CellValue, ColumnMeta, MaterializedResult } from '@shared/model'
import type { ResultSink } from '@domain/ports/database'

/** Converts driver values into structured-clone friendly cell values. */
export function normalizeValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return v
    case 'object':
      if (v instanceof Uint8Array) {
        // Buffer → plain Uint8Array view (structured clone of Buffer loses its prototype anyway)
        return Buffer.isBuffer(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v
      }
      if (v instanceof Date) return formatDate(v)
      return JSON.stringify(v)
    default:
      return String(v)
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Local wall-clock timestamp "YYYY-MM-DD HH:MM:SS[.mmm]" (drivers build Dates in local time). */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return String(d)
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const ms = d.getMilliseconds()
  return ms ? `${base}.${pad(ms, 3)}` : base
}

/**
 * Accumulates row-major rows into columnar chunks and flushes them to a sink.
 * Keeps per-row work to a tight loop with no intermediate allocations.
 */
export class ColumnarBuffer {
  private cols: CellValue[][]
  private count = 0
  total = 0

  constructor(
    private readonly width: number,
    private readonly chunkSize: number,
    private readonly sink: ResultSink
  ) {
    this.cols = ColumnarBuffer.empty(width)
  }

  private static empty(width: number): CellValue[][] {
    const cols = new Array<CellValue[]>(width)
    for (let c = 0; c < width; c++) cols[c] = []
    return cols
  }

  pushRow(row: ArrayLike<unknown>): void {
    const cols = this.cols
    for (let c = 0; c < this.width; c++) cols[c].push(normalizeValue(row[c]))
    this.count++
    this.total++
    if (this.count >= this.chunkSize) this.flush()
  }

  flush(): void {
    if (this.count === 0) return
    this.sink.rows(this.cols, this.count)
    this.cols = ColumnarBuffer.empty(this.width)
    this.count = 0
  }
}

/** Sink that materializes a result in memory (used for small/internal queries). */
export class MaterializingSink implements ResultSink {
  columns: ColumnMeta[] = []
  readonly data: CellValue[][] = []
  truncated = false

  start(columns: ColumnMeta[]): void {
    this.columns = columns
  }

  rows(columns: CellValue[][], rowCount: number): void {
    const width = columns.length
    for (let r = 0; r < rowCount; r++) {
      const row = new Array<CellValue>(width)
      for (let c = 0; c < width; c++) row[c] = columns[c][r]
      this.data.push(row)
    }
  }

  end(info: { rowCount: number; truncated: boolean }): void {
    this.truncated = info.truncated
  }

  toResult(durationMs: number, affectedRows?: number): MaterializedResult {
    return { columns: this.columns, rows: this.data, durationMs, truncated: this.truncated, affectedRows }
  }
}

/** A statement parameter as the Node drivers take it: they recognize binary data only as a Buffer. */
export function driverValue(v: CellValue): unknown {
  return v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v
}
