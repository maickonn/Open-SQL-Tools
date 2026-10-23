import type { CellValue, ColumnMeta } from '@shared/model'

type Listener = () => void

/**
 * Result rows stored as the columnar chunks they arrive in (columns[c][r]).
 * Never copied into React state: views subscribe and read cells on demand,
 * and notifications are coalesced to one per animation frame.
 */
export class ResultSet {
  columns: ColumnMeta[] = []
  private chunks: CellValue[][][] = []
  private starts: number[] = []
  private lastChunk = 0
  rowCount = 0
  done = false
  truncated = false
  durationMs = 0
  statementIndex = 0
  sql = ''
  version = 0
  private listeners = new Set<Listener>()
  private scheduled = false

  constructor(columns: ColumnMeta[] = []) {
    this.columns = columns
  }

  static fromRows(columns: ColumnMeta[], rows: CellValue[][]): ResultSet {
    const rs = new ResultSet(columns)
    const cols: CellValue[][] = columns.map((_, c) => rows.map((r) => r[c]))
    if (rows.length) rs.append(cols, rows.length)
    rs.finish(false, 0)
    return rs
  }

  append(columns: CellValue[][], count: number): void {
    if (count === 0) return
    this.chunks.push(columns)
    this.starts.push(this.rowCount)
    this.rowCount += count
    this.notify()
  }

  finish(truncated: boolean, durationMs: number): void {
    this.done = true
    this.truncated = truncated
    this.durationMs = durationMs
    this.notify()
  }

  /** O(1) for sequential access, O(log n) otherwise. */
  get(col: number, row: number): CellValue {
    let i = this.lastChunk
    const starts = this.starts
    if (!(i < starts.length && row >= starts[i] && (i + 1 >= starts.length || row < starts[i + 1]))) {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= row) lo = mid
        else hi = mid - 1
      }
      i = lo
      this.lastChunk = i
    }
    const chunk = this.chunks[i]
    return chunk ? (chunk[col]?.[row - starts[i]] ?? null) : null
  }

  /** Appends every chunk of another (finished) result with the same columns. */
  mergeFrom(other: ResultSet): void {
    for (let i = 0; i < other.chunks.length; i++) {
      const next = other.starts[i + 1] ?? other.rowCount
      this.append(other.chunks[i], next - other.starts[i])
    }
    this.truncated = other.truncated
  }

  /** A copy with posted grid edits applied: deleted rows dropped, updated cells set, inserted rows appended. */
  withEdits(edits: { updates: Map<number, Map<number, CellValue>>; inserts: Map<number, CellValue>[]; deletes: Set<number> }): ResultSet {
    const rows: CellValue[][] = []
    for (let r = 0; r < this.rowCount; r++) {
      if (edits.deletes.has(r)) continue
      const row = this.row(r)
      for (const [c, v] of edits.updates.get(r) ?? []) row[c] = v
      rows.push(row)
    }
    for (const ins of edits.inserts) rows.push(this.columns.map((_, c) => (ins.has(c) ? ins.get(c)! : null)))
    const rs = ResultSet.fromRows(this.columns, rows)
    rs.sql = this.sql
    rs.statementIndex = this.statementIndex
    rs.durationMs = this.durationMs
    rs.truncated = this.truncated
    return rs
  }

  row(r: number): CellValue[] {
    return this.columns.map((_, c) => this.get(c, r))
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private notify(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.version++
      for (const l of this.listeners) l()
    })
  }
}
