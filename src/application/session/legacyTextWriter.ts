import type { CellValue, ColumnDef, DbObjectRef, RowChange, RowKey, TableStructure } from '@shared/model'
import type { OpenDatabase } from '@domain/ports/database'
import { legacyLiteralColumns, legacyLiteralTables, rewriteLegacyLiterals, type LiteralEncodings } from '@domain/sql/legacyLiterals'
import {
  EncodingProfiles,
  codecForCharset,
  detectEncoding,
  encodeText,
  isAscii,
  isStrictUtf8,
  type TextEncodingId
} from '@domain/text/legacyText'

/** Values read to learn how a column stores its text. */
const SAMPLE_ROWS = 500
/** Bytes read from each sampled text BLOB. */
const SAMPLE_BYTES = 4000
/** How long a table structure read for one operation is reused. */
const STRUCTURE_TTL_MS = 5_000
/** Other NONE columns of a table sampled when a column has no evidence of its own. */
const SAMPLE_COLUMNS = 5

const nonAscii = (v: unknown): v is string => typeof v === 'string' && /[^\x00-\x7f]/.test(v)

/** A NONE text column: CHAR/VARCHAR or a text BLOB without a charset of its own or from the database. */
export function isNoneText(column: ColumnDef, defaultCharset: string | undefined): boolean {
  const type = column.dataType.toUpperCase()
  const text = type === 'CHAR' || type === 'VARCHAR' || (type === 'BLOB' && /SUB_TYPE\s+(TEXT|1)\b/i.test(column.fullType))
  return text && (column.charset ?? defaultCharset ?? 'NONE').toUpperCase() === 'NONE'
}

/**
 * Writes text to Firebird columns of charset NONE in the encoding the data already uses, so legacy
 * applications keep reading it and keys match the stored bytes. The encoding of a value is, in order:
 * the cell's own stored bytes, the column's evidence, the charsets declared in the table, the
 * database's default charset, the evidence of the whole database, and UTF-8.
 */
export class LegacyTextWriter {
  /** Columns already sampled (`TABLE.COLUMN`), with or without evidence. */
  private readonly sampled = new Set<string>()
  /** Structures read by the current operation: one post asks several times, a later one reads again. */
  private readonly structures = new Map<string, { at: number; structure: Promise<TableStructure> }>()

  constructor(
    private readonly db: OpenDatabase,
    private readonly profiles: EncodingProfiles,
    private readonly readStructure: (ref: DbObjectRef) => Promise<TableStructure>
  ) {}

  private structureOf(ref: DbObjectRef): Promise<TableStructure> {
    const id = JSON.stringify([ref.database, ref.schema, ref.name])
    const cached = this.structures.get(id)
    if (cached && Date.now() - cached.at < STRUCTURE_TTL_MS) return cached.structure
    const structure = this.readStructure(ref)
    this.structures.set(id, { at: Date.now(), structure })
    structure.catch(() => this.structures.delete(id))
    return structure
  }

  private noneColumns(structure: TableStructure): Map<string, ColumnDef> {
    return new Map(structure.columns.filter((c) => isNoneText(c, this.db.info.defaultCharset)).map((c) => [c.name, c]))
  }

  /** Stored bytes of the values a SELECT from selectTextBytes returned. */
  private async bytes(sql: string): Promise<Uint8Array[]> {
    const res = await this.db.metaQuery(sql, SAMPLE_ROWS)
    return res.rows.map((r) => r[0]).filter((v): v is Uint8Array => v instanceof Uint8Array)
  }

  /** Learns how a column stores its text from a sample of its values (once per session). */
  private async sample(ref: DbObjectRef, column: ColumnDef): Promise<void> {
    const key = EncodingProfiles.key(ref.name, column.name)
    if (this.sampled.has(key) || !this.db.dialect.selectTextBytes) return
    this.sampled.add(key)
    const blob = column.dataType.toUpperCase() === 'BLOB'
    for (let b of await this.bytes(this.db.dialect.selectTextBytes(ref, column, { limit: blob ? SAMPLE_BYTES : SAMPLE_ROWS }))) {
      // A BLOB cut at the sample size may end in the middle of a UTF-8 sequence.
      if (blob && b.length >= SAMPLE_BYTES) b = trimPartialUtf8(b)
      this.profiles.learn(b, key)
    }
  }

  /** Encoding new text in this column should use; `key` locates the cell being replaced. */
  async writeEncoding(ref: DbObjectRef, column: ColumnDef, key?: RowKey): Promise<TextEncodingId> {
    const name = EncodingProfiles.key(ref.name, column.name)
    const profile = this.profiles.column(name)
    // 1. The cell itself, when the column mixes encodings or hasn't shown any yet.
    if (key && this.db.dialect.selectTextBytes && (profile.mixed || !profile.evidence)) {
      const [stored] = await this.bytes(this.db.dialect.selectTextBytes(ref, column, { key, limit: SAMPLE_BYTES }))
      if (stored && !isAscii(stored)) {
        this.profiles.learn(stored, name)
        const enc = detectEncoding(column.dataType.toUpperCase() === 'BLOB' ? trimPartialUtf8(stored) : stored, profile)
        if (enc !== 'ascii') return enc
      }
    }
    // 2. The column.
    if (!profile.evidence) await this.sample(ref, column)
    const own = profile.dominant()
    if (own) return own
    const structure = await this.structureOf(ref)
    // 3. Charsets declared in the table ("the table's charset").
    const declared = new Map<TextEncodingId, number>()
    for (const c of structure.columns) {
      const enc = codecForCharset(c.charset)
      if (enc && enc !== 'utf8') declared.set(enc, (declared.get(enc) ?? 0) + 1)
    }
    if (declared.size) return [...declared].sort((a, b) => b[1] - a[1])[0][0]
    // 4. The database's default charset.
    const fromDatabase = codecForCharset(this.db.info.defaultCharset)
    if (fromDatabase) return fromDatabase
    // 5. The table's other NONE columns, then everything the session read.
    for (const other of [...this.noneColumns(structure).values()].filter((c) => c.name !== column.name).slice(0, SAMPLE_COLUMNS)) {
      await this.sample(ref, other)
    }
    return this.profiles.database.dominant() ?? 'utf8'
  }

  /** Encodings a stored value of this column may use, for matching it. */
  async matchEncodings(ref: DbObjectRef, column: ColumnDef): Promise<TextEncodingId[]> {
    const profile = this.profiles.column(EncodingProfiles.key(ref.name, column.name))
    if (!profile.evidence) await this.sample(ref, column)
    const encodings = new Set<TextEncodingId>(profile.seen())
    encodings.add(await this.writeEncoding(ref, column))
    encodings.add('utf8')
    return [...encodings]
  }

  /** A key whose NONE text values match the stored bytes in any of the column's encodings. */
  async key(ref: DbObjectRef, key: RowKey): Promise<RowKey> {
    if (!Object.values(key).some(nonAscii)) return key
    const columns = this.noneColumns(await this.structureOf(ref))
    const out: RowKey = {}
    for (const [name, value] of Object.entries(key)) {
      const column = columns.get(name)
      out[name] = column && nonAscii(value) ? { anyOf: await this.alternatives(ref, column, value) } : value
    }
    return out
  }

  private async alternatives(ref: DbObjectRef, column: ColumnDef, value: string): Promise<(CellValue | { sql: string })[]> {
    const seen = new Set<string>()
    const out: (CellValue | { sql: string })[] = []
    for (const enc of await this.matchEncodings(ref, column)) {
      // UTF-8 is what a plain literal sends on a UTF8 connection.
      if (enc === 'utf8') {
        if (!seen.has('utf8')) out.push(value)
        seen.add('utf8')
        continue
      }
      const bytes = encodeText(value, enc)
      const hex = bytes && this.db.dialect.literal(bytes)
      if (hex && !seen.has(hex)) {
        seen.add(hex)
        out.push({ sql: hex })
      }
    }
    return out
  }

  /** A table's structure by the name as written: unquoted Firebird names are stored in uppercase. */
  private async tableNamed(name: string): Promise<{ ref: DbObjectRef; structure: TableStructure } | null> {
    for (const candidate of [...new Set([name, name.toUpperCase()])]) {
      const ref: DbObjectRef = { name: candidate, kind: 'table' }
      try {
        const structure = await this.structureOf(ref)
        if (structure.columns.length) return { ref, structure }
      } catch {
        // not this spelling
      }
    }
    return null
  }

  /**
   * A statement whose text literals meet NONE columns as stored: comparisons match every encoding the
   * column holds, assignments are written in the column's encoding. Other statements are returned as is.
   */
  async rewriteSql(sql: string): Promise<string> {
    const engine = this.db.info.engine
    const names = legacyLiteralTables(sql, engine)
    if (!names.length) return sql
    const tables = new Map<string, { ref: DbObjectRef; structure: TableStructure }>()
    for (const name of names) {
      const found = await this.tableNamed(name)
      if (found) tables.set(name, found)
    }
    const columnsOf = (table: string) =>
      tables.get(table)?.structure.columns.map((c) => ({ name: c.name, none: isNoneText(c, this.db.info.defaultCharset) }))
    const encodings = new Map<string, LiteralEncodings>()
    for (const { table, column } of legacyLiteralColumns(sql, engine, columnsOf)) {
      const t = tables.get(table)!
      const def = t.structure.columns.find((c) => c.name === column)!
      encodings.set(`${table}.${column}`, { match: await this.matchEncodings(t.ref, def), write: await this.writeEncoding(t.ref, def) })
    }
    if (!encodings.size) return sql
    return rewriteLegacyLiterals(sql, engine, columnsOf, (table, column) => encodings.get(`${table}.${column}`)!, (bytes) => this.db.dialect.literal(bytes))
  }

  /** Row changes with NONE text encoded as the data is stored and keys matching any encoding. */
  async changes(ref: DbObjectRef, changes: RowChange[]): Promise<RowChange[]> {
    const touchesText = changes.some((c) => (c.kind !== 'delete' && Object.values(c.values).some(nonAscii)) || (c.kind !== 'insert' && Object.values(c.key).some(nonAscii)))
    if (!touchesText) return changes
    const columns = this.noneColumns(await this.structureOf(ref))
    if (!columns.size) return changes
    const out: RowChange[] = []
    for (const change of changes) {
      const key = change.kind === 'insert' ? undefined : await this.key(ref, change.key)
      if (change.kind === 'delete') {
        out.push({ ...change, key: key! })
        continue
      }
      const values: Record<string, CellValue | { sql: string }> = {}
      for (const [name, value] of Object.entries(change.values)) {
        const column = columns.get(name)
        if (!column || !nonAscii(value)) {
          values[name] = value
          continue
        }
        const enc = await this.writeEncoding(ref, column, change.kind === 'update' ? change.key : undefined)
        const bytes = encodeText(value, enc)
        if (!bytes) throw new Error(`"${name}" stores its text as ${enc}, which can't represent some of the characters typed.`)
        // CHAR/VARCHAR take the bytes as an OCTETS literal (copied as they are); text BLOBs as a parameter.
        values[name] = column.dataType.toUpperCase() === 'BLOB' ? bytes : { sql: this.db.dialect.literal(bytes) }
      }
      out.push(change.kind === 'update' ? { kind: 'update', key: key!, values } : { kind: 'insert', values })
    }
    return out
  }
}

/** Drops an incomplete UTF-8 sequence at the end of a cut value, if its start is valid UTF-8. */
export function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut++) {
    const head = bytes.subarray(0, bytes.length - cut)
    if (isStrictUtf8(head)) return head
  }
  return bytes
}
