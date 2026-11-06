import type { CellValue, DbEngine, DbObjectRef } from '@shared/model'
import type { DbConnection, SqlDialect } from '@domain/ports/database'
import type { ScriptWriter } from './scriptWriter'

export interface TableDataSpec {
  /** Table read. */
  ref: DbObjectRef
  /** Name written in the script, when it differs (MySQL: without the database, so restores can target another one). */
  insertRef?: DbObjectRef
  /** Columns written, in order (generated columns excluded, invisible ones included). */
  columns: string[]
  /** Primary or unique key, used to append large values in pieces (Firebird). */
  keyColumns: string[]
  /** PostgreSQL: identity columns GENERATED ALWAYS need OVERRIDING SYSTEM VALUE. */
  overridingSystemValue?: boolean
  /** Expressions read instead of the plain columns, by column name (Firebird: wide rows read as OCTETS). */
  readAs?: Record<string, string>
}

export interface DataWriterOptions {
  engine: DbEngine
  dialect: SqlDialect
  verb: 'INSERT' | 'INSERT IGNORE' | 'REPLACE'
  rowsPerInsert: number
  /** Upper bound of one statement, in bytes (MySQL max_allowed_packet, Firebird statement size). */
  maxStatementBytes: number
  /**
   * Values whose literal is longer than this many characters are inserted as NULL and then appended
   * in pieces by key (Firebird literals are limited to 32 KB).
   */
  maxLiteralChars: number
  /** Firebird: wrap batches of INSERTs in EXECUTE BLOCK (one round trip per batch on restore). */
  executeBlock: boolean
  /** Read the values with transliteration off (Firebird NONE text arrives as bytes). */
  rawText?: boolean
  isCancelled(): boolean
  onRows(rows: number): void
}

export class BackupCancelled extends Error {
  constructor() {
    super('Backup cancelled')
  }
}

/** Firebird EXECUTE BLOCK: rows per block (each INSERT is a context; the limit is about 255). */
const BLOCK_ROWS = 200
/** Piece size for values appended by key: bytes of binary data / characters of text. */
const BINARY_PIECE = 15_000
const TEXT_PIECE = 7_500

export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n++
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Streams a table's rows into the script as INSERT statements. */
export async function writeTableData(conn: DbConnection, out: ScriptWriter, spec: TableDataSpec, o: DataWriterOptions): Promise<{ rows: number; warnings: string[] }> {
  const d = o.dialect
  const source = d.qualify(spec.ref)
  const table = d.qualify(spec.insertRef ?? spec.ref)
  const cols = spec.columns.map((c) => d.quoteIdent(c))
  const colList = cols.join(', ')
  const readList = spec.readAs ? spec.columns.map((c, i) => spec.readAs![c] ?? cols[i]).join(', ') : colList
  const head = `${o.verb} INTO ${table} (${colList})${spec.overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES`
  const warnings: string[] = []
  const fb = o.engine === 'firebird'
  // Firebird has no multi-row VALUES: one INSERT per row, batched in EXECUTE BLOCK.
  const perStatement = fb ? 1 : Math.max(1, o.rowsPerInsert)
  const keyIdx = spec.keyColumns.map((k) => spec.columns.indexOf(k))
  const hasKey = keyIdx.length > 0 && keyIdx.every((i) => i >= 0)
  let warnedNoKey = false

  let rows = 0
  let chain: Promise<void> = Promise.resolve()
  let failure: unknown = null
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((e) => {
      failure ??= e
    })
  }

  // Multi-row INSERT state
  let values: string[] = []
  let valuesBytes = 0
  // Firebird block state
  let block: string[] = []
  let blockBytes = 0
  let appends: string[] = []

  const flushValues = (): void => {
    if (!values.length) return
    const text = `${head}\n${values.join(',\n')}`
    values = []
    valuesBytes = 0
    enqueue(() => out.statement(text))
  }
  const flushBlock = (): void => {
    if (!block.length && !appends.length) return
    const stmts = block
    const ups = appends
    block = []
    blockBytes = 0
    appends = []
    enqueue(async () => {
      if (stmts.length === 1) await out.statement(stmts[0])
      else if (stmts.length) await out.statement(`EXECUTE BLOCK AS BEGIN\n${stmts.map((s) => `${s};`).join('\n')}\nEND`)
      for (const u of ups) await out.statement(u)
    })
  }

  const pieces = (v: CellValue): string[] => {
    if (v instanceof Uint8Array) {
      const out: string[] = []
      for (let at = 0; at < v.length; at += BINARY_PIECE) out.push(d.literal(v.subarray(at, at + BINARY_PIECE)))
      return out
    }
    const s = String(v)
    const out: string[] = []
    for (let at = 0; at < s.length; at += TEXT_PIECE) {
      let end = Math.min(s.length, at + TEXT_PIECE)
      // Never split a surrogate pair.
      if (end < s.length && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff) end--
      out.push(d.literal(s.slice(at, end)))
      at = end - TEXT_PIECE
    }
    return out
  }

  const addRow = (row: CellValue[]): void => {
    const lits = new Array<string>(row.length)
    let big: number[] | null = null
    for (let c = 0; c < row.length; c++) {
      const lit = d.literal(row[c])
      if (lit.length > o.maxLiteralChars && row[c] !== null) {
        if (hasKey) {
          ;(big ??= []).push(c)
          lits[c] = 'NULL'
          continue
        }
        if (!warnedNoKey) {
          warnedNoKey = true
          warnings.push(`${spec.ref.name}: values over ${o.maxLiteralChars} characters need a primary key to be restored in pieces; they may fail to load`)
        }
      }
      lits[c] = lit
    }
    const tuple = `(${lits.join(', ')})`
    if (!fb) {
      const bytes = utf8Length(tuple) + 2
      if (values.length && (values.length >= perStatement || valuesBytes + bytes + head.length > o.maxStatementBytes)) flushValues()
      values.push(tuple)
      valuesBytes += bytes
      if (values.length >= perStatement) flushValues()
      return
    }
    const insert = `${head} ${tuple}`
    const bytes = utf8Length(insert) + 2
    if (block.length && (!o.executeBlock || block.length >= BLOCK_ROWS || blockBytes + bytes + 32 > o.maxStatementBytes)) flushBlock()
    block.push(insert)
    blockBytes += bytes
    if (big) {
      const where = spec.keyColumns.map((k, i) => `${d.quoteIdent(k)} = ${d.literal(row[keyIdx[i]])}`).join(' AND ')
      for (const c of big) {
        const col = cols[c]
        pieces(row[c]).forEach((p, i) => appends.push(`UPDATE ${table} SET ${col} = ${i === 0 ? p : `${col} || ${p}`} WHERE ${where}`))
      }
      // The pieces must follow their row: close the block now.
      flushBlock()
    }
    if (!o.executeBlock) flushBlock()
  }

  if (fb && o.executeBlock) await out.beginBlocks()
  try {
    await conn.run(
      `SELECT ${readList} FROM ${source}`,
      {
        start: () => undefined,
        rows: (columns, n) => {
          if (o.isCancelled()) throw new BackupCancelled()
          if (failure) throw failure
          for (let r = 0; r < n; r++) {
            const row = new Array<CellValue>(columns.length)
            for (let c = 0; c < columns.length; c++) row[c] = columns[c][r]
            addRow(row)
          }
          rows += n
          o.onRows(rows)
        },
        end: () => {
          flushValues()
          flushBlock()
        }
      },
      { maxRows: Number.MAX_SAFE_INTEGER, chunkSize: 2_000, rawText: o.rawText }
    )
    await chain
    if (failure) throw failure
  } finally {
    await chain
    if (fb && o.executeBlock) await out.endBlocks()
  }
  return { rows, warnings }
}
