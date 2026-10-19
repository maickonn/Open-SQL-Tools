import type { CellValue, ColumnMeta } from '@shared/model'
import { toHex } from '@shared/bytes'
import type { ResultSet } from './resultSet'

export type CopyFormat = 'tsv' | 'csv' | 'sql' | 'markdown' | 'json'

const text = (v: CellValue): string => (v === null ? '' : v instanceof Uint8Array ? `0x${toHex(v)}` : String(v))

function sqlLiteral(v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Uint8Array) return `X'${toHex(v)}'`
  return `'${v.replace(/'/g, "''")}'`
}

/** Serializes rows (by index) of a result set into a clipboard format. */
export function serializeRows(rs: ResultSet, rows: number[], format: CopyFormat, tableName = 'table_name'): string {
  const cols: ColumnMeta[] = rs.columns
  const data = rows.map((r) => cols.map((_, c) => rs.get(c, r)))
  switch (format) {
    case 'tsv':
      return [cols.map((c) => c.name).join('\t'), ...data.map((r) => r.map((v) => text(v).replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n')
    case 'csv': {
      const q = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
      return [cols.map((c) => q(c.name)).join(','), ...data.map((r) => r.map((v) => q(text(v))).join(','))].join('\r\n')
    }
    case 'markdown':
      return [
        `| ${cols.map((c) => c.name).join(' | ')} |`,
        `|${cols.map(() => ' --- ').join('|')}|`,
        ...data.map((r) => `| ${r.map((v) => (v === null ? 'NULL' : text(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '))).join(' | ')} |`)
      ].join('\n')
    case 'json':
      return JSON.stringify(
        data.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, typeof r[i] === 'bigint' ? String(r[i]) : r[i] instanceof Uint8Array ? text(r[i]) : r[i]]))),
        null,
        2
      )
    case 'sql':
      return data.map((r) => `INSERT INTO ${tableName} (${cols.map((c) => c.name).join(', ')}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n')
  }
}
