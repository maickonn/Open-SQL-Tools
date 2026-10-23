import type { BulkTableOperations, CellValue, ColumnDef, DbEngine, DbObjectRef, IndexDef, ObjectKind, Partitioning, ServerUser, TableStructure, TriggerDef } from '@shared/model'
import type { TemplateContext } from '@domain/ports/database'
import { BaseDialect } from '../common/baseDialect'

const MYSQL_TYPES = [
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BIT', 'BOOLEAN',
  'CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BINARY', 'VARBINARY',
  'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'ENUM', 'SET', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'JSON', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION'
]

export class MySqlDialect extends BaseDialect {
  protected readonly engine: DbEngine = 'mysql'
  readonly dataTypes: string[]

  constructor(
    protected readonly version: number,
    noBackslashEscapes = false
  ) {
    super()
    this.backslashEscapes = !noBackslashEscapes
    this.dataTypes = this.buildTypes()
  }

  protected buildTypes(): string[] {
    return this.version >= 90000 ? [...MYSQL_TYPES, 'VECTOR'] : MYSQL_TYPES
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`'
  }

  qualify(ref: DbObjectRef): string {
    return ref.database ? `${this.quoteIdent(ref.database)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name)
  }

  protected generatedNullability = true

  override selectLobBytes(ref: DbObjectRef, column: string, key: Record<string, CellValue>): string {
    return `SELECT CAST(${this.quoteIdent(column)} AS BINARY) FROM ${this.qualify(ref)} WHERE ${this.keyCondition(key)}`
  }

  protected override singleRowSuffix(): string {
    return ' LIMIT 1'
  }

  columnDefinition(col: ColumnDef, _t?: TableStructure): string {
    const parts = [this.quoteIdent(col.name), col.fullType]
    if (col.charset && /char|text|enum|set/i.test(col.dataType)) parts.push(`CHARACTER SET ${col.charset}`)
    if (col.collation && /char|text|enum|set/i.test(col.dataType)) parts.push(`COLLATE ${col.collation}`)
    if (col.generated) {
      parts.push(`GENERATED ALWAYS AS (${col.generated.expression}) ${col.generated.stored ? 'STORED' : 'VIRTUAL'}`)
    }
    // MariaDB rejects NULL/NOT NULL on generated columns.
    if (!col.generated || this.generatedNullability) parts.push(col.nullable ? 'NULL' : 'NOT NULL')
    if (!col.generated && col.defaultValue !== undefined && col.defaultValue !== null && !col.autoIncrement) {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }
    if (col.onUpdate) parts.push(`ON UPDATE ${col.onUpdate}`)
    if (col.autoIncrement) parts.push('AUTO_INCREMENT')
    if (col.invisible) parts.push('INVISIBLE')
    if (col.comment) parts.push(`COMMENT ${this.quoteString(col.comment)}`)
    return parts.join(' ')
  }

  protected indexDefinition(idx: IndexDef): string {
    const cols = idx.expression ? `(${idx.expression})` : this.indexColumns(idx)
    const comment = idx.comment ? ` COMMENT ${this.quoteString(idx.comment)}` : ''
    const using = idx.method && /^(BTREE|HASH)$/i.test(idx.method) ? ` USING ${idx.method.toUpperCase()}` : ''
    switch (idx.type) {
      case 'PRIMARY':
        return `PRIMARY KEY (${cols})${using}${comment}`
      case 'UNIQUE':
        return `UNIQUE KEY ${this.quoteIdent(idx.name)} (${cols})${using}${comment}`
      case 'FULLTEXT':
        return `FULLTEXT KEY ${this.quoteIdent(idx.name)} (${cols})${comment}`
      case 'SPATIAL':
        return `SPATIAL KEY ${this.quoteIdent(idx.name)} (${cols})${comment}`
      case 'VECTOR':
        return `VECTOR KEY ${this.quoteIdent(idx.name)} (${cols})${comment}`
      default:
        return `KEY ${this.quoteIdent(idx.name)} (${cols})${using}${comment}`
    }
  }

  protected override tableConstraints(t: TableStructure): string[] {
    return [
      ...t.indexes.map((i) => this.indexDefinition(i)),
      ...t.foreignKeys.map((fk) => this.foreignKeyClause(fk, t.ref)),
      ...t.checks.map((c) => this.checkClause(c))
    ]
  }

  protected override createIndexStatements(): string[] {
    return []
  }

  protected override tableOptionsClause(t: TableStructure): string {
    const o = t.options
    const parts: string[] = []
    if (o.engine) parts.push(`ENGINE=${o.engine}`)
    if (o.charset) parts.push(`DEFAULT CHARSET=${o.charset}`)
    if (o.collation) parts.push(`COLLATE=${o.collation}`)
    if (o.autoIncrement && o.autoIncrement > 1) parts.push(`AUTO_INCREMENT=${o.autoIncrement}`)
    if (o.rowFormat && o.rowFormat.toUpperCase() !== 'DEFAULT') parts.push(`ROW_FORMAT=${o.rowFormat.toUpperCase()}`)
    if (o.comment) parts.push(`COMMENT=${this.quoteString(o.comment)}`)
    let clause = parts.length ? ' ' + parts.join(' ') : ''
    clause += this.extraTableOptions(t)
    const partitions = this.partitionClause(o.partitioning)
    if (partitions) clause += `\n${partitions}`
    return clause
  }

  protected extraTableOptions(_t: TableStructure): string {
    return ''
  }

  protected dropCheckSpec(name: string): string {
    return `DROP CHECK ${this.quoteIdent(name)}`
  }

  /** MySQL allows one AUTO_INCREMENT column, numeric, leading some index (otherwise "Incorrect table definition"). */
  protected override validateTable(t: TableStructure): void {
    const auto = t.columns.filter((c) => c.autoIncrement)
    if (auto.length > 1) throw new Error(`Only one column can auto increment (${auto.map((c) => c.name).join(', ')})`)
    for (const c of auto) {
      if (!/INT|FLOAT|DOUBLE|REAL|DEC|NUMERIC/i.test(c.dataType || c.fullType)) throw new Error(`Auto increment needs a numeric column ("${c.name}" is ${c.fullType})`)
      if (!t.indexes.some((i) => i.columns[0] === c.name)) throw new Error(`Auto increment needs "${c.name}" to be a key: mark it as the primary key`)
    }
  }

  alterTable(original: TableStructure, targetTable: TableStructure): string[] {
    const target = this.prepareTable(targetTable)
    const table = this.qualify(original.ref)
    const specs: string[] = []
    const statements: string[] = []

    const fks = this.diffByName(original.foreignKeys, target.foreignKeys)
    if (fks.dropped.length) {
      statements.push(`ALTER TABLE ${table} ${fks.dropped.map((f) => `DROP FOREIGN KEY ${this.quoteIdent(f.name)}`).join(', ')}`)
    }

    const idx = this.diffByName(original.indexes, target.indexes)
    for (const i of idx.dropped) specs.push(i.type === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${this.quoteIdent(i.name)}`)

    const checks = this.diffByName(original.checks, target.checks)
    for (const c of checks.dropped) specs.push(this.dropCheckSpec(c.name))

    const cols = this.diffColumns(original, target)
    for (const c of cols.dropped) specs.push(`DROP COLUMN ${this.quoteIdent(c.name)}`)

    // Column positions: emit FIRST/AFTER whenever the predecessor changed.
    const originalOrder = original.columns.map((c) => c.name)
    target.columns.forEach((col, i) => {
      const prev = i === 0 ? null : target.columns[i - 1].name
      const position = prev === null ? ' FIRST' : ` AFTER ${this.quoteIdent(prev)}`
      const sourceName = col.originalName ?? col.name
      const isAdded = cols.added.includes(col)
      if (isAdded) {
        specs.push(`ADD COLUMN ${this.columnDefinition(col)}${position}`)
        return
      }
      const origIndex = originalOrder.indexOf(sourceName)
      const origPrev = origIndex <= 0 ? null : originalOrder[origIndex - 1]
      const prevSource = i === 0 ? null : (target.columns[i - 1].originalName ?? target.columns[i - 1].name)
      const moved = origPrev !== prevSource
      const changed = cols.changed.some((c) => c.after === col)
      if (changed || moved) {
        specs.push(`CHANGE COLUMN ${this.quoteIdent(sourceName)} ${this.columnDefinition(col)}${moved ? position : ''}`)
      }
    })

    for (const i of idx.added) specs.push(`ADD ${this.indexDefinition(i)}`)
    for (const c of checks.added) specs.push(`ADD ${this.checkClause(c)}`)

    const o1 = original.options
    const o2 = target.options
    if (o2.engine && o2.engine !== o1.engine) specs.push(`ENGINE=${o2.engine}`)
    if (o2.collation && o2.collation !== o1.collation) {
      specs.push(o2.charset ? `DEFAULT CHARSET=${o2.charset} COLLATE=${o2.collation}` : `COLLATE=${o2.collation}`)
    }
    if ((o2.comment ?? '') !== (o1.comment ?? '')) specs.push(`COMMENT=${this.quoteString(o2.comment ?? '')}`)
    if (o2.autoIncrement && o2.autoIncrement !== o1.autoIncrement) specs.push(`AUTO_INCREMENT=${o2.autoIncrement}`)
    if (o2.rowFormat && o2.rowFormat !== o1.rowFormat) specs.push(`ROW_FORMAT=${o2.rowFormat}`)

    if (specs.length) statements.push(`ALTER TABLE ${table}\n  ${specs.join(',\n  ')}`)
    if (fks.added.length) {
      statements.push(`ALTER TABLE ${table} ${fks.added.map((f) => `ADD ${this.foreignKeyClause(f, target.ref)}`).join(', ')}`)
    }
    statements.push(...this.alterPartitions(table, original.options.partitioning, target.options.partitioning))
    if (target.ref.name !== original.ref.name) {
      statements.push(`RENAME TABLE ${table} TO ${this.qualify(target.ref)}`)
    }
    return statements
  }

  private partitionDefinition(p: Partitioning['partitions'][number]): string {
    const bound = p.bound.trim()
    return `PARTITION ${this.quoteIdent(p.name)}${bound ? ` VALUES ${bound}` : ''}${p.comment ? ` COMMENT = ${this.quoteString(p.comment)}` : ''}`
  }

  /** PARTITION BY clause, or '' when the table is not partitioned. */
  partitionClause(p: Partitioning | undefined): string {
    if (!p) return ''
    let clause = `PARTITION BY ${p.method} (${p.expression.trim()})`
    const hashLike = /HASH|KEY/.test(p.method)
    if (hashLike && !p.partitions.length && p.count) clause += ` PARTITIONS ${p.count}`
    if (p.partitions.length) clause += `\n(${p.partitions.map((x) => this.partitionDefinition(x)).join(',\n ')})`
    return clause
  }

  /** Minimal partition changes: drop/add when the scheme is unchanged, full re-partition otherwise. */
  protected alterPartitions(table: string, before: Partitioning | undefined, after: Partitioning | undefined): string[] {
    if (!before && !after) return []
    if (JSON.stringify(before) === JSON.stringify(after)) return []
    if (!after) return [`ALTER TABLE ${table} REMOVE PARTITIONING`]
    const sameScheme =
      before &&
      before.method === after.method &&
      before.expression.trim() === after.expression.trim() &&
      (before.count ?? 0) === (after.count ?? 0) &&
      !/HASH|KEY/.test(after.method)
    if (!sameScheme) return [`ALTER TABLE ${table} ${this.partitionClause(after)}`]
    const old = new Map(before.partitions.map((p) => [p.name, p]))
    const kept = after.partitions.filter((p) => old.has(p.name))
    const boundChanged = kept.some((p) => old.get(p.name)!.bound.trim() !== p.bound.trim() || (old.get(p.name)!.comment ?? '') !== (p.comment ?? ''))
    // New partitions may only be appended after the existing ones (RANGE/LIST rules).
    const appendedOnly = after.partitions.slice(0, kept.length).every((p) => old.has(p.name))
    if (boundChanged || !appendedOnly) return [`ALTER TABLE ${table} ${this.partitionClause(after)}`]
    const out: string[] = []
    const dropped = before.partitions.filter((p) => !after.partitions.some((x) => x.name === p.name))
    if (dropped.length) out.push(`ALTER TABLE ${table} DROP PARTITION ${dropped.map((p) => this.quoteIdent(p.name)).join(', ')}`)
    const added = after.partitions.filter((p) => !old.has(p.name))
    if (added.length) out.push(`ALTER TABLE ${table} ADD PARTITION (${added.map((p) => this.partitionDefinition(p)).join(', ')})`)
    return out
  }

  bulkAlter(ref: DbObjectRef, ops: BulkTableOperations): string[] {
    const table = this.qualify(ref)
    const specs: string[] = []
    if (ops.engine) specs.push(`ENGINE=${ops.engine}`)
    if (ops.collation) {
      const cs = ops.charset ? `CHARACTER SET ${ops.charset} ` : ''
      specs.push(ops.convertData ? `CONVERT TO ${cs}COLLATE ${ops.collation}` : `DEFAULT ${cs}COLLATE ${ops.collation}`)
    }
    if (ops.rowFormat) specs.push(`ROW_FORMAT=${ops.rowFormat}`)
    if (ops.resetAutoIncrement) specs.push('AUTO_INCREMENT=1')
    const out = specs.length ? [`ALTER TABLE ${table} ${specs.join(', ')}`] : []
    if (ops.moveTo && ops.moveTo !== ref.database) {
      out.push(`RENAME TABLE ${table} TO ${this.qualify({ ...ref, database: ops.moveTo })}`)
    }
    return out
  }

  override dropObject(ref: DbObjectRef): string {
    if (ref.kind === 'database' || ref.kind === 'schema') return `DROP DATABASE ${this.quoteIdent(ref.name)}`
    return super.dropObject(ref)
  }

  renameObject(ref: DbObjectRef, newName: string): string[] {
    if (ref.kind === 'table' || ref.kind === 'view') {
      return [`RENAME TABLE ${this.qualify(ref)} TO ${this.qualify({ ...ref, name: newName })}`]
    }
    if (ref.kind === 'event') return [`ALTER EVENT ${this.qualify(ref)} RENAME TO ${this.qualify({ ...ref, name: newName })}`]
    throw new Error(`Renaming ${ref.kind} objects is not supported by MySQL`)
  }

  duplicateTable(ref: DbObjectRef, newName: string, withData: boolean): string[] {
    const target = this.qualify({ ...ref, name: newName })
    const out = [`CREATE TABLE ${target} LIKE ${this.qualify(ref)}`]
    if (withData) out.push(`INSERT INTO ${target} SELECT * FROM ${this.qualify(ref)}`)
    return out
  }

  maintenance(ref: DbObjectRef, action: 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'): string[] {
    if (action === 'vacuum') return []
    return [`${action.toUpperCase()} TABLE ${this.qualify(ref)}`]
  }

  useDatabase(database: string): string {
    return `USE ${this.quoteIdent(database)}`
  }

  override setEnabled(ref: DbObjectRef, enabled: boolean): string[] {
    if (ref.kind !== 'event') return []
    return [`ALTER EVENT ${this.qualify(ref)} ${enabled ? 'ENABLE' : 'DISABLE'}`]
  }

  triggerBodyTemplate(): string {
    return 'BEGIN\n  -- SET NEW.created_at = NOW();\nEND'
  }

  /** Header of CREATE TRIGGER (one event; FOR EACH ROW is the only granularity). */
  protected triggerCreate(target: TriggerDef, orReplace: boolean): string {
    const name = target.name.trim()
    if (!name) throw new Error('The trigger name is required')
    if (!target.table) throw new Error('Choose the table of the trigger')
    if (target.events.length !== 1) throw new Error('Choose exactly one event (INSERT, UPDATE or DELETE)')
    const table = this.qualify({ database: target.database, name: target.table, kind: 'table' })
    return `CREATE ${orReplace ? 'OR REPLACE ' : ''}TRIGGER ${this.qualify({ database: target.database, name, kind: 'trigger' })}\n${target.timing} ${target.events[0]} ON ${table}\nFOR EACH ROW\n${target.body.trim()}`
  }

  /** MySQL has no CREATE OR REPLACE TRIGGER: the old trigger is dropped first (DDL is not transactional). */
  triggerStatements(original: TriggerDef | null, target: TriggerDef): string[] {
    const create = this.triggerCreate(target, false)
    return original ? [`DROP TRIGGER IF EXISTS ${this.qualify({ database: original.database, name: original.name, kind: 'trigger' })}`, create] : [create]
  }

  createTemplate(kind: ObjectKind, ctx: TemplateContext): string {
    const q = (name: string): string => this.qualify({ database: ctx.database, name, kind })
    const routine = (body: string): string => `DELIMITER $$\n${body}$$\nDELIMITER ;\n`
    switch (kind) {
      case 'view':
        return `CREATE VIEW ${q('new_view')} AS\nSELECT 1 AS id;\n`
      case 'procedure':
        return routine(`CREATE PROCEDURE ${q('new_procedure')}(IN p_id INT)\nBEGIN\n  SELECT p_id;\nEND`)
      case 'function':
        return routine(`CREATE FUNCTION ${q('new_function')}(p_id INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN p_id;\nEND`)
      case 'trigger': {
        const table = ctx.table ?? 'table_name'
        const name = `${table.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_bi`
        return routine(`CREATE TRIGGER ${q(name)}\nBEFORE INSERT ON ${this.qualify({ database: ctx.database, name: table, kind: 'table' })}\nFOR EACH ROW\nBEGIN\n  -- SET NEW.created_at = NOW();\nEND`)
      }
      case 'event':
        return routine(`CREATE EVENT ${q('new_event')}\nON SCHEDULE EVERY 1 DAY\nDO\nBEGIN\n  -- DELETE FROM log WHERE created_at < NOW() - INTERVAL 30 DAY;\nEND`)
      default:
        throw new Error(`MySQL has no ${kind} objects`)
    }
  }

  protected account(user: ServerUser): string {
    return `${this.quoteString(user.name)}@${this.quoteString(user.host ?? '%')}`
  }

  userStatements(p: {
    action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'
    user: ServerUser
    password?: string
    privileges?: string[]
    on?: string
  }): string[] {
    const acct = this.account(p.user)
    const privs = (p.privileges?.length ? p.privileges : ['USAGE']).join(', ')
    switch (p.action) {
      case 'create':
        return [`CREATE USER ${acct}${p.password ? ` IDENTIFIED BY ${this.quoteString(p.password)}` : ''}`]
      case 'drop':
        return [`DROP USER ${acct}`]
      case 'password':
        return [`ALTER USER ${acct} IDENTIFIED BY ${this.quoteString(p.password ?? '')}`]
      case 'grant':
        return [`GRANT ${privs} ON ${p.on ?? '*.*'} TO ${acct}`]
      case 'revoke':
        return [`REVOKE ${privs} ON ${p.on ?? '*.*'} FROM ${acct}`]
    }
  }
}

export class MariaDbDialect extends MySqlDialect {
  protected override readonly engine: DbEngine = 'mariadb'
  protected override generatedNullability = false

  protected override buildTypes(): string[] {
    const types = MYSQL_TYPES.filter((t) => t !== 'JSON').concat(['JSON'])
    if (this.version >= 100700) types.push('UUID')
    if (this.version >= 101000) types.push('INET4', 'INET6')
    else if (this.version >= 100500) types.push('INET6')
    if (this.version >= 110700) types.push('VECTOR')
    return types
  }

  protected override dropCheckSpec(name: string): string {
    return `DROP CONSTRAINT ${this.quoteIdent(name)}`
  }

  protected override extraTableOptions(t: TableStructure): string {
    return t.options.systemVersioning ? ' WITH SYSTEM VERSIONING' : ''
  }

  override renameObject(ref: DbObjectRef, newName: string): string[] {
    if (ref.kind === 'sequence') return [`RENAME TABLE ${this.qualify(ref)} TO ${this.qualify({ ...ref, name: newName })}`]
    return super.renameObject(ref, newName)
  }

  override dropObject(ref: DbObjectRef): string {
    if (ref.kind === 'package') return `DROP PACKAGE ${this.qualify(ref)}`
    return super.dropObject(ref)
  }

  /** SETVAL makes `value` the last value returned (the next one is value + increment). */
  override setSequenceValue(ref: DbObjectRef, value: string): string[] {
    return [`SELECT SETVAL(${this.qualify(ref)}, ${this.sequenceValue(value)})`]
  }

  /** CREATE OR REPLACE TRIGGER keeps the swap atomic; a rename still drops the old name. */
  override triggerStatements(original: TriggerDef | null, target: TriggerDef): string[] {
    const create = this.triggerCreate(target, true)
    if (original && original.name !== target.name.trim()) {
      return [create, `DROP TRIGGER IF EXISTS ${this.qualify({ database: original.database, name: original.name, kind: 'trigger' })}`]
    }
    return [create]
  }

  override createTemplate(kind: ObjectKind, ctx: TemplateContext): string {
    if (kind === 'sequence') return `CREATE SEQUENCE ${this.qualify({ database: ctx.database, name: 'new_sequence', kind })} START WITH 1 INCREMENT BY 1;\n`
    return super.createTemplate(kind, ctx)
  }
}
