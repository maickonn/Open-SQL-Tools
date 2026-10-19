import type { CellValue, MaterializedResult } from '@shared/model'

export type QueryFn = (sql: string, maxRows?: number) => Promise<MaterializedResult>

export type Row = Record<string, CellValue>

/** Converts a materialized result into objects keyed by lower-cased column name. */
export function toObjects(result: MaterializedResult): Row[] {
  const names = result.columns.map((c) => c.name.toLowerCase())
  return result.rows.map((r) => {
    const o: Row = {}
    for (let i = 0; i < names.length; i++) o[names[i]] = r[i]
    return o
  })
}

export async function queryObjects(query: QueryFn, sql: string): Promise<Row[]> {
  return toObjects(await query(sql, 1_000_000))
}

export const str = (v: CellValue | undefined): string => (v === null || v === undefined ? '' : v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v).trim())

export const optStr = (v: CellValue | undefined): string | undefined => {
  const s = str(v)
  return s === '' ? undefined : s
}

export const num = (v: CellValue | undefined): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export const bool = (v: CellValue | undefined): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'YES' || v === 'Y'

/** Builds a key/value result from rows of [name, value]. */
export function keyValueResult(pairs: [string, CellValue][], durationMs = 0): MaterializedResult {
  return {
    columns: [
      { name: 'Variable', type: 'VARCHAR', category: 'string' },
      { name: 'Value', type: 'VARCHAR', category: 'string' }
    ],
    rows: pairs.map(([k, v]) => [k, v]),
    durationMs
  }
}

/** Groups rows by a key preserving order. */
export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}
