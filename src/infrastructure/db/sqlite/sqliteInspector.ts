import type {
  CheckDef,
  ColumnDef,
  DbObjectInfo,
  DbObjectRef,
  ExceptionInfo,
  FkAction,
  ForeignKeyDef,
  IndexDef,
  ObjectDependency,
  ObjectKind,
  SequenceInfo,
  ServerUser,
  TableStructure,
  TriggerDef,
  UserPrivileges
} from '@shared/model'
import type { SchemaInspector } from '@domain/ports/database'
import type { CollationInfo, HostInfo } from '@shared/workerApi'
import { splitType } from '@domain/sql/columnType'
import { parseSqliteTable } from '@domain/sql/sqliteTable'
import { parseSqliteTrigger } from '@domain/sql/sqliteTrigger'
import { groupBy, keyValueResult, num, optStr, queryObjects, type QueryFn, type Row } from '../common/queryHelpers'
import type { SqliteDialect } from './sqliteDialect'

/** Raw text of a catalog value (names and SQL keep their spaces, unlike `str`). */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
const fkAction = (v: unknown): FkAction => {
  const a = text(v).toUpperCase() as FkAction
  return FK_ACTIONS.includes(a) ? a : 'NO ACTION'
}

const EMPTY = { columns: [], rows: [], durationMs: 0 }

export class SqliteInspector implements SchemaInspector {
  constructor(
    private readonly query: QueryFn,
    private readonly dialect: SqliteDialect
  ) {}

  private lit(s: string): string {
    return this.dialect.quoteString(s)
  }

  /** "main".sqlite_master (sqlite_schema is only an alias since 3.33). */
  private master(database?: string): string {
    return `${this.dialect.quoteIdent(database || 'main')}.sqlite_master`
  }

  private rows(sql: string): Promise<Row[]> {
    return queryObjects(this.query, sql)
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")
    return rows.map((r) => text(r.name))
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  /** Like Firebird, the tree has no database level: refs carry no database unless one is attached. */
  async listObjects(database?: string): Promise<DbObjectInfo[]> {
    const rows = await this.rows(
      `SELECT type, name FROM ${this.master(database)}
        WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY type, name COLLATE NOCASE`
    )
    return rows.map((r) => ({ database: database && database !== 'main' ? database : undefined, name: text(r.name), kind: text(r.type) as ObjectKind }))
  }

  async getTableStructure(ref: DbObjectRef): Promise<TableStructure> {
    const db = ref.database || 'main'
    const t = this.lit(ref.name)
    const s = this.lit(db)
    const [defRows, colRows, idxRows, fkRows, depRows] = await Promise.all([
      this.rows(`SELECT sql FROM ${this.master(db)} WHERE type = 'table' AND name = ${t}`),
      this.rows(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(${t}, ${s}) ORDER BY cid`),
      this.rows(
        `SELECT il.seq AS iseq, il.name AS iname, il."unique" AS uq, il.origin, il.partial, ii.seqno, ii.cid, ii.name AS col, ii."desc" AS dsc, m.sql
           FROM pragma_index_list(${t}, ${s}) il
           JOIN pragma_index_xinfo(il.name, ${s}) ii ON ii."key" = 1
           LEFT JOIN ${this.master(db)} m ON m.type = 'index' AND m.name = il.name
          ORDER BY il.seq DESC, ii.seqno`
      ),
      this.rows(`SELECT id, seq, "table" AS ref_table, "from" AS col, "to" AS ref_col, on_update, on_delete FROM pragma_foreign_key_list(${t}, ${s}) ORDER BY id, seq`),
      this.rows(
        `SELECT type, name, sql FROM ${this.master(db)}
          WHERE sql IS NOT NULL AND ((type = 'trigger' AND tbl_name = ${t} COLLATE NOCASE)
             OR (type = 'view' AND instr(lower(sql), lower(${t})) > 0))`
      )
    ])
    const ddl = text(defRows[0]?.sql)
    if (!ddl) throw new Error(`Table not found: ${ref.name}`)
    const details = parseSqliteTable(ddl)

    const columns: ColumnDef[] = colRows
      .filter((r) => num(r.hidden) !== 1)
      .map((r) => {
        const name = text(r.name)
        const fullType = text(r.type)
        const { base, args } = splitType(fullType)
        const [a, b] = args.trim() ? args.split(',').map((x) => Number(x.trim())) : []
        const info = details.columns.get(name)
        const hidden = num(r.hidden) ?? 0
        const generated = hidden === 2 || hidden === 3 ? (info?.generated ?? { expression: '', stored: hidden === 3 }) : undefined
        const numeric = /DEC|NUM/i.test(base)
        return {
          name,
          originalName: name,
          dataType: base.toUpperCase(),
          fullType,
          length: !numeric && Number.isFinite(a) ? a : undefined,
          precision: numeric && Number.isFinite(a) ? a : undefined,
          scale: numeric && Number.isFinite(b) ? b : undefined,
          nullable: num(r.nn) !== 1,
          defaultValue: r.dflt === null || r.dflt === undefined ? null : text(r.dflt),
          autoIncrement: info?.autoIncrement || undefined,
          generated,
          collation: info?.collation
        } satisfies ColumnDef
      })

    const indexes: IndexDef[] = []
    const pkCols = colRows.filter((r) => (num(r.pk) ?? 0) > 0).sort((x, y) => (num(x.pk) ?? 0) - (num(y.pk) ?? 0))
    if (pkCols.length) indexes.push({ name: 'PRIMARY', type: 'PRIMARY', columns: pkCols.map((r) => text(r.name)), constraint: true })
    for (const [name, parts] of groupBy(idxRows, (r) => text(r.iname))) {
      const first = parts[0]
      const origin = text(first.origin)
      if (origin === 'pk') continue
      const sql = text(first.sql)
      const exprCols = parts.some((p) => num(p.cid) === -2)
      indexes.push({
        name,
        type: num(first.uq) === 1 ? 'UNIQUE' : 'INDEX',
        columns: exprCols ? [] : parts.map((p) => text(p.col)),
        expression: exprCols ? indexExpression(sql) : undefined,
        condition: num(first.partial) === 1 ? (/\bWHERE\b([\s\S]*)$/i.exec(sql)?.[1].trim() ?? undefined) : undefined,
        descending: parts.every((p) => num(p.dsc) === 1) || undefined,
        // UNIQUE table/column constraints are backed by automatic indexes and rebuilt with the table.
        constraint: origin === 'u' || undefined
      })
    }

    const foreignKeys: ForeignKeyDef[] = [...groupBy(fkRows, (r) => text(r.id)).values()].map((parts) => ({
      name: `fk_${text(parts[0].id)}`,
      columns: parts.map((p) => text(p.col)),
      refTable: text(parts[0].ref_table),
      refColumns: parts.map((p) => text(p.ref_col)).filter(Boolean),
      onUpdate: fkAction(parts[0].on_update),
      onDelete: fkAction(parts[0].on_delete)
    }))

    const checks: CheckDef[] = details.checks.map((c, i) => ({ name: c.name || `check_${i + 1}`, expression: c.expression }))
    const nameRe = new RegExp(`(^|[^\\w$])["\`\\[]?${escapeRegExp(ref.name)}["\`\\]]?([^\\w$]|$)`, 'i')
    const dependents = depRows
      .filter((r) => text(r.type) === 'trigger' || nameRe.test(text(r.sql)))
      .map((r) => ({ kind: text(r.type) as 'trigger' | 'view', name: text(r.name), sql: text(r.sql) }))

    return {
      ref: { database: ref.database, name: ref.name, kind: 'table' },
      columns,
      indexes,
      foreignKeys,
      checks,
      options: {},
      dependents,
      sqliteOptions: details.withoutRowid || details.strict ? { withoutRowid: details.withoutRowid || undefined, strict: details.strict || undefined } : undefined
    }
  }

  async getObjectDDL(ref: DbObjectRef): Promise<string> {
    const db = ref.database || 'main'
    const n = this.lit(ref.name)
    if (ref.kind === 'table') {
      const rows = await this.rows(
        `SELECT sql FROM ${this.master(db)} WHERE sql IS NOT NULL AND (name = ${n} OR (type IN ('index', 'trigger') AND tbl_name = ${n}))
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
      )
      if (!rows.length) throw new Error(`Table not found: ${ref.name}`)
      return rows.map((r) => `${text(r.sql).trim()};`).join('\n\n')
    }
    const rows = await this.rows(`SELECT sql FROM ${this.master(db)} WHERE name = ${n}`)
    if (!rows.length) throw new Error(`${ref.kind} not found: ${ref.name}`)
    return `${text(rows[0].sql).trim()};`
  }

  getRoutineSource(ref: DbObjectRef): Promise<string> {
    return this.getObjectDDL(ref)
  }

  async listCollations(): Promise<CollationInfo[]> {
    const rows = await this.rows('SELECT name FROM pragma_collation_list ORDER BY name')
    return rows.map((r) => ({ charset: '', collation: text(r.name), isDefault: text(r.name) === 'BINARY' }))
  }

  async listEngines(): Promise<string[]> {
    return []
  }

  async countRows(ref: DbObjectRef, where?: string): Promise<number> {
    const r = await this.query(`SELECT COUNT(*) FROM ${this.dialect.qualify(ref)}${where?.trim() ? ` WHERE ${where}` : ''}`)
    return Number(r.rows[0]?.[0] ?? 0)
  }

  async hostInfo(): Promise<HostInfo> {
    const pragmas = ['page_size', 'page_count', 'freelist_count', 'journal_mode', 'encoding', 'user_version', 'application_id', 'auto_vacuum', 'foreign_keys', 'busy_timeout', 'cache_size', 'synchronous']
    const r = await this.query(`SELECT sqlite_version() AS sqlite_version, ${pragmas.map((p) => `(SELECT * FROM pragma_${p}) AS ${p}`).join(', ')}`)
    const variables = keyValueResult(r.columns.map((c, i) => [c.name, r.rows[0]?.[i] ?? null]))
    const options = await this.query('SELECT compile_options AS "Compile option" FROM pragma_compile_options')
    return { variables, status: options, processes: EMPTY }
  }

  async killProcess(): Promise<void> {
    throw new Error('SQLite has no server processes')
  }

  async listUsers(): Promise<ServerUser[]> {
    return []
  }

  async getUserPrivileges(): Promise<UserPrivileges> {
    throw new Error('SQLite has no users or privileges')
  }

  async listSequences(): Promise<SequenceInfo[]> {
    return []
  }

  async listExceptions(): Promise<ExceptionInfo[]> {
    return []
  }

  /**
   * SQLite keeps no dependency catalog: foreign keys come from the pragmas, triggers from tbl_name,
   * and views/trigger bodies are matched by name.
   */
  async getDependencies(ref: DbObjectRef): Promise<ObjectDependency[]> {
    const db = ref.database || 'main'
    const n = this.lit(ref.name)
    const all = await this.rows(`SELECT type, name, tbl_name, sql FROM ${this.master(db)} WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    const self = all.find((r) => text(r.name).toLowerCase() === ref.name.toLowerCase())
    const mentions = (sql: string, name: string): boolean =>
      new RegExp(`(^|[^\\w$])["\`\\[]?${escapeRegExp(name)}["\`\\]]?([^\\w$]|$)`, 'i').test(sql.replace(/'(?:[^']|'')*'/g, "''"))
    const out: ObjectDependency[] = []

    if (ref.kind === 'table') {
      const fks = await this.rows(`SELECT "table" AS t, group_concat("from", ', ') AS cols FROM pragma_foreign_key_list(${n}, ${this.lit(db)}) GROUP BY id`)
      for (const f of fks) out.push({ direction: 'uses', kind: 'table', name: text(f.t), fields: text(f.cols).split(', ').filter(Boolean) })
      const refs = await this.rows(
        `SELECT m.name AS t, group_concat(f."from", ', ') AS cols FROM ${this.master(db)} m JOIN pragma_foreign_key_list(m.name, ${this.lit(db)}) f
          WHERE m.type = 'table' AND f."table" = ${n} COLLATE NOCASE GROUP BY m.name, f.id`
      )
      for (const f of refs) out.push({ direction: 'usedBy', kind: 'table', name: text(f.t), fields: text(f.cols).split(', ').filter(Boolean) })
    }
    if (ref.kind === 'view' || ref.kind === 'trigger') {
      const sql = text(self?.sql)
      for (const r of all) {
        const name = text(r.name)
        if (name.toLowerCase() === ref.name.toLowerCase() || text(r.type) === 'trigger') continue
        if (mentions(sql, name)) out.push({ direction: 'uses', kind: text(r.type) as ObjectKind, name })
      }
    }
    for (const r of all) {
      const name = text(r.name)
      if (name.toLowerCase() === ref.name.toLowerCase()) continue
      const type = text(r.type)
      if (type === 'trigger') {
        if (text(r.tbl_name).toLowerCase() === ref.name.toLowerCase()) out.push({ direction: 'usedBy', kind: 'trigger', name, table: text(r.tbl_name) })
        else if (ref.kind !== 'trigger' && mentions(text(r.sql), ref.name)) out.push({ direction: 'usedBy', kind: 'trigger', name, table: text(r.tbl_name) })
      } else if (type === 'view' && ref.kind !== 'trigger' && mentions(text(r.sql), ref.name)) {
        out.push({ direction: 'usedBy', kind: 'view', name })
      }
    }
    return out
  }

  async getRoutineCall(ref: DbObjectRef): Promise<string> {
    throw new Error(`${ref.kind} objects cannot be executed in SQLite`)
  }

  async getTrigger(ref: DbObjectRef): Promise<TriggerDef> {
    const db = ref.database || 'main'
    const rows = await this.rows(`SELECT tbl_name, sql FROM ${this.master(db)} WHERE type = 'trigger' AND name = ${this.lit(ref.name)}`)
    const r = rows[0]
    if (!r) throw new Error(`Trigger not found: ${ref.name}`)
    const sql = text(r.sql)
    const parsed = parseSqliteTrigger(sql)
    const base = { name: ref.name, database: ref.database, table: text(r.tbl_name), active: true }
    if (!parsed) return { ...base, timing: 'BEFORE', events: [], body: sql, editable: false, note: 'This trigger could not be read into the form; edit it in the Source tab.' }
    return {
      ...base,
      table: parsed.table,
      timing: parsed.timing,
      events: [parsed.event],
      when: parsed.when,
      body: parsed.body,
      editable: !parsed.updateOf,
      note: parsed.updateOf ? `UPDATE OF ${parsed.updateOf} triggers can only be edited in the Source tab.` : undefined
    }
  }
}

/** Expression of an expression index: the text inside ON table ( … ). */
function indexExpression(sql: string): string | undefined {
  const m = /\bON\s+\S+\s*\(([\s\S]*)\)\s*(?:WHERE\b[\s\S]*)?$/i.exec(sql)
  return optStr(m?.[1]?.trim() ?? null)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
