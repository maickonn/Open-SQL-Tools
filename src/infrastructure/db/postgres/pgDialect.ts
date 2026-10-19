import type { BulkTableOperations, ColumnDef, DbObjectRef, IndexDef, Partitioning, ServerUser, TableStructure } from '@shared/model'
import { BaseDialect, toHex } from '../common/baseDialect'

/** Keywords that must be quoted when used as identifiers (reserved in PostgreSQL). */
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column ' +
    'concurrently constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from ' +
    'full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime ' +
    'localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning ' +
    'right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user ' +
    'using variadic verbose when where window with'
  ).split(' ')
)

const PG_TYPES = [
  'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'smallserial', 'serial', 'bigserial', 'money',
  'boolean', 'char', 'varchar', 'text', 'bytea', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval',
  'uuid', 'json', 'jsonb', 'xml', 'inet', 'cidr', 'macaddr', 'macaddr8', 'point', 'line', 'lseg', 'box', 'path', 'polygon',
  'circle', 'bit', 'varbit', 'tsvector', 'tsquery', 'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange'
]

export class PgDialect extends BaseDialect {
  readonly dataTypes = PG_TYPES

  constructor(protected readonly version: number) {
    super()
  }

  quoteIdent(name: string): string {
    if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name
    return '"' + name.replace(/"/g, '""') + '"'
  }

  qualify(ref: DbObjectRef): string {
    const name = ref.schema ? `${this.quoteIdent(ref.schema)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name)
    return ref.args !== undefined && (ref.kind === 'function' || ref.kind === 'procedure') ? `${name}(${ref.args})` : name
  }

  override binaryLiteral(bytes: Uint8Array): string {
    return `'\\x${toHex(bytes)}'::bytea`
  }

  columnDefinition(col: ColumnDef): string {
    const parts = [this.quoteIdent(col.name), col.fullType]
    if (col.collation) parts.push(`COLLATE ${this.quoteIdent(col.collation)}`)
    if (col.generated) {
      const stored = col.generated.stored || this.version < 180000
      parts.push(`GENERATED ALWAYS AS (${col.generated.expression})${stored ? ' STORED' : ' VIRTUAL'}`)
    } else if (col.identity) {
      parts.push(`GENERATED ${col.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
    }
    if (!col.nullable) parts.push('NOT NULL')
    if (!col.generated && !col.identity && col.defaultValue !== undefined && col.defaultValue !== null) parts.push(`DEFAULT ${col.defaultValue}`)
    return parts.join(' ')
  }

  protected override tableConstraints(t: TableStructure): string[] {
    const out: string[] = []
    for (const idx of t.indexes) {
      if (idx.type === 'PRIMARY') out.push(`CONSTRAINT ${this.quoteIdent(idx.name)} PRIMARY KEY (${this.indexColumns(idx)})`)
      else if (idx.type === 'UNIQUE' && idx.constraint) out.push(`CONSTRAINT ${this.quoteIdent(idx.name)} UNIQUE (${this.indexColumns(idx)})`)
    }
    for (const fk of t.foreignKeys) out.push(this.foreignKeyClause(fk, t.ref))
    for (const ck of t.checks) out.push(this.checkClause(ck))
    return out
  }

  protected override createIndexStatements(t: TableStructure): string[] {
    return t.indexes.filter((i) => i.type !== 'PRIMARY' && !i.constraint).map((i) => this.createIndex(t.ref, i))
  }

  override createIndex(ref: DbObjectRef, idx: IndexDef): string {
    const unique = idx.type === 'UNIQUE' ? 'UNIQUE ' : ''
    const method = idx.method && idx.method.toLowerCase() !== 'btree' ? ` USING ${idx.method}` : ''
    const where = idx.condition ? ` WHERE ${idx.condition}` : ''
    return `CREATE ${unique}INDEX ${this.quoteIdent(idx.name)} ON ${this.qualify(ref)}${method} (${this.indexColumns(idx)})${where}`
  }

  protected override tableOptionsClause(t: TableStructure): string {
    let clause = ''
    const p = t.options.partitioning
    if (p) clause += ` PARTITION BY ${p.method} (${p.expression.trim()})`
    if (t.options.tablespace) clause += ` TABLESPACE ${this.quoteIdent(t.options.tablespace)}`
    return clause
  }

  private comments(t: TableStructure): string[] {
    const out: string[] = []
    if (t.options.comment) out.push(`COMMENT ON TABLE ${this.qualify(t.ref)} IS ${this.quoteString(t.options.comment)}`)
    for (const c of t.columns) {
      if (c.comment) out.push(`COMMENT ON COLUMN ${this.qualify(t.ref)}.${this.quoteIdent(c.name)} IS ${this.quoteString(c.comment)}`)
    }
    return out
  }

  override createTable(t: TableStructure): string[] {
    const children = (t.options.partitioning?.partitions ?? []).map((p) => this.createPartition(t.ref, p))
    return [...super.createTable(t), ...children, ...this.comments(t)]
  }

  private partitionRef(parent: DbObjectRef, name: string): DbObjectRef {
    return { ...parent, name, kind: 'table' }
  }

  private boundClause(bound: string): string {
    const b = bound.trim()
    return /^DEFAULT$/i.test(b) ? 'DEFAULT' : `FOR VALUES ${b}`
  }

  createPartition(parent: DbObjectRef, p: Partitioning['partitions'][number]): string {
    return `CREATE TABLE ${this.qualify(this.partitionRef(parent, p.name))} PARTITION OF ${this.qualify(parent)} ${this.boundClause(p.bound)}`
  }

  /** PostgreSQL can add, drop and re-bound partitions but never change the partition key. */
  protected alterPartitions(parent: DbObjectRef, before: Partitioning | undefined, after: Partitioning | undefined): string[] {
    if (JSON.stringify(before) === JSON.stringify(after)) return []
    if (!before || !after || before.method !== after.method || before.expression.trim() !== after.expression.trim()) {
      throw new Error('PostgreSQL cannot change the partition key of an existing table; create a new partitioned table instead')
    }
    const table = this.qualify(parent)
    const old = new Map(before.partitions.map((p) => [p.name, p]))
    const out: string[] = []
    for (const p of before.partitions) {
      if (!after.partitions.some((x) => x.name === p.name)) out.push(`DROP TABLE ${this.qualify(this.partitionRef(parent, p.name))}`)
    }
    for (const p of after.partitions) {
      const prev = old.get(p.name)
      if (!prev) out.push(this.createPartition(parent, p))
      else if (prev.bound.trim() !== p.bound.trim()) {
        const child = this.qualify(this.partitionRef(parent, p.name))
        out.push(`ALTER TABLE ${table} DETACH PARTITION ${child}`, `ALTER TABLE ${table} ATTACH PARTITION ${child} ${this.boundClause(p.bound)}`)
      }
    }
    return out
  }

  bulkAlter(ref: DbObjectRef, ops: BulkTableOperations): string[] {
    const table = this.qualify(ref)
    const out: string[] = []
    if (ops.tablespace) out.push(`ALTER TABLE ${table} SET TABLESPACE ${this.quoteIdent(ops.tablespace)}`)
    if (ops.owner) out.push(`ALTER TABLE ${table} OWNER TO ${this.quoteIdent(ops.owner)}`)
    // Moving schemas last: earlier statements still use the old qualified name.
    if (ops.moveTo && ops.moveTo !== ref.schema) out.push(`ALTER TABLE ${table} SET SCHEMA ${this.quoteIdent(ops.moveTo)}`)
    return out
  }

  private dropIndexSql(ref: DbObjectRef, idx: IndexDef): string {
    if (idx.type === 'PRIMARY' || idx.constraint) return `ALTER TABLE ${this.qualify(ref)} DROP CONSTRAINT ${this.quoteIdent(idx.name)}`
    return `DROP INDEX ${this.qualify({ ...ref, name: idx.name, kind: 'table' })}`
  }

  private addIndexSql(ref: DbObjectRef, idx: IndexDef): string {
    if (idx.type === 'PRIMARY') return `ALTER TABLE ${this.qualify(ref)} ADD CONSTRAINT ${this.quoteIdent(idx.name)} PRIMARY KEY (${this.indexColumns(idx)})`
    if (idx.type === 'UNIQUE' && idx.constraint) {
      return `ALTER TABLE ${this.qualify(ref)} ADD CONSTRAINT ${this.quoteIdent(idx.name)} UNIQUE (${this.indexColumns(idx)})`
    }
    return this.createIndex(ref, idx)
  }

  alterTable(original: TableStructure, target: TableStructure): string[] {
    const ref = original.ref
    const table = this.qualify(ref)
    const out: string[] = []
    const fks = this.diffByName(original.foreignKeys, target.foreignKeys)
    for (const fk of fks.dropped) out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${this.quoteIdent(fk.name)}`)
    const checks = this.diffByName(original.checks, target.checks)
    for (const c of checks.dropped) out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${this.quoteIdent(c.name)}`)
    const idx = this.diffByName(original.indexes, target.indexes)
    for (const i of idx.dropped) out.push(this.dropIndexSql(ref, i))

    const cols = this.diffColumns(original, target)
    for (const c of cols.dropped) out.push(`ALTER TABLE ${table} DROP COLUMN ${this.quoteIdent(c.name)}`)
    for (const { before, after } of cols.changed) {
      const col = (n: string): string => `ALTER TABLE ${table} ALTER COLUMN ${this.quoteIdent(n)}`
      if (before.name !== after.name) out.push(`ALTER TABLE ${table} RENAME COLUMN ${this.quoteIdent(before.name)} TO ${this.quoteIdent(after.name)}`)
      const name = after.name
      if (before.fullType.toLowerCase() !== after.fullType.toLowerCase()) {
        out.push(`${col(name)} TYPE ${after.fullType} USING ${this.quoteIdent(name)}::${after.fullType}`)
      }
      if ((before.collation ?? '') !== (after.collation ?? '') && after.collation) {
        out.push(`${col(name)} TYPE ${after.fullType} COLLATE ${this.quoteIdent(after.collation)}`)
      }
      if (before.nullable !== after.nullable) out.push(`${col(name)} ${after.nullable ? 'DROP' : 'SET'} NOT NULL`)
      if ((before.defaultValue ?? null) !== (after.defaultValue ?? null) && !after.identity) {
        out.push(after.defaultValue ? `${col(name)} SET DEFAULT ${after.defaultValue}` : `${col(name)} DROP DEFAULT`)
      }
      if ((before.identity ?? null) !== (after.identity ?? null)) {
        if (!after.identity) out.push(`${col(name)} DROP IDENTITY IF EXISTS`)
        else if (!before.identity) out.push(`${col(name)} ADD GENERATED ${after.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
        else out.push(`${col(name)} SET GENERATED ${after.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`)
      }
      if ((before.generated?.expression ?? '') !== (after.generated?.expression ?? '') && after.generated) {
        if (this.version >= 170000 && before.generated) out.push(`${col(name)} SET EXPRESSION AS (${after.generated.expression})`)
        else {
          out.push(`ALTER TABLE ${table} DROP COLUMN ${this.quoteIdent(name)}`)
          out.push(`ALTER TABLE ${table} ADD COLUMN ${this.columnDefinition(after)}`)
        }
      }
      if ((before.comment ?? '') !== (after.comment ?? '')) {
        out.push(`COMMENT ON COLUMN ${table}.${this.quoteIdent(name)} IS ${after.comment ? this.quoteString(after.comment) : 'NULL'}`)
      }
    }
    for (const c of cols.added) {
      out.push(`ALTER TABLE ${table} ADD COLUMN ${this.columnDefinition(c)}`)
      if (c.comment) out.push(`COMMENT ON COLUMN ${table}.${this.quoteIdent(c.name)} IS ${this.quoteString(c.comment)}`)
    }
    for (const i of idx.added) out.push(this.addIndexSql(ref, i))
    for (const c of checks.added) out.push(`ALTER TABLE ${table} ADD ${this.checkClause(c)}`)
    for (const fk of fks.added) out.push(`ALTER TABLE ${table} ADD ${this.foreignKeyClause(fk, target.ref)}`)
    if ((original.options.comment ?? '') !== (target.options.comment ?? '')) {
      out.push(`COMMENT ON TABLE ${table} IS ${target.options.comment ? this.quoteString(target.options.comment) : 'NULL'}`)
    }
    out.push(...this.alterPartitions(ref, original.options.partitioning, target.options.partitioning))
    if (target.ref.name !== ref.name) out.push(`ALTER TABLE ${table} RENAME TO ${this.quoteIdent(target.ref.name)}`)
    return out
  }

  override dropObject(ref: DbObjectRef): string {
    switch (ref.kind) {
      case 'database':
        return `DROP DATABASE ${this.quoteIdent(ref.name)}`
      case 'schema':
        return `DROP SCHEMA ${this.quoteIdent(ref.name)}`
      case 'trigger':
        if (!ref.table) throw new Error('The owning table is required to drop a PostgreSQL trigger')
        return `DROP TRIGGER ${this.quoteIdent(ref.name)} ON ${this.qualify({ ...ref, name: ref.table, kind: 'table' })}`
      case 'type':
        return `DROP TYPE ${this.qualify(ref)}`
      default:
        return super.dropObject(ref)
    }
  }

  renameObject(ref: DbObjectRef, newName: string): string[] {
    const kw: Record<string, string> = {
      table: 'TABLE', view: 'VIEW', materialized_view: 'MATERIALIZED VIEW', sequence: 'SEQUENCE', function: 'FUNCTION',
      procedure: 'PROCEDURE', schema: 'SCHEMA', database: 'DATABASE', domain: 'DOMAIN', type: 'TYPE'
    }
    const k = kw[ref.kind]
    if (!k) throw new Error(`Renaming ${ref.kind} objects is not supported`)
    const target = ref.kind === 'schema' || ref.kind === 'database' ? this.quoteIdent(ref.name) : this.qualify(ref)
    return [`ALTER ${k} ${target} RENAME TO ${this.quoteIdent(newName)}`]
  }

  duplicateTable(ref: DbObjectRef, newName: string, withData: boolean): string[] {
    const target = this.qualify({ ...ref, name: newName })
    const out = [`CREATE TABLE ${target} (LIKE ${this.qualify(ref)} INCLUDING ALL)`]
    if (withData) out.push(`INSERT INTO ${target} SELECT * FROM ${this.qualify(ref)}`)
    return out
  }

  maintenance(ref: DbObjectRef, action: 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'): string[] {
    const t = this.qualify(ref)
    switch (action) {
      case 'vacuum':
        return [`VACUUM ${t}`]
      case 'optimize':
        return [`VACUUM FULL ${t}`]
      case 'analyze':
        return [`ANALYZE ${t}`]
      case 'repair':
        return [`REINDEX TABLE ${t}`]
      case 'check':
        return []
    }
  }

  useDatabase(): string | null {
    return null
  }

  override truncateTable(ref: DbObjectRef): string {
    return `TRUNCATE TABLE ${this.qualify(ref)}`
  }

  userStatements(p: {
    action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'
    user: ServerUser
    password?: string
    privileges?: string[]
    on?: string
  }): string[] {
    const role = this.quoteIdent(p.user.name)
    const privs = (p.privileges?.length ? p.privileges : ['ALL PRIVILEGES']).join(', ')
    switch (p.action) {
      case 'create':
        return [`CREATE ROLE ${role} LOGIN${p.password ? ` PASSWORD ${this.quoteString(p.password)}` : ''}`]
      case 'drop':
        return [`DROP ROLE ${role}`]
      case 'password':
        return [`ALTER ROLE ${role} PASSWORD ${this.quoteString(p.password ?? '')}`]
      case 'grant':
        return [`GRANT ${privs} ON ${p.on ?? 'ALL TABLES IN SCHEMA public'} TO ${role}`]
      case 'revoke':
        return [`REVOKE ${privs} ON ${p.on ?? 'ALL TABLES IN SCHEMA public'} FROM ${role}`]
    }
  }
}
