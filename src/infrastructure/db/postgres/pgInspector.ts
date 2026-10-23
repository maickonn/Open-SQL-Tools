import type {
  CheckDef,
  ColumnDef,
  DbObjectInfo,
  DbObjectRef,
  ExceptionInfo,
  FkAction,
  ObjectDependency,
  SequenceInfo,
  TriggerDef,
  TriggerEvent,
  ForeignKeyDef,
  IndexDef,
  ObjectKind,
  PartitionMethod,
  Partitioning,
  ServerUser,
  TableStructure,
  UserPrivileges
} from '@shared/model'
import type { CatalogColumn, CatalogRoutine } from '@shared/model'
import type { SchemaInspector } from '@domain/ports/database'
import type { CollationInfo, HostInfo } from '@shared/workerApi'
import { bool, keyValueResult, num, optStr, queryObjects, str, type QueryFn } from '../common/queryHelpers'
import type { PgDialect } from './pgDialect'

const FK_ACTIONS: Record<string, FkAction> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
/** Unit separator used to aggregate lists without array parsing. */
const SEP = '\u001f'

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

/** Splits "a integer, b numeric(10, 2)" at top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of args) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export class PgInspector implements SchemaInspector {
  constructor(
    private readonly query: QueryFn,
    private readonly dialect: PgDialect,
    /** Switches the metadata connection to another database (PostgreSQL needs a reconnect). */
    private readonly ensureDatabase: (database?: string) => Promise<void>
  ) {}

  private lit(v: string): string {
    return this.dialect.quoteString(v)
  }

  /** regclass literal for a schema-qualified relation. */
  private regclass(ref: DbObjectRef): string {
    return `${this.lit(this.dialect.qualify({ ...ref, args: undefined }))}::regclass`
  }

  async columnSources(columns: { tableOid: number; columnNum: number }[]): Promise<({ schema: string; table: string; column: string } | null)[]> {
    if (!columns.length) return []
    const pairs = columns.map((c) => `(${Math.trunc(c.tableOid)}, ${Math.trunc(c.columnNum)})`).join(', ')
    const rows = await queryObjects(
      this.query,
      `SELECT a.attrelid AS oid, a.attnum AS num, n.nspname AS schema, c.relname AS tbl, a.attname AS col
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE (a.attrelid, a.attnum) IN (${pairs})`
    )
    const found = new Map(rows.map((r) => [`${num(r.oid)}:${num(r.num)}`, { schema: str(r.schema), table: str(r.tbl), column: str(r.col) }]))
    return columns.map((c) => found.get(`${c.tableOid}:${c.columnNum}`) ?? null)
  }

  async listDatabases(): Promise<string[]> {
    const rows = await queryObjects(this.query, 'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname')
    return rows.map((r) => str(r.datname))
  }

  async listSchemas(database?: string): Promise<string[]> {
    await this.ensureDatabase(database)
    const rows = await queryObjects(
      this.query,
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%'
        ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname`
    )
    return rows.map((r) => str(r.nspname))
  }

  async listObjects(database?: string, schema?: string): Promise<DbObjectInfo[]> {
    await this.ensureDatabase(database)
    if (!schema) return []
    const ns = this.lit(schema)
    const system = SYSTEM_SCHEMAS.has(schema)
    // Relations, routines, triggers and types in a single round trip.
    const rows = await queryObjects(
      this.query,
      `SELECT * FROM (
         SELECT 0 AS grp, 'rel_' || c.relkind::text AS kind, c.relname::text AS name, NULL::text AS args, NULL::text AS tbl,
                c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS size, obj_description(c.oid, 'pg_class') AS comment, NULL::boolean AS off
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${ns} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         UNION ALL
         SELECT 1, 'proc_' || p.prokind::text, p.proname::text, pg_get_function_identity_arguments(p.oid), NULL, NULL, NULL, obj_description(p.oid, 'pg_proc'), NULL
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ${ns} AND p.prokind IN ('f', 'p')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         UNION ALL
         SELECT 2, 'trigger', t.tgname::text, NULL, c.relname::text, NULL, NULL, NULL, t.tgenabled = 'D'
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${ns} AND NOT t.tgisinternal
         UNION ALL
         SELECT 3, 'type_' || t.typtype::text, t.typname::text, NULL, NULL, NULL, NULL, NULL, NULL
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = ${ns} AND (t.typtype IN ('d', 'e', 'r', 'm')
                OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
       ) o
       ORDER BY grp, name COLLATE "C", args`
    )
    const relKinds: Record<string, ObjectKind> = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'materialized_view', S: 'sequence' }
    const out: DbObjectInfo[] = []
    for (const r of rows) {
      const tag = str(r.kind)
      const name = str(r.name)
      if (tag.startsWith('rel_')) {
        const kind = relKinds[tag.slice(4)] ?? 'table'
        const count = num(r.rows)
        out.push({
          database,
          schema,
          name,
          kind,
          rows: kind === 'table' || kind === 'materialized_view' ? (count !== undefined && count >= 0 ? count : undefined) : undefined,
          sizeBytes: num(r.size),
          comment: optStr(r.comment),
          system
        })
      } else if (tag.startsWith('proc_')) {
        out.push({ database, schema, name, args: str(r.args), kind: tag === 'proc_p' ? 'procedure' : 'function', comment: optStr(r.comment), system })
      } else if (tag === 'trigger') {
        out.push({ database, schema, name, kind: 'trigger', table: str(r.tbl), system, inactive: bool(r.off) || undefined })
      } else {
        out.push({ database, schema, name, kind: tag === 'type_d' ? 'domain' : 'type', system })
      }
    }
    return out
  }

  async listColumns(database?: string, schema?: string): Promise<CatalogColumn[]> {
    await this.ensureDatabase(database)
    if (!schema) return []
    const rows = await queryObjects(
      this.query,
      `SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk,
              col_description(c.oid, a.attnum) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = ${this.lit(schema)} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY c.relname, a.attnum`
    )
    return rows.map((r) => ({ table: str(r.tbl), name: str(r.name), type: str(r.type), nullable: !bool(r.notnull), primaryKey: bool(r.pk), comment: optStr(r.comment) }))
  }

  async listRoutines(database?: string, schema?: string): Promise<CatalogRoutine[]> {
    await this.ensureDatabase(database)
    if (!schema) return []
    // Arguments as name|mode|type, in order (modes: i, o, b = inout, v = variadic, t = table column).
    const rows = await queryObjects(
      this.query,
      `SELECT p.proname AS name, p.prokind AS kind, pg_get_function_result(p.oid) AS result,
              (SELECT string_agg(COALESCE(p.proargnames[u.i], '') || '|' || COALESCE(p.proargmodes[u.i]::text, 'i') || '|' || format_type(u.t, NULL), '${SEP}' ORDER BY u.i)
                 FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS u(t, i)) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${this.lit(schema)} AND p.prokind IN ('f', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname`
    )
    const modes: Record<string, 'IN' | 'OUT' | 'INOUT'> = { i: 'IN', o: 'OUT', b: 'INOUT', v: 'IN' }
    return rows.map((r) => ({
      name: str(r.name),
      kind: str(r.kind) === 'p' ? ('procedure' as const) : ('function' as const),
      returns: optStr(r.result),
      params: str(r.args)
        .split(SEP)
        .filter(Boolean)
        .map((a) => a.split('|'))
        .filter(([, mode]) => mode !== 't')
        .map(([name, mode, type]) => ({ name, type, mode: modes[mode] }))
    }))
  }

  async getTableStructure(ref: DbObjectRef): Promise<TableStructure> {
    await this.ensureDatabase(ref.database)
    const rel = this.regclass(ref)
    const colRows = await queryObjects(
      this.query,
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS fulltype, t.typname, a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid) AS defexpr, a.attidentity, a.attgenerated,
              col_description(a.attrelid, a.attnum) AS comment,
              CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation,
              information_schema._pg_char_max_length(a.atttypid, a.atttypmod) AS charlen,
              information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS prec,
              information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS scale,
              CASE WHEN t.typtype = 'd' THEN t.typname END AS domain,
              (SELECT string_agg(e.enumlabel, '${SEP}' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enumvals
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`
    )
    const columns: ColumnDef[] = colRows.map((c) => {
      const gen = str(c.attgenerated)
      const ident = str(c.attidentity)
      const def = optStr(c.defexpr)
      const fullType = str(c.fulltype)
      return {
        name: str(c.attname),
        originalName: str(c.attname),
        dataType: str(c.typname).toUpperCase(),
        fullType,
        length: num(c.charlen),
        precision: num(c.prec),
        scale: num(c.scale),
        nullable: !bool(c.attnotnull),
        defaultValue: gen ? null : (def ?? null),
        autoIncrement: !!ident || /^nextval\(/i.test(def ?? ''),
        identity: ident === 'a' ? 'always' : ident === 'd' ? 'by_default' : undefined,
        generated: gen ? { expression: (def ?? '').replace(/^\((.*)\)$/s, '$1'), stored: gen === 's' } : undefined,
        collation: optStr(c.collation),
        comment: optStr(c.comment),
        domain: optStr(c.domain),
        enumValues: optStr(c.enumvals)?.split(SEP)
      }
    })

    const idxRows = await queryObjects(
      this.query,
      `SELECT i.relname, ix.indisprimary, ix.indisunique, am.amname,
              pg_get_expr(ix.indpred, ix.indrelid) AS pred,
              (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true), '${SEP}' ORDER BY k)
                 FROM generate_series(1, ix.indnkeyatts) k) AS cols,
              (SELECT bool_or(k = 0) FROM unnest(ix.indkey) k) AS hasexpr,
              EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u')) AS isconstraint,
              obj_description(i.oid, 'pg_class') AS comment
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = i.relam
        WHERE ix.indrelid = ${rel}
        ORDER BY ix.indisprimary DESC, i.relname`
    )
    const indexes: IndexDef[] = idxRows.map((r) => {
      const cols = str(r.cols).split(SEP).filter(Boolean)
      const hasExpr = bool(r.hasexpr)
      return {
        name: str(r.relname),
        type: bool(r.indisprimary) ? 'PRIMARY' : bool(r.indisunique) ? 'UNIQUE' : 'INDEX',
        columns: hasExpr ? [] : cols.map(unquotePg),
        expression: hasExpr ? cols.join(', ') : undefined,
        method: str(r.amname),
        condition: optStr(r.pred),
        constraint: bool(r.isconstraint),
        comment: optStr(r.comment)
      }
    })

    const fkRows = await queryObjects(
      this.query,
      `SELECT c.conname, rn.nspname AS refschema, rc.relname AS reftable, c.confupdtype, c.confdeltype,
              (SELECT string_agg(a.attname, '${SEP}' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
              (SELECT string_agg(a.attname, '${SEP}' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
         FROM pg_constraint c
         JOIN pg_class rc ON rc.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE c.conrelid = ${rel} AND c.contype = 'f' ORDER BY c.conname`
    )
    const foreignKeys: ForeignKeyDef[] = fkRows.map((r) => ({
      name: str(r.conname),
      columns: str(r.cols).split(SEP),
      refSchema: str(r.refschema),
      refTable: str(r.reftable),
      refColumns: str(r.refcols).split(SEP),
      onUpdate: FK_ACTIONS[str(r.confupdtype)] ?? 'NO ACTION',
      onDelete: FK_ACTIONS[str(r.confdeltype)] ?? 'NO ACTION'
    }))

    const ckRows = await queryObjects(
      this.query,
      `SELECT conname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint WHERE conrelid = ${rel} AND contype = 'c' ORDER BY conname`
    )
    const checks: CheckDef[] = ckRows.map((r) => ({ name: str(r.conname), expression: str(r.def).replace(/^CHECK\s*/i, '') }))

    const optRows = await queryObjects(
      this.query,
      `SELECT obj_description(c.oid, 'pg_class') AS comment, ts.spcname,
              CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey
         FROM pg_class c LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace WHERE c.oid = ${rel}`
    )
    const o = optRows[0] ?? {}
    let partitioning: Partitioning | undefined
    const key = /^(\w+)\s*\(([\s\S]*)\)$/.exec(str(o.partkey))
    if (key) {
      const children = await queryObjects(
        this.query,
        `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound, c.reltuples::bigint AS rows
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = ${rel} ORDER BY c.relname`
      )
      partitioning = {
        method: key[1].toUpperCase() as PartitionMethod,
        expression: key[2],
        partitions: children.map((c) => ({
          name: str(c.relname),
          bound: str(c.bound).replace(/^FOR VALUES\s+/i, ''),
          rows: (num(c.rows) ?? -1) >= 0 ? num(c.rows) : undefined
        }))
      }
    }
    return {
      ref: { ...ref, kind: 'table' },
      columns,
      indexes,
      foreignKeys,
      checks,
      options: { comment: optStr(o.comment), tablespace: optStr(o.spcname), partitioning }
    }
  }

  async getObjectDDL(ref: DbObjectRef): Promise<string> {
    await this.ensureDatabase(ref.database)
    switch (ref.kind) {
      case 'table': {
        const s = await this.getTableStructure(ref)
        return this.dialect.createTable(s).join(';\n\n') + ';'
      }
      case 'view':
      case 'materialized_view': {
        const r = await this.query(`SELECT pg_get_viewdef(${this.regclass(ref)}, true)`)
        const kw = ref.kind === 'view' ? 'CREATE OR REPLACE VIEW' : 'CREATE MATERIALIZED VIEW'
        return `${kw} ${this.dialect.qualify(ref)} AS\n${str(r.rows[0]?.[0]).trimEnd()}`
      }
      case 'function':
      case 'procedure': {
        const sig = this.lit(this.dialect.qualify(ref))
        const r = await this.query(`SELECT pg_get_functiondef(${sig}::regprocedure)`)
        return str(r.rows[0]?.[0])
      }
      case 'trigger': {
        const r = await this.query(
          `SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t WHERE t.tgname = ${this.lit(ref.name)}
             AND t.tgrelid = ${this.regclass({ ...ref, name: ref.table ?? '', kind: 'table' })}`
        )
        return str(r.rows[0]?.[0])
      }
      case 'sequence': {
        const rows = await queryObjects(
          this.query,
          `SELECT data_type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value
             FROM pg_sequences WHERE schemaname = ${this.lit(ref.schema ?? 'public')} AND sequencename = ${this.lit(ref.name)}`
        )
        const s = rows[0]
        if (!s) throw new Error(`Sequence not found: ${ref.name}`)
        return [
          `CREATE SEQUENCE ${this.dialect.qualify(ref)}`,
          `  AS ${str(s.data_type)}`,
          `  INCREMENT BY ${str(s.increment_by)}`,
          `  MINVALUE ${str(s.min_value)}`,
          `  MAXVALUE ${str(s.max_value)}`,
          `  START WITH ${str(s.start_value)}`,
          `  CACHE ${str(s.cache_size)}`,
          `  ${bool(s.cycle) ? 'CYCLE' : 'NO CYCLE'};`,
          s.last_value !== null ? `\nSELECT setval(${this.lit(this.dialect.qualify(ref))}, ${str(s.last_value)});` : ''
        ].join('\n')
      }
      case 'domain': {
        const rows = await queryObjects(
          this.query,
          `SELECT format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull, t.typdefault,
                  (SELECT string_agg(pg_get_constraintdef(c.oid, true), ' ') FROM pg_constraint c WHERE c.contypid = t.oid) AS checks
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = ${this.lit(ref.schema ?? 'public')} AND t.typname = ${this.lit(ref.name)}`
        )
        const d = rows[0]
        if (!d) throw new Error(`Domain not found: ${ref.name}`)
        return `CREATE DOMAIN ${this.dialect.qualify(ref)} AS ${str(d.base)}${d.typdefault ? ` DEFAULT ${str(d.typdefault)}` : ''}${bool(d.typnotnull) ? ' NOT NULL' : ''}${d.checks ? ` ${str(d.checks)}` : ''};`
      }
      case 'type': {
        const rows = await queryObjects(
          this.query,
          `SELECT t.typtype, (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
                  (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
                     FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = ${this.lit(ref.schema ?? 'public')} AND t.typname = ${this.lit(ref.name)}`
        )
        const t = rows[0]
        if (!t) throw new Error(`Type not found: ${ref.name}`)
        if (str(t.typtype) === 'e') return `CREATE TYPE ${this.dialect.qualify(ref)} AS ENUM (${str(t.labels)});`
        if (str(t.typtype) === 'c') return `CREATE TYPE ${this.dialect.qualify(ref)} AS (${str(t.attrs)});`
        return `-- Type ${ref.name} (${str(t.typtype)})`
      }
      case 'schema':
        return `CREATE SCHEMA ${this.dialect.quoteIdent(ref.name)};`
      case 'database':
        return `CREATE DATABASE ${this.dialect.quoteIdent(ref.name)};`
      default:
        throw new Error(`No DDL available for ${ref.kind}`)
    }
  }

  getRoutineSource(ref: DbObjectRef): Promise<string> {
    return this.getObjectDDL(ref)
  }

  async listSequences(database?: string, schema?: string): Promise<SequenceInfo[]> {
    await this.ensureDatabase(database)
    const rows = await queryObjects(
      this.query,
      `SELECT s.sequencename, s.last_value, s.increment_by, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_sequences s
         JOIN pg_namespace n ON n.nspname = s.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
        WHERE s.schemaname = ${this.lit(schema ?? 'public')}
        ORDER BY 1`
    )
    // last_value is NULL until nextval is called (or when the sequence is not readable).
    return rows.map((r) => ({ name: str(r.sequencename), schema, value: r.last_value === null ? '' : str(r.last_value), increment: num(r.increment_by), comment: optStr(r.comment) }))
  }

  async listExceptions(): Promise<ExceptionInfo[]> {
    return []
  }

  /**
   * pg_depend in both directions. Rows recorded on helper objects are attributed to their owner:
   * view rules (pg_rewrite) to the view, constraints and column defaults to their table.
   */
  async getDependencies(ref: DbObjectRef): Promise<ObjectDependency[]> {
    await this.ensureDatabase(ref.database)
    let self: string
    switch (ref.kind) {
      case 'table': case 'view': case 'materialized_view': case 'sequence':
        self = `SELECT 'pg_class'::regclass AS cls, ${this.regclass(ref)}::oid AS oid`
        break
      case 'function': case 'procedure':
        self = `SELECT 'pg_proc'::regclass AS cls, ${this.lit(this.dialect.qualify(ref))}::regprocedure::oid AS oid`
        break
      case 'type': case 'domain':
        self = `SELECT 'pg_type'::regclass AS cls, ${this.lit(this.dialect.qualify(ref))}::regtype::oid AS oid`
        break
      case 'trigger':
        self = `SELECT 'pg_trigger'::regclass AS cls, t.oid AS oid FROM pg_trigger t WHERE t.tgname = ${this.lit(ref.name)}
                  AND t.tgrelid = ${this.regclass({ ...ref, name: ref.table ?? '', kind: 'table' })}`
        break
      default:
        return []
    }
    const rows = await queryObjects(
      this.query,
      `WITH self AS (${self}),
       sources AS (
         SELECT cls, oid FROM self
         UNION ALL SELECT 'pg_rewrite'::regclass, r.oid FROM pg_rewrite r JOIN self ON self.cls = 'pg_class'::regclass AND r.ev_class = self.oid
         UNION ALL SELECT 'pg_constraint'::regclass, c.oid FROM pg_constraint c JOIN self ON self.cls = 'pg_class'::regclass AND c.conrelid = self.oid
         UNION ALL SELECT 'pg_attrdef'::regclass, a.oid FROM pg_attrdef a JOIN self ON self.cls = 'pg_class'::regclass AND a.adrelid = self.oid
       ),
       edges AS (
         SELECT 'uses' AS dir, d.refclassid AS cls, d.refobjid AS oid, d.refobjsubid AS sub
           FROM pg_depend d JOIN sources s ON d.classid = s.cls AND d.objid = s.oid
          WHERE d.deptype IN ('n', 'a')
         UNION ALL
         SELECT 'usedBy', d.classid, d.objid, 0
           FROM pg_depend d JOIN self s ON d.refclassid = s.cls AND d.refobjid = s.oid
          WHERE d.deptype IN ('n', 'a')
       ),
       owners AS (
         SELECT e.dir, e.sub, e.oid AS raw_oid,
                CASE WHEN e.cls IN ('pg_rewrite'::regclass, 'pg_constraint'::regclass, 'pg_attrdef'::regclass) THEN 'pg_class'::regclass ELSE e.cls END AS cls,
                CASE e.cls
                  WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = e.oid)
                  WHEN 'pg_constraint'::regclass THEN (SELECT NULLIF(conrelid, 0) FROM pg_constraint WHERE oid = e.oid)
                  WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = e.oid)
                  ELSE e.oid END AS oid
           FROM edges e
       )
       SELECT o.dir, i.type, i.schema,
              CASE o.cls
                WHEN 'pg_class'::regclass THEN (SELECT relname::text FROM pg_class WHERE oid = o.oid)
                WHEN 'pg_proc'::regclass THEN (SELECT proname::text FROM pg_proc WHERE oid = o.oid)
                WHEN 'pg_type'::regclass THEN (SELECT typname::text FROM pg_type WHERE oid = o.oid)
                WHEN 'pg_trigger'::regclass THEN (SELECT tgname::text FROM pg_trigger WHERE oid = o.oid)
              END AS name,
              CASE WHEN o.cls = 'pg_proc'::regclass THEN pg_get_function_identity_arguments(o.oid) END AS args,
              CASE WHEN o.cls = 'pg_trigger'::regclass THEN (SELECT c.relname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.oid = o.oid) END AS tbl,
              CASE WHEN o.dir = 'uses' AND o.sub > 0 AND o.cls = 'pg_class'::regclass
                   THEN (SELECT attname::text FROM pg_attribute WHERE attrelid = o.oid AND attnum = o.sub) END AS field
         FROM owners o
         CROSS JOIN LATERAL pg_identify_object(o.cls, o.oid, 0) i
        WHERE o.oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM self s WHERE s.cls = o.cls AND s.oid = o.oid)`
    )
    const kinds: Record<string, ObjectKind> = {
      table: 'table', view: 'view', 'materialized view': 'materialized_view', sequence: 'sequence', function: 'function',
      procedure: 'procedure', trigger: 'trigger', type: 'type', domain: 'domain', 'composite type': 'type'
    }
    const out = new Map<string, ObjectDependency>()
    for (const r of rows) {
      const kind = kinds[str(r.type)]
      const name = optStr(r.name)
      if (!kind || !name || SYSTEM_SCHEMAS.has(str(r.schema))) continue
      const direction = str(r.dir) as ObjectDependency['direction']
      const key = `${direction}|${kind}|${str(r.schema)}|${name}|${str(r.args)}`
      const entry = out.get(key) ?? { direction, kind, name, schema: optStr(r.schema), args: optStr(r.args) ?? (kind === 'function' || kind === 'procedure' ? '' : undefined), table: optStr(r.tbl), fields: [] }
      const field = optStr(r.field)
      if (field && !entry.fields!.includes(field)) entry.fields!.push(field)
      out.set(key, entry)
    }
    return [...out.values()].map((d) => (d.fields?.length ? d : { ...d, fields: undefined }))
  }

  /** Trigger plus its function body; tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD. */
  async getTrigger(ref: DbObjectRef): Promise<TriggerDef> {
    await this.ensureDatabase(ref.database)
    if (!ref.table) throw new Error('The owning table is required to read a PostgreSQL trigger')
    const rows = await queryObjects(
      this.query,
      `SELECT t.tgtype, t.tgenabled, t.tgnargs, t.tgconstraint <> 0 AS is_constraint, pg_get_triggerdef(t.oid) AS def,
              p.proname, pn.nspname AS fn_schema, p.prosrc, l.lanname
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE t.tgname = ${this.lit(ref.name)} AND t.tgrelid = ${this.regclass({ ...ref, name: ref.table, kind: 'table' })}`
    )
    const r = rows[0]
    if (!r) throw new Error(`Trigger not found: ${ref.name}`)
    const type = num(r.tgtype) ?? 0
    const events: TriggerEvent[] = []
    if (type & 4) events.push('INSERT')
    if (type & 16) events.push('UPDATE')
    if (type & 8) events.push('DELETE')
    if (type & 32) events.push('TRUNCATE')
    const def = str(r.def)
    const when = /\sWHEN \((.*)\) EXECUTE (?:FUNCTION|PROCEDURE)\s/s.exec(def)?.[1]
    const fnSchema = str(r.fn_schema)
    const unsupported =
      str(r.lanname) !== 'plpgsql' ? `The trigger function is written in ${str(r.lanname)}; edit it in the Source tab.`
        : (num(r.tgnargs) ?? 0) > 0 ? 'The trigger passes arguments to its function; edit it in the Source tab.'
          : bool(r.is_constraint) ? 'Constraint triggers can be edited in the Source tab.'
            : /\sUPDATE OF\s|\sREFERENCING\s/.test(def) ? 'UPDATE OF columns and transition tables can be edited in the Source tab.'
              : undefined
    return {
      name: ref.name,
      database: ref.database,
      schema: ref.schema,
      table: ref.table,
      timing: type & 64 ? 'INSTEAD OF' : type & 2 ? 'BEFORE' : 'AFTER',
      events,
      active: str(r.tgenabled) !== 'D',
      forEach: type & 1 ? 'ROW' : 'STATEMENT',
      when,
      functionName: fnSchema === (ref.schema ?? 'public') ? str(r.proname) : `${fnSchema}.${str(r.proname)}`,
      body: str(r.prosrc).replace(/^\n/, '').trimEnd(),
      editable: !unsupported,
      note: unsupported
    }
  }

  /** CALL for procedures, SELECT * FROM for functions; arguments come from the identity signature. */
  async getRoutineCall(ref: DbObjectRef): Promise<string> {
    if (ref.kind !== 'function' && ref.kind !== 'procedure') throw new Error(`${ref.kind} objects cannot be executed`)
    const name = this.dialect.qualify({ ...ref, args: undefined })
    const args = splitArgs(ref.args ?? '').map((a) => `NULL /* ${a} */`)
    return ref.kind === 'procedure' ? `CALL ${name}(${args.join(', ')});` : `SELECT * FROM ${name}(${args.join(', ')});`
  }

  async listCollations(): Promise<CollationInfo[]> {
    const rows = await queryObjects(
      this.query,
      // Only collations for the database encoding (or any encoding, -1) can be used in COLLATE.
      `SELECT collname, pg_encoding_to_char(collencoding) AS enc FROM pg_collation
        WHERE collencoding IN (-1, (SELECT encoding FROM pg_database WHERE datname = current_database()))
        ORDER BY collname`
    )
    return rows.map((r) => ({ charset: str(r.enc) || 'any', collation: str(r.collname), isDefault: str(r.collname) === 'default' }))
  }

  async listEngines(): Promise<string[]> {
    return []
  }

  async countRows(ref: DbObjectRef, where?: string): Promise<number> {
    await this.ensureDatabase(ref.database)
    const res = await this.query(`SELECT COUNT(*) FROM ${this.dialect.qualify(ref)}${where?.trim() ? ` WHERE ${where}` : ''}`)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async hostInfo(): Promise<HostInfo> {
    const variables = await this.query(
      'SELECT name AS "Variable", setting AS "Value", unit AS "Unit", category AS "Category", short_desc AS "Description" FROM pg_settings ORDER BY name'
    )
    const statRows = await queryObjects(this.query, 'SELECT * FROM pg_stat_database WHERE datname = current_database()')
    const status = keyValueResult(Object.entries(statRows[0] ?? {}).map(([k, v]) => [k, v]))
    const processes = await this.query(
      `SELECT pid AS "Id", usename AS "User", client_addr::text AS "Host", datname AS "db", application_name AS "Application",
              state AS "State", backend_start AS "Started", query_start AS "Query start",
              EXTRACT(EPOCH FROM (now() - query_start))::int AS "Time", wait_event_type AS "Wait", query AS "Info"
         FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY pid`
    )
    return { variables, status, processes }
  }

  async killProcess(id: string | number, queryOnly: boolean): Promise<void> {
    await this.query(`SELECT ${queryOnly ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${Number(id)})`)
  }

  async listUsers(): Promise<ServerUser[]> {
    const rows = await queryObjects(this.query, 'SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE \'pg\\_%\' ORDER BY rolname')
    return rows.map((r) => ({ name: str(r.rolname), superuser: bool(r.rolsuper), canLogin: bool(r.rolcanlogin) }))
  }

  async getUserPrivileges(user: ServerUser): Promise<UserPrivileges> {
    const role = this.lit(user.name)
    const memberships = await queryObjects(
      this.query,
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = ${role}`
    )
    const tables = await queryObjects(
      this.query,
      `SELECT table_schema, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants WHERE grantee = ${role}
        GROUP BY table_schema, table_name ORDER BY table_schema, table_name`
    )
    const grants = [
      ...memberships.map((m) => `GRANT ${this.dialect.quoteIdent(str(m.rolname))} TO ${this.dialect.quoteIdent(user.name)}`),
      ...tables.map(
        (t) =>
          `GRANT ${str(t.privs)} ON ${this.dialect.qualify({ schema: str(t.table_schema), name: str(t.table_name), kind: 'table' })} TO ${this.dialect.quoteIdent(user.name)}`
      )
    ]
    return { user, grants }
  }
}

function unquotePg(name: string): string {
  return /^".*"$/.test(name) ? name.slice(1, -1).replace(/""/g, '"') : name
}
