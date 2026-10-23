import type {
  BulkTableOperations,
  CellValue,
  CheckDef,
  ColumnDef,
  DbEngine,
  DbObjectRef,
  ForeignKeyDef,
  IndexDef,
  LobKind,
  ObjectKind,
  RowChange,
  ServerUser,
  TableDataRequest,
  TableStructure,
  TriggerDef
} from '@shared/model'
import type { SqlDialect, TemplateContext } from '@domain/ports/database'
import { joinType, splitType } from '@domain/sql/columnType'
import { typeArguments } from '@domain/sql/typeArguments'
import { toHex } from '@shared/bytes'
import { LOB_PREVIEW_CHARS } from '@domain/lob'

export type RawSql = { sql: string }

export const isRawSql = (v: unknown): v is RawSql =>
  typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && typeof (v as RawSql).sql === 'string'

export { toHex }

/** Shared SQL generation; engines override what differs. */
export abstract class BaseDialect implements SqlDialect {
  abstract readonly dataTypes: string[]
  /** Engine whose type and key rules apply to generated DDL. */
  protected abstract readonly engine: DbEngine
  abstract quoteIdent(name: string): string
  abstract qualify(ref: DbObjectRef): string
  abstract columnDefinition(col: ColumnDef, table: TableStructure): string
  abstract alterTable(original: TableStructure, target: TableStructure): string[]
  abstract renameObject(ref: DbObjectRef, newName: string): string[]
  abstract duplicateTable(ref: DbObjectRef, newName: string, withData: boolean): string[]
  abstract maintenance(ref: DbObjectRef, action: 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'): string[]
  abstract useDatabase(database: string): string | null
  abstract bulkAlter(ref: DbObjectRef, ops: BulkTableOperations): string[]
  abstract createTemplate(kind: ObjectKind, ctx: TemplateContext): string
  abstract triggerStatements(original: TriggerDef | null, target: TriggerDef): string[]
  abstract triggerBodyTemplate(): string

  setEnabled(_ref: DbObjectRef, _enabled: boolean): string[] {
    return []
  }

  setSequenceValue(_ref: DbObjectRef, _value: string): string[] {
    return []
  }

  setExceptionMessage(_ref: DbObjectRef, _message: string): string[] {
    return []
  }

  /** Validates a value typed by the user for a sequence (integers only). */
  protected sequenceValue(value: string): string {
    const v = value.trim()
    if (!/^-?\d+$/.test(v)) throw new Error(`Invalid sequence value: ${value}`)
    return v
  }

  abstract userStatements(p: {
    action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'
    user: ServerUser
    password?: string
    privileges?: string[]
    on?: string
  }): string[]

  /** Whether string literals need backslashes escaped (MySQL family without NO_BACKSLASH_ESCAPES). */
  protected backslashEscapes = false
  protected booleanLiterals = true

  quoteString(s: string): string {
    let v = s.replace(/'/g, "''")
    if (this.backslashEscapes) v = v.replace(/\\/g, '\\\\')
    return `'${v}'`
  }

  binaryLiteral(bytes: Uint8Array): string {
    return `X'${toHex(bytes)}'`
  }

  literal(value: CellValue | RawSql | undefined): string {
    if (value === null || value === undefined) return 'NULL'
    if (isRawSql(value)) return value.sql
    switch (typeof value) {
      case 'number':
        return Number.isFinite(value) ? String(value) : this.quoteString(String(value))
      case 'bigint':
        return value.toString()
      case 'boolean':
        return this.booleanLiterals ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0'
      case 'string':
        return this.quoteString(value)
      default:
        return value instanceof Uint8Array ? this.binaryLiteral(value) : this.quoteString(String(value))
    }
  }

  protected selectList(req: TableDataRequest): string {
    if (!req.columns?.length) return '*'
    const lazy = new Map(req.lazy?.map((l) => [l.column, l.kind]))
    return req.columns
      .map((c) => {
        const kind = lazy.get(c)
        return kind ? `${this.lobPreview(this.quoteIdent(c), kind)} AS ${this.quoteIdent(c)}` : this.quoteIdent(c)
      })
      .join(', ')
  }

  /** Grid stand-in for a LOB column: its size, or its first characters plus LOB_CUT_MARK when cut. */
  protected lobPreview(column: string, kind: LobKind): string {
    if (kind === 'binary') return `OCTET_LENGTH(${column})`
    return `CASE WHEN CHAR_LENGTH(${column}) > ${LOB_PREVIEW_CHARS} THEN CONCAT(LEFT(${column}, ${LOB_PREVIEW_CHARS}), CHAR(1 USING utf8mb4)) ELSE ${column} END`
  }

  selectByKey(ref: DbObjectRef, columns: string[], key: Record<string, CellValue>): string {
    return `SELECT ${columns.map((c) => this.quoteIdent(c)).join(', ')} FROM ${this.qualify(ref)} WHERE ${this.keyCondition(key)}`
  }

  protected whereAndOrder(req: TableDataRequest): string {
    let sql = ''
    if (req.where && req.where.trim()) sql += ` WHERE ${req.where.trim()}`
    if (req.orderBy && req.orderBy.length) {
      sql += ' ORDER BY ' + req.orderBy.map((o) => `${this.quoteIdent(o.column)}${o.desc ? ' DESC' : ''}`).join(', ')
    }
    return sql
  }

  selectTableData(req: TableDataRequest): string {
    return `SELECT ${this.selectList(req)} FROM ${this.qualify(req.ref)}${this.whereAndOrder(req)} LIMIT ${req.limit} OFFSET ${req.offset}`
  }

  limitQuery(sql: string, limit: number): string {
    return `SELECT * FROM (${sql}) AS limited_query LIMIT ${limit}`
  }

  protected keyCondition(key: Record<string, CellValue>): string {
    return Object.entries(key)
      .map(([col, val]) => (val === null ? `${this.quoteIdent(col)} IS NULL` : `${this.quoteIdent(col)} = ${this.literal(val)}`))
      .join(' AND ')
  }

  /** Suffix limiting UPDATE/DELETE to one row when keys may not be unique. */
  protected singleRowSuffix(): string {
    return ''
  }

  rowChanges(ref: DbObjectRef, changes: RowChange[]): string[] {
    const table = this.qualify(ref)
    return changes.map((ch) => {
      switch (ch.kind) {
        case 'insert': {
          const cols = Object.keys(ch.values)
          if (cols.length === 0) return `INSERT INTO ${table} DEFAULT VALUES`
          return `INSERT INTO ${table} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) VALUES (${cols
            .map((c) => this.literal(ch.values[c]))
            .join(', ')})`
        }
        case 'update': {
          const sets = Object.entries(ch.values).map(([c, v]) => `${this.quoteIdent(c)} = ${this.literal(v)}`)
          return `UPDATE ${table} SET ${sets.join(', ')} WHERE ${this.keyCondition(ch.key)}${this.singleRowSuffix()}`
        }
        case 'delete':
          return `DELETE FROM ${table} WHERE ${this.keyCondition(ch.key)}${this.singleRowSuffix()}`
      }
    })
  }

  protected indexColumns(idx: IndexDef): string {
    if (idx.expression) return idx.expression
    return idx.columns
      .map((c, i) => {
        const sub = idx.subParts?.[i]
        return `${this.quoteIdent(c)}${sub ? `(${sub})` : ''}`
      })
      .join(', ')
  }

  protected foreignKeyClause(fk: ForeignKeyDef, ref: DbObjectRef): string {
    const target = this.qualify({ ...ref, database: fk.refDatabase ?? ref.database, schema: fk.refSchema ?? ref.schema, name: fk.refTable, kind: 'table' })
    const parts = [
      `CONSTRAINT ${this.quoteIdent(fk.name)} FOREIGN KEY (${fk.columns.map((c) => this.quoteIdent(c)).join(', ')})`,
      `REFERENCES ${target} (${fk.refColumns.map((c) => this.quoteIdent(c)).join(', ')})`
    ]
    if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${fk.onUpdate}`)
    if (fk.onDelete && fk.onDelete !== 'NO ACTION') parts.push(`ON DELETE ${fk.onDelete}`)
    return parts.join(' ')
  }

  protected checkClause(ck: CheckDef): string {
    const expr = ck.expression.trim().replace(/^CHECK\s*/i, '')
    const wrapped = expr.startsWith('(') ? expr : `(${expr})`
    return `${ck.name ? `CONSTRAINT ${this.quoteIdent(ck.name)} ` : ''}CHECK ${wrapped}`
  }

  /** Inline table elements other than columns (PK, unique, FKs, checks). */
  protected tableConstraints(t: TableStructure): string[] {
    const out: string[] = []
    for (const idx of t.indexes) {
      if (idx.type === 'PRIMARY') out.push(`PRIMARY KEY (${this.indexColumns(idx)})`)
    }
    for (const fk of t.foreignKeys) out.push(this.foreignKeyClause(fk, t.ref))
    for (const ck of t.checks) out.push(this.checkClause(ck))
    return out
  }

  /** Index statements created after CREATE TABLE. */
  protected createIndexStatements(t: TableStructure): string[] {
    return t.indexes.filter((i) => i.type !== 'PRIMARY').map((i) => this.createIndex(t.ref, i))
  }

  createIndex(ref: DbObjectRef, idx: IndexDef): string {
    const unique = idx.type === 'UNIQUE' ? 'UNIQUE ' : ''
    return `CREATE ${unique}INDEX ${this.quoteIdent(idx.name)} ON ${this.qualify(ref)} (${this.indexColumns(idx)})`
  }

  /**
   * Fixes what the table editor can produce but the engine rejects (arguments on types that take
   * none, such as INTEGER(10) or DATE(3)) and refuses what cannot be fixed with a clear message
   * before anything runs. Dialects call it first in createTable and alterTable.
   */
  protected prepareTable(t: TableStructure): TableStructure {
    const columns = t.columns.map((c) => {
      if (c.domain || !c.fullType.trim()) return c
      const { base, args, suffix } = splitType(c.fullType)
      const rule = typeArguments(this.engine, base)
      if (rule === 'none' && args) return { ...c, fullType: joinType(base, '', suffix), length: undefined, precision: undefined, scale: undefined }
      if (rule === 'required' && !args) throw new Error(`${base.toUpperCase()} needs a length: set Length/Set for column "${c.name}"`)
      return c
    })
    const prepared = { ...t, columns }
    this.validateTable(prepared)
    return prepared
  }

  /** Engine rules the generated DDL must respect (auto increment / identity columns…). */
  protected validateTable(_t: TableStructure): void {}

  createTable(table: TableStructure): string[] {
    const t = this.prepareTable(table)
    const elements = [...t.columns.map((c) => '  ' + this.columnDefinition(c, t)), ...this.tableConstraints(t).map((c) => '  ' + c)]
    return [`CREATE TABLE ${this.qualify(t.ref)} (\n${elements.join(',\n')}\n)${this.tableOptionsClause(t)}`, ...this.createIndexStatements(t)]
  }

  protected tableOptionsClause(_t: TableStructure): string {
    return ''
  }

  dropObject(ref: DbObjectRef): string {
    const kind = ref.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : ref.kind.toUpperCase()
    return `DROP ${kind} ${this.qualify(ref)}`
  }

  truncateTable(ref: DbObjectRef): string {
    return `TRUNCATE TABLE ${this.qualify(ref)}`
  }

  /** Columns matched by original name; returns [dropped, added, changed pairs]. */
  protected diffColumns(original: TableStructure, target: TableStructure): {
    dropped: ColumnDef[]
    added: ColumnDef[]
    changed: { before: ColumnDef; after: ColumnDef }[]
  } {
    const byName = new Map(original.columns.map((c) => [c.name, c]))
    const kept = new Set<string>()
    const added: ColumnDef[] = []
    const changed: { before: ColumnDef; after: ColumnDef }[] = []
    for (const col of target.columns) {
      const before = byName.get(col.originalName ?? col.name)
      if (!before) {
        added.push(col)
        continue
      }
      kept.add(before.name)
      if (!sameColumn(before, col)) changed.push({ before, after: col })
    }
    const dropped = original.columns.filter((c) => !kept.has(c.name))
    return { dropped, added, changed }
  }

  protected diffByName<T extends { name: string }>(before: T[], after: T[]): { dropped: T[]; added: T[] } {
    const key = (x: T): string => JSON.stringify(x)
    const beforeMap = new Map(before.map((x) => [x.name, key(x)]))
    const afterMap = new Map(after.map((x) => [x.name, key(x)]))
    return {
      dropped: before.filter((x) => afterMap.get(x.name) !== key(x)),
      added: after.filter((x) => beforeMap.get(x.name) !== key(x))
    }
  }
}

export function sameColumn(a: ColumnDef, b: ColumnDef): boolean {
  const pick = (c: ColumnDef): unknown[] => [
    c.name,
    c.fullType.toLowerCase(),
    c.nullable,
    c.defaultValue ?? null,
    !!c.autoIncrement,
    c.identity ?? null,
    c.generated?.expression ?? null,
    c.generated?.stored ?? null,
    !!c.invisible,
    c.collation ?? null,
    c.comment ?? '',
    c.onUpdate ?? null
  ]
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b))
}
