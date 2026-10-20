import type { CheckDef, ColumnDef, DbEngine, DbObjectRef, ForeignKeyDef, IndexDef, ObjectKind, TableStructure, TriggerDef } from '@shared/model'
import type { TemplateContext } from '@domain/ports/database'
import { BaseDialect, sameColumn } from '../common/baseDialect'

const SQLITE_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'VARCHAR', 'DECIMAL', 'JSON', 'ANY']

const encode = (major: number, minor = 0): number => major * 10000 + minor * 100

/** Prefix of the temporary table used while a table is rebuilt. */
const REBUILD_PREFIX = '_ost_new_'
/** Temporary table whose CHECK fails when a rebuild leaves foreign key violations. */
const FK_CHECK = 'temp."_ost_fk_check"'

export class SqliteDialect extends BaseDialect {
  readonly dataTypes = SQLITE_TYPES
  protected readonly engine: DbEngine = 'sqlite'

  constructor(protected readonly version: number) {
    super()
    // SQLite stores booleans as 0/1; TRUE/FALSE keywords exist only since 3.23.
    this.booleanLiterals = version >= encode(3, 23)
  }

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"'
  }

  /** Objects live in "main"; other attached databases are qualified explicitly. */
  qualify(ref: DbObjectRef): string {
    return ref.database && ref.database !== 'main' ? `${this.quoteIdent(ref.database)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name)
  }

  override limitQuery(sql: string, limit: number): string {
    return `SELECT * FROM (${sql}) LIMIT ${limit}`
  }

  /** INTEGER PRIMARY KEY AUTOINCREMENT must be declared on the column itself. */
  private inlinePrimaryKey(t: TableStructure): ColumnDef | undefined {
    const pk = t.indexes.find((i) => i.type === 'PRIMARY')
    if (!pk || pk.columns.length !== 1) return undefined
    const col = t.columns.find((c) => c.name === pk.columns[0])
    return col?.autoIncrement ? col : undefined
  }

  columnDefinition(col: ColumnDef, table: TableStructure): string {
    const parts = [this.quoteIdent(col.name)]
    if (col.autoIncrement) {
      // SQLite only accepts AUTOINCREMENT on a column declared exactly "INTEGER PRIMARY KEY"
      // (a rowid alias): INTEGER(10) or BIGINT are refused, and lengths mean nothing there anyway.
      if (this.inlinePrimaryKey(table) !== col) throw new Error(`Auto increment needs "${col.name}" to be the only primary key column`)
      if (!/INT/i.test(col.dataType || col.fullType)) throw new Error(`Auto increment needs an integer column ("${col.name}" is ${col.fullType || 'untyped'})`)
      parts.push('INTEGER PRIMARY KEY AUTOINCREMENT')
    } else if (col.fullType.trim()) parts.push(col.fullType.trim())
    if (!col.nullable) parts.push('NOT NULL')
    if (col.generated) parts.push(`GENERATED ALWAYS AS (${col.generated.expression}) ${col.generated.stored ? 'STORED' : 'VIRTUAL'}`)
    else if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') parts.push(`DEFAULT ${defaultExpression(col.defaultValue)}`)
    if (col.collation) parts.push(`COLLATE ${col.collation}`)
    return parts.join(' ')
  }

  /** FKs reference tables in the same file; an empty column list means the referenced primary key. */
  protected override foreignKeyClause(fk: ForeignKeyDef): string {
    const refCols = fk.refColumns.filter(Boolean)
    const parts = [
      `${fk.name && !/^fk_\d+$/.test(fk.name) ? `CONSTRAINT ${this.quoteIdent(fk.name)} ` : ''}FOREIGN KEY (${fk.columns.map((c) => this.quoteIdent(c)).join(', ')})`,
      `REFERENCES ${this.quoteIdent(fk.refTable)}${refCols.length ? ` (${refCols.map((c) => this.quoteIdent(c)).join(', ')})` : ''}`
    ]
    if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${fk.onUpdate}`)
    if (fk.onDelete && fk.onDelete !== 'NO ACTION') parts.push(`ON DELETE ${fk.onDelete}`)
    return parts.join(' ')
  }

  /** Unnamed CHECKs are listed as check_N; the generated name stays out of the DDL. */
  protected override checkClause(ck: CheckDef): string {
    return super.checkClause(/^check_\d+$/.test(ck.name) ? { ...ck, name: '' } : ck)
  }

  protected override tableConstraints(t: TableStructure): string[] {
    const out: string[] = []
    const inline = this.inlinePrimaryKey(t)
    for (const idx of t.indexes) {
      if (idx.type === 'PRIMARY' && !inline) out.push(`PRIMARY KEY (${this.indexColumns(idx)})`)
      else if (idx.type === 'UNIQUE' && idx.constraint) out.push(`${idx.name && !idx.name.startsWith('sqlite_autoindex_') ? `CONSTRAINT ${this.quoteIdent(idx.name)} ` : ''}UNIQUE (${this.indexColumns(idx)})`)
    }
    for (const fk of t.foreignKeys) out.push(this.foreignKeyClause(fk))
    for (const ck of t.checks) out.push(this.checkClause(ck))
    return out
  }

  protected override tableOptionsClause(t: TableStructure): string {
    const opts: string[] = []
    if (t.sqliteOptions?.withoutRowid) opts.push('WITHOUT ROWID')
    if (t.sqliteOptions?.strict) opts.push('STRICT')
    return opts.length ? ` ${opts.join(', ')}` : ''
  }

  protected override createIndexStatements(t: TableStructure): string[] {
    return t.indexes.filter((i) => i.type !== 'PRIMARY' && !i.constraint).map((i) => this.createIndex(t.ref, i))
  }

  override createIndex(ref: DbObjectRef, idx: IndexDef): string {
    const unique = idx.type === 'UNIQUE' ? 'UNIQUE ' : ''
    const name = ref.database && ref.database !== 'main' ? `${this.quoteIdent(ref.database)}.${this.quoteIdent(idx.name)}` : this.quoteIdent(idx.name)
    const where = idx.condition ? ` WHERE ${idx.condition}` : ''
    return `CREATE ${unique}INDEX ${name} ON ${this.quoteIdent(ref.name)} (${this.indexColumns(idx)})${where}`
  }

  private dropIndex(ref: DbObjectRef, name: string): string {
    return `DROP INDEX ${this.qualify({ ...ref, name, kind: 'table' })}`
  }

  /**
   * Uses ALTER TABLE where SQLite supports the change (rename table/column, add/drop column, plain
   * indexes); anything else rebuilds the table with SQLite's documented procedure.
   */
  alterTable(original: TableStructure, targetTable: TableStructure): string[] {
    const target = this.prepareTable(targetTable)
    const plan = this.nativePlan(original, target)
    if (plan) return plan
    return this.rebuild(original, target)
  }

  /** Statements when every change is natively supported; null when the table must be rebuilt. */
  private nativePlan(original: TableStructure, target: TableStructure): string[] | null {
    const ref = original.ref
    const table = this.qualify(ref)
    const out: string[] = []
    const constraintIdx = (i: IndexDef): boolean => i.type === 'PRIMARY' || !!i.constraint
    const idx = this.diffByName(original.indexes, target.indexes)
    if ([...idx.dropped, ...idx.added].some(constraintIdx)) return null
    if (JSON.stringify(original.foreignKeys) !== JSON.stringify(target.foreignKeys)) return null
    if (JSON.stringify(original.checks) !== JSON.stringify(target.checks)) return null
    if (JSON.stringify(original.sqliteOptions ?? {}) !== JSON.stringify(target.sqliteOptions ?? {})) return null

    const cols = this.diffColumns(original, target)
    // Kept columns must stay in their order (new ones may only be appended).
    const kept = target.columns.filter((c) => original.columns.some((o) => o.name === (c.originalName ?? c.name)))
    const keptOriginal = original.columns.filter((o) => kept.some((c) => (c.originalName ?? c.name) === o.name))
    if (kept.some((c, i) => (c.originalName ?? c.name) !== keptOriginal[i].name)) return null
    const firstAdded = target.columns.findIndex((c) => cols.added.includes(c))
    if (firstAdded !== -1 && target.columns.slice(firstAdded).some((c) => !cols.added.includes(c))) return null

    const indexed = new Set(original.indexes.flatMap((i) => i.columns))
    const referenced = new Set(original.foreignKeys.flatMap((f) => f.columns))
    if (cols.dropped.some((c) => indexed.has(c.name) || referenced.has(c.name) || this.version < encode(3, 35))) return null
    if (cols.changed.some(({ before, after }) => !sameColumn({ ...before, name: after.name }, after) || this.version < encode(3, 25))) return null
    const addable = (c: ColumnDef): boolean => !c.autoIncrement && !c.generated?.stored && (c.nullable || (c.defaultValue ?? '') !== '')
    if (cols.added.some((c) => !addable(c))) return null

    for (const i of idx.dropped) out.push(this.dropIndex(ref, i.name))
    for (const { before, after } of cols.changed) out.push(`ALTER TABLE ${table} RENAME COLUMN ${this.quoteIdent(before.name)} TO ${this.quoteIdent(after.name)}`)
    for (const c of cols.dropped) out.push(`ALTER TABLE ${table} DROP COLUMN ${this.quoteIdent(c.name)}`)
    for (const c of cols.added) out.push(`ALTER TABLE ${table} ADD COLUMN ${this.columnDefinition(c, target)}`)
    if (target.ref.name !== ref.name) out.push(`ALTER TABLE ${table} RENAME TO ${this.quoteIdent(target.ref.name)}`)
    for (const i of idx.added) out.push(this.createIndex(target.ref, i))
    return out
  }

  /**
   * SQLite's 12-step table rebuild (https://sqlite.org/lang_altertable.html#otheralter), run in one
   * transaction: foreign keys are switched off first (otherwise DROP TABLE would fire ON DELETE
   * actions on referencing rows), dependent views are dropped (ALTER TABLE RENAME validates them),
   * the data is copied into a new table, indexes, triggers and views are recreated, and the foreign
   * keys are checked before committing. The connection applies the two foreign_keys pragmas outside
   * the transaction.
   */
  private rebuild(original: TableStructure, target: TableStructure): string[] {
    const ref = original.ref
    const tmp: DbObjectRef = { ...ref, name: `${REBUILD_PREFIX}${target.ref.name}` }
    const views = (original.dependents ?? []).filter((d) => d.kind === 'view')
    const triggers = (original.dependents ?? []).filter((d) => d.kind === 'trigger')
    const shape: TableStructure = { ...target, ref: tmp }
    const [create] = this.createTable(shape)
    const copied = target.columns.filter((c) => !c.generated && original.columns.some((o) => o.name === (c.originalName ?? c.name) && !o.generated))
    const out: string[] = ['PRAGMA foreign_keys = OFF']
    for (const v of views) out.push(`DROP VIEW ${this.qualify({ ...ref, name: v.name, kind: 'view' })}`)
    out.push(create)
    if (copied.length) {
      out.push(
        `INSERT INTO ${this.qualify(tmp)} (${copied.map((c) => this.quoteIdent(c.name)).join(', ')})\nSELECT ${copied
          .map((c) => this.quoteIdent(c.originalName ?? c.name))
          .join(', ')} FROM ${this.qualify(ref)}`
      )
    }
    out.push(`DROP TABLE ${this.qualify(ref)}`)
    out.push(`ALTER TABLE ${this.qualify(tmp)} RENAME TO ${this.quoteIdent(target.ref.name)}`)
    out.push(...this.createIndexStatements(target))
    for (const t of triggers) out.push(t.sql)
    for (const v of views) out.push(v.sql)
    // pragma_foreign_key_check lists violations; the CHECK turns any of them into an error that
    // aborts the transaction, with the constraint name as the message.
    out.push(`CREATE TEMP TABLE IF NOT EXISTS ${FK_CHECK} (ok INTEGER CONSTRAINT "foreign keys reference missing rows after the change" CHECK (ok))`)
    out.push(`INSERT INTO ${FK_CHECK} SELECT NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)`)
    out.push(`DROP TABLE ${FK_CHECK}`)
    out.push('PRAGMA foreign_keys = ON')
    return out
  }

  override dropObject(ref: DbObjectRef): string {
    const kw: Record<string, string> = { table: 'TABLE', view: 'VIEW', trigger: 'TRIGGER' }
    const k = kw[ref.kind]
    if (!k) throw new Error(`SQLite has no ${ref.kind} objects`)
    return `DROP ${k} ${this.qualify(ref)}`
  }

  override truncateTable(ref: DbObjectRef): string {
    return `DELETE FROM ${this.qualify(ref)}`
  }

  renameObject(ref: DbObjectRef, newName: string): string[] {
    if (ref.kind !== 'table') throw new Error(`SQLite cannot rename ${ref.kind} objects`)
    return [`ALTER TABLE ${this.qualify(ref)} RENAME TO ${this.quoteIdent(newName)}`]
  }

  /** The session service rebuilds the copy from the table structure (keeps keys, defaults and checks). */
  duplicateTable(): string[] {
    return []
  }

  maintenance(ref: DbObjectRef, action: 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'): string[] {
    const table = this.qualify(ref)
    switch (action) {
      case 'vacuum':
        return ['VACUUM']
      case 'analyze':
        return [`ANALYZE ${table}`]
      case 'check':
        return [`PRAGMA integrity_check(${this.quoteIdent(ref.name)})`]
      case 'optimize':
        return ['PRAGMA optimize']
      case 'repair':
        return [`REINDEX ${table}`]
    }
  }

  useDatabase(): string | null {
    return null
  }

  /** SQLite has no engines, charsets, owners or schemas to change in bulk. */
  bulkAlter(): string[] {
    return []
  }

  triggerBodyTemplate(): string {
    return 'BEGIN\n  -- UPDATE other_table SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;\n  SELECT 1;\nEND'
  }

  /** DDL is transactional, so the old trigger is dropped and the new one created in one go. */
  triggerStatements(original: TriggerDef | null, target: TriggerDef): string[] {
    const name = target.name.trim()
    if (!name) throw new Error('The trigger name is required')
    if (!target.table) throw new Error('Choose the table of the trigger')
    if (target.events.length !== 1) throw new Error('Choose exactly one event (INSERT, UPDATE or DELETE)')
    const body = /^\s*BEGIN\b/i.test(target.body) ? target.body.trim() : `BEGIN\n${target.body.trim()}\nEND`
    const when = target.when?.trim() ? `\nWHEN ${target.when.trim()}` : ''
    const create = `CREATE TRIGGER ${this.qualify({ database: target.database, name, kind: 'trigger' })}\n${target.timing} ${target.events[0]} ON ${this.quoteIdent(target.table)}\nFOR EACH ROW${when}\n${body}`
    return original ? [`DROP TRIGGER ${this.qualify({ database: original.database, name: original.name, kind: 'trigger' })}`, create] : [create]
  }

  createTemplate(kind: ObjectKind, ctx: TemplateContext): string {
    switch (kind) {
      case 'table':
        return `CREATE TABLE ${this.quoteIdent('new_table')} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL\n);\n`
      case 'view':
        return `CREATE VIEW ${this.quoteIdent('new_view')} AS\nSELECT 1 AS id;\n`
      case 'trigger': {
        const table = ctx.table ?? 'table_name'
        const name = `${table.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_ai`
        return `CREATE TRIGGER ${this.quoteIdent(name)}\nAFTER INSERT ON ${this.quoteIdent(table)}\nFOR EACH ROW\nBEGIN\n  SELECT 1;\nEND;\n`
      }
      default:
        throw new Error(`SQLite has no ${kind} objects`)
    }
  }

  userStatements(): string[] {
    throw new Error('SQLite has no users or privileges')
  }
}

/** DEFAULT needs parentheses around expressions that are not literals, numbers or keywords. */
function defaultExpression(value: string): string {
  const v = value.trim()
  if (/^\(.*\)$/s.test(v)) return v
  if (/^[-+]?\d+(\.\d+)?$/.test(v) || /^'(?:[^']|'')*'$/s.test(v) || /^X'[0-9a-f]*'$/i.test(v)) return v
  if (/^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(v)) return v
  return `(${v})`
}
