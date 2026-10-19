import type {
  CheckDef,
  ColumnDef,
  DbObjectInfo,
  DbObjectRef,
  ExceptionInfo,
  FkAction,
  ObjectDependency,
  SequenceInfo,
  ForeignKeyDef,
  IndexDef,
  IndexType,
  PartitionDef,
  PartitionMethod,
  Partitioning,
  ServerUser,
  TableStructure,
  UserPrivileges
} from '@shared/model'
import type { SchemaInspector } from '@domain/ports/database'
import type { HostInfo } from '@shared/workerApi'
import { bool, groupBy, num, optStr, queryObjects, str, type QueryFn } from '../common/queryHelpers'
import type { MySqlDialect } from './mysqlDialect'

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export class MySqlInspector implements SchemaInspector {
  constructor(
    private readonly query: QueryFn,
    private readonly dialect: MySqlDialect,
    private readonly engine: 'mysql' | 'mariadb',
    private readonly version: number
  ) {}

  private lit(v: string): string {
    return this.dialect.quoteString(v)
  }

  private get isMaria(): boolean {
    return this.engine === 'mariadb'
  }

  async listDatabases(): Promise<string[]> {
    const rows = await queryObjects(this.query, 'SHOW DATABASES')
    return rows.map((r) => str(Object.values(r)[0]))
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  async listObjects(database?: string): Promise<DbObjectInfo[]> {
    if (!database) return []
    const db = this.lit(database)
    const out: DbObjectInfo[] = []
    const tables = await queryObjects(
      this.query,
      `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, TABLE_COMMENT, TABLE_COLLATION,
              CREATE_TIME, UPDATE_TIME
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db} ORDER BY TABLE_NAME`
    )
    for (const t of tables) {
      const type = str(t.table_type).toUpperCase()
      const kind = type.includes('VIEW') ? 'view' : type === 'SEQUENCE' ? 'sequence' : 'table'
      out.push({
        database,
        name: str(t.table_name),
        kind,
        engine: optStr(t.engine),
        rows: num(t.table_rows),
        sizeBytes: (num(t.data_length) ?? 0) + (num(t.index_length) ?? 0) || undefined,
        comment: kind === 'view' ? undefined : optStr(t.table_comment),
        collation: optStr(t.table_collation),
        createdAt: optStr(t.create_time),
        updatedAt: optStr(t.update_time),
        system: SYSTEM_DATABASES.has(database.toLowerCase())
      })
    }
    const routines = await queryObjects(
      this.query,
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT, CREATED, LAST_ALTERED
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${db} ORDER BY ROUTINE_NAME`
    )
    for (const r of routines) {
      const type = str(r.routine_type).toUpperCase()
      const kind = type === 'FUNCTION' ? 'function' : type.startsWith('PACKAGE') ? 'package' : 'procedure'
      if (type === 'PACKAGE BODY') continue
      out.push({ database, name: str(r.routine_name), kind, comment: optStr(r.routine_comment), createdAt: optStr(r.created), updatedAt: optStr(r.last_altered) })
    }
    const triggers = await queryObjects(
      this.query,
      `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, CREATED FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${db} ORDER BY TRIGGER_NAME`
    )
    for (const t of triggers) out.push({ database, name: str(t.trigger_name), kind: 'trigger', table: str(t.event_object_table), createdAt: optStr(t.created) })
    const events = await queryObjects(
      this.query,
      `SELECT EVENT_NAME, EVENT_COMMENT, CREATED, LAST_ALTERED, STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${db} ORDER BY EVENT_NAME`
    ).catch(() => [])
    for (const e of events) {
      out.push({
        database,
        name: str(e.event_name),
        kind: 'event',
        comment: optStr(e.event_comment),
        createdAt: optStr(e.created),
        updatedAt: optStr(e.last_altered),
        inactive: str(e.status).toUpperCase() !== 'ENABLED' || undefined
      })
    }
    return out
  }

  /** MariaDB sequences; the value shown is the last one handed out (next value minus the increment). */
  async listSequences(database?: string): Promise<SequenceInfo[]> {
    if (!this.isMaria || !database) return []
    const names = await queryObjects(
      this.query,
      `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${this.lit(database)} AND TABLE_TYPE = 'SEQUENCE' ORDER BY 1`
    )
    if (!names.length) return []
    const sql = names
      .map((n) => `SELECT ${this.lit(str(n.table_name))} AS name, next_not_cached_value - increment AS value, increment FROM ${this.dialect.qualify({ database, name: str(n.table_name), kind: 'sequence' })}`)
      .join('\nUNION ALL\n')
    const values = new Map((await queryObjects(this.query, sql)).map((r) => [str(r.name), r]))
    return names.map((n) => {
      const v = values.get(str(n.table_name))
      return { name: str(n.table_name), value: v ? str(v.value) : '', increment: v ? num(v.increment) : undefined, comment: optStr(n.table_comment) }
    })
  }

  async listExceptions(): Promise<ExceptionInfo[]> {
    return []
  }

  /** What information_schema records: foreign keys, trigger tables and (MySQL 8.0.13+) view table usage. */
  async getDependencies(ref: DbObjectRef): Promise<ObjectDependency[]> {
    const db = this.lit(ref.database ?? '')
    const name = this.lit(ref.name)
    const out: ObjectDependency[] = []
    const viewUsage = (where: string): ReturnType<typeof queryObjects> =>
      this.isMaria || this.version < 80013
        ? Promise.resolve([])
        : queryObjects(this.query, `SELECT VIEW_NAME, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE WHERE ${where}`).catch(() => [])
    if (ref.kind === 'table' || ref.kind === 'view') {
      const fks = await queryObjects(
        this.query,
        `SELECT TABLE_NAME, REFERENCED_TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_SCHEMA = ${db} AND (TABLE_NAME = ${name} OR (REFERENCED_TABLE_SCHEMA = ${db} AND REFERENCED_TABLE_NAME = ${name}))`
      )
      const add = (dep: ObjectDependency, field?: string): void => {
        const existing = out.find((d) => d.direction === dep.direction && d.kind === dep.kind && d.name === dep.name)
        const target = existing ?? (out.push({ ...dep, fields: [] }), out[out.length - 1])
        if (field && !target.fields!.includes(field)) target.fields!.push(field)
      }
      for (const fk of fks) {
        if (str(fk.table_name) === ref.name) add({ direction: 'uses', kind: 'table', name: str(fk.referenced_table_name) }, str(fk.referenced_column_name))
        if (str(fk.referenced_table_name) === ref.name) add({ direction: 'usedBy', kind: 'table', name: str(fk.table_name) }, str(fk.column_name))
      }
      for (const v of await viewUsage(`VIEW_SCHEMA = ${db} AND VIEW_NAME = ${name}`)) add({ direction: 'uses', kind: 'table', name: str(v.table_name) })
      for (const v of await viewUsage(`TABLE_SCHEMA = ${db} AND TABLE_NAME = ${name}`)) add({ direction: 'usedBy', kind: 'view', name: str(v.view_name) })
      const triggers = await queryObjects(
        this.query,
        `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ${db} AND EVENT_OBJECT_TABLE = ${name}`
      )
      for (const t of triggers) add({ direction: 'usedBy', kind: 'trigger', name: str(t.trigger_name), table: ref.name })
    } else if (ref.kind === 'trigger' && ref.table) {
      out.push({ direction: 'uses', kind: 'table', name: ref.table })
    }
    return out.map((d) => (d.fields?.length ? d : { ...d, fields: undefined }))
  }

  /** CALL for procedures, SELECT f(…) for functions, with the declared parameters as placeholders. */
  async getRoutineCall(ref: DbObjectRef): Promise<string> {
    if (ref.kind !== 'function' && ref.kind !== 'procedure') throw new Error(`${ref.kind} objects cannot be executed`)
    const params = await queryObjects(
      this.query,
      `SELECT PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER FROM information_schema.PARAMETERS
        WHERE SPECIFIC_SCHEMA = ${this.lit(ref.database ?? '')} AND SPECIFIC_NAME = ${this.lit(ref.name)}
          AND ROUTINE_TYPE = ${this.lit(ref.kind.toUpperCase())} AND ORDINAL_POSITION > 0
        ORDER BY ORDINAL_POSITION`
    )
    const args = params.map((p) => {
      const mode = optStr(p.parameter_mode)
      const label = `${mode && mode !== 'IN' ? `${mode} ` : ''}${str(p.parameter_name)} ${str(p.dtd_identifier)}`
      return mode === 'OUT' || mode === 'INOUT' ? `@${str(p.parameter_name)} /* ${label} */` : `NULL /* ${label} */`
    })
    const name = this.dialect.qualify(ref)
    return ref.kind === 'procedure' ? `CALL ${name}(${args.join(', ')});` : `SELECT ${name}(${args.join(', ')});`
  }

  /** Normalizes information_schema COLUMN_DEFAULT into an SQL expression. */
  private defaultExpression(raw: string | undefined, dataType: string, extra: string, isNullDefault: boolean): string | null {
    if (raw === undefined) return isNullDefault ? 'NULL' : null
    if (this.isMaria && this.version >= 100207) return raw // already SQL (quoted literals, NULL, functions)
    if (/DEFAULT_GENERATED/i.test(extra)) {
      return /^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)(\(\d*\))?$/i.test(raw) ? raw : `(${raw})`
    }
    if (/^(CURRENT_TIMESTAMP|NOW)(\(\d*\))?$/i.test(raw)) return raw
    if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/i.test(dataType) && /^-?[\d.]+$|^b'[01]*'$/i.test(raw)) {
      return raw
    }
    return this.dialect.quoteString(raw)
  }

  async getTableStructure(ref: DbObjectRef): Promise<TableStructure> {
    const db = this.lit(ref.database ?? '')
    const tbl = this.lit(ref.name)
    const colRows = await queryObjects(
      this.query,
      `SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${tbl} ORDER BY ORDINAL_POSITION`
    )
    const columns: ColumnDef[] = colRows.map((c) => {
      const extra = str(c.extra)
      const columnType = str(c.column_type)
      const dataType = str(c.data_type).toUpperCase()
      const generationExpr = optStr(c.generation_expression)
      const isGenerated = /GENERATED/i.test(extra) && !!generationExpr
      const rawDefault = c.column_default === null ? undefined : str(c.column_default)
      const nullable = str(c.is_nullable) === 'YES'
      const enumMatch = /^(enum|set)\((.*)\)$/i.exec(columnType)
      return {
        name: str(c.column_name),
        originalName: str(c.column_name),
        dataType,
        fullType: columnType,
        length: num(c.character_maximum_length),
        precision: num(c.numeric_precision),
        scale: num(c.numeric_scale),
        unsigned: /unsigned/i.test(columnType),
        zerofill: /zerofill/i.test(columnType),
        nullable,
        defaultValue: isGenerated ? null : this.defaultExpression(rawDefault, dataType, extra, nullable && rawDefault === undefined && !/auto_increment/i.test(extra)),
        autoIncrement: /auto_increment/i.test(extra),
        generated: isGenerated ? { expression: generationExpr!, stored: /STORED|PERSISTENT/i.test(extra) } : undefined,
        invisible: /INVISIBLE/i.test(extra),
        onUpdate: /on update ([\w()]+)/i.exec(extra)?.[1],
        charset: optStr(c.character_set_name),
        collation: optStr(c.collation_name),
        comment: optStr(c.column_comment),
        enumValues: enumMatch ? parseEnumValues(enumMatch[2]) : undefined
      }
    })

    const hasExpression = !this.isMaria && this.version >= 80013
    const idxRows = await queryObjects(
      this.query,
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, INDEX_COMMENT${hasExpression ? ', EXPRESSION' : ''}
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${tbl} ORDER BY INDEX_NAME, SEQ_IN_INDEX`
    )
    const indexes: IndexDef[] = []
    for (const [name, parts] of groupBy(idxRows, (r) => str(r.index_name))) {
      const first = parts[0]
      const method = str(first.index_type).toUpperCase()
      let type: IndexType = 'INDEX'
      if (name === 'PRIMARY') type = 'PRIMARY'
      else if (method === 'FULLTEXT') type = 'FULLTEXT'
      else if (method === 'SPATIAL') type = 'SPATIAL'
      else if (method === 'VECTOR') type = 'VECTOR'
      else if (!bool(first.non_unique)) type = 'UNIQUE'
      const expressions = parts.map((p) => optStr(p.expression)).filter(Boolean)
      indexes.push({
        name,
        type,
        columns: parts.map((p) => str(p.column_name)).filter(Boolean),
        subParts: parts.map((p) => num(p.sub_part) ?? null),
        method: method === 'FULLTEXT' || method === 'SPATIAL' ? undefined : method,
        expression: expressions.length ? expressions.join(', ') : undefined,
        comment: optStr(first.index_comment)
      })
    }

    const fkRows = await queryObjects(
      this.query,
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.UPDATE_RULE, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ${db} AND k.TABLE_NAME = ${tbl} AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`
    )
    const foreignKeys: ForeignKeyDef[] = [...groupBy(fkRows, (r) => str(r.constraint_name))].map(([name, parts]) => ({
      name,
      columns: parts.map((p) => str(p.column_name)),
      refDatabase: str(parts[0].referenced_table_schema) === ref.database ? undefined : str(parts[0].referenced_table_schema),
      refTable: str(parts[0].referenced_table_name),
      refColumns: parts.map((p) => str(p.referenced_column_name)),
      onUpdate: str(parts[0].update_rule).toUpperCase() as FkAction,
      onDelete: str(parts[0].delete_rule).toUpperCase() as FkAction
    }))

    const checks: CheckDef[] = []
    const checkSql = this.isMaria
      ? `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ${db} AND TABLE_NAME = ${tbl} AND LEVEL = 'Table'`
      : `SELECT c.CONSTRAINT_NAME, c.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS c
           JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME
          WHERE t.TABLE_SCHEMA = ${db} AND t.TABLE_NAME = ${tbl} AND t.CONSTRAINT_TYPE = 'CHECK'`
    const supportsChecks = this.isMaria ? this.version >= 100222 : this.version >= 80016
    if (supportsChecks) {
      const rows = await queryObjects(this.query, checkSql).catch(() => [])
      for (const r of rows) checks.push({ name: str(r.constraint_name), expression: str(r.check_clause) })
    }

    const optRows = await queryObjects(
      this.query,
      `SELECT ENGINE, TABLE_COLLATION, AUTO_INCREMENT, ROW_FORMAT, TABLE_COMMENT, CREATE_OPTIONS
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${tbl}`
    )
    const o = optRows[0] ?? {}
    let createSql = ''
    try {
      createSql = await this.getObjectDDL({ ...ref, kind: 'table' })
    } catch {
      // Missing privileges: options below fall back to information_schema values.
    }
    const charset = /DEFAULT CHARSET=(\w+)/i.exec(createSql)?.[1]
    const partitioning = /PARTITION BY/i.test(createSql) || /partitioned/i.test(str(o.create_options)) ? await this.readPartitions(db, tbl) : undefined
    return {
      ref: { ...ref, kind: 'table' },
      columns,
      indexes,
      foreignKeys,
      checks,
      options: {
        engine: optStr(o.engine),
        collation: optStr(o.table_collation),
        charset,
        autoIncrement: num(o.auto_increment),
        rowFormat: optStr(o.row_format),
        comment: optStr(o.table_comment),
        systemVersioning: /WITH SYSTEM VERSIONING/i.test(createSql),
        partitioning
      }
    }
  }

  /** Top-level partitions from information_schema (subpartitions are folded into their parent). */
  private async readPartitions(db: string, tbl: string): Promise<Partitioning | undefined> {
    const rows = await queryObjects(
      this.query,
      `SELECT PARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION, PARTITION_DESCRIPTION, PARTITION_COMMENT, TABLE_ROWS
         FROM information_schema.PARTITIONS
        WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${tbl} AND PARTITION_NAME IS NOT NULL
        ORDER BY PARTITION_ORDINAL_POSITION, SUBPARTITION_ORDINAL_POSITION`
    )
    if (!rows.length) return undefined
    const method = str(rows[0].partition_method).toUpperCase() as PartitionMethod
    const partitions: PartitionDef[] = []
    for (const r of rows) {
      const name = str(r.partition_name)
      if (partitions.some((p) => p.name === name)) continue
      const desc = str(r.partition_description)
      let bound = ''
      if (method.startsWith('RANGE')) bound = desc.toUpperCase() === 'MAXVALUE' ? 'LESS THAN MAXVALUE' : `LESS THAN (${desc})`
      else if (method.startsWith('LIST')) bound = `IN (${desc})`
      partitions.push({ name, bound, comment: optStr(r.partition_comment), rows: num(r.table_rows) })
    }
    return { method, expression: str(rows[0].partition_expression).replace(/`/g, ''), partitions }
  }

  async getObjectDDL(ref: DbObjectRef): Promise<string> {
    const target = this.dialect.qualify(ref)
    const keyword: Record<string, string> = {
      table: 'TABLE',
      view: 'VIEW',
      procedure: 'PROCEDURE',
      function: 'FUNCTION',
      trigger: 'TRIGGER',
      event: 'EVENT',
      sequence: 'SEQUENCE',
      package: 'PACKAGE',
      database: 'DATABASE'
    }
    const kw = keyword[ref.kind]
    if (!kw) throw new Error(`No DDL available for ${ref.kind}`)
    const target2 = ref.kind === 'database' ? this.dialect.quoteIdent(ref.name) : target
    const res = await this.query(`SHOW CREATE ${kw} ${target2}`)
    const row = res.rows[0]
    if (!row) throw new Error(`Object not found: ${ref.name}`)
    // Column holding the statement varies: "Create Table", "Create View", "Create Procedure", "SQL Original Statement"...
    const idx = res.columns.findIndex((c) => /^(create |sql original statement)/i.test(c.name))
    let ddl = str(row[idx >= 0 ? idx : 1])
    if (ref.kind === 'package') {
      const body = await this.query(`SHOW CREATE PACKAGE BODY ${target}`).catch(() => null)
      if (body?.rows[0]) {
        const bi = body.columns.findIndex((c) => /^create /i.test(c.name))
        ddl += `;\n\n${str(body.rows[0][bi >= 0 ? bi : 2])}`
      }
    }
    return ddl
  }

  getRoutineSource(ref: DbObjectRef): Promise<string> {
    return this.getObjectDDL(ref)
  }

  async listCollations(): Promise<{ charset: string; collation: string; isDefault: boolean }[]> {
    const rows = await queryObjects(this.query, 'SHOW COLLATION')
    return rows
      .filter((r) => r.charset !== null)
      .map((r) => ({ charset: str(r.charset), collation: str(r.collation), isDefault: str(r.default) === 'Yes' }))
  }

  async listEngines(): Promise<string[]> {
    const rows = await queryObjects(this.query, 'SHOW ENGINES')
    return rows.filter((r) => !/^NO|DISABLED$/i.test(str(r.support))).map((r) => str(r.engine))
  }

  async countRows(ref: DbObjectRef, where?: string): Promise<number> {
    const res = await this.query(`SELECT COUNT(*) FROM ${this.dialect.qualify(ref)}${where?.trim() ? ` WHERE ${where}` : ''}`)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async hostInfo(): Promise<HostInfo> {
    const [variables, status, processes, commandStats] = await Promise.all([
      this.query('SHOW GLOBAL VARIABLES'),
      this.query('SHOW GLOBAL STATUS'),
      this.query('SHOW FULL PROCESSLIST'),
      this.query("SHOW GLOBAL STATUS LIKE 'Com\\_%'")
    ])
    return { variables, status, processes, commandStats }
  }

  async killProcess(id: string | number, queryOnly: boolean): Promise<void> {
    await this.query(`KILL ${queryOnly ? 'QUERY ' : ''}${Number(id)}`)
  }

  async listUsers(): Promise<ServerUser[]> {
    const lockedCol = !this.isMaria && this.version >= 50706 ? ', account_locked' : ''
    const rows = await queryObjects(this.query, `SELECT User, Host${lockedCol} FROM mysql.user ORDER BY User, Host`)
    return rows.map((r) => ({ name: str(r.user), host: str(r.host), locked: str(r.account_locked) === 'Y', canLogin: true }))
  }

  async getUserPrivileges(user: ServerUser): Promise<UserPrivileges> {
    const res = await this.query(`SHOW GRANTS FOR ${this.lit(user.name)}@${this.lit(user.host ?? '%')}`)
    return { user, grants: res.rows.map((r) => str(r[0])) }
  }
}

/** Parses "'a','b''c'" into ['a', "b'c"]. */
export function parseEnumValues(list: string): string[] {
  const out: string[] = []
  const re = /'((?:[^']|'')*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list))) out.push(m[1].replace(/''/g, "'"))
  return out
}
