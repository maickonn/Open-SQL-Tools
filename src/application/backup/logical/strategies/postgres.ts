import type { DbObjectRef, TableStructure } from '@shared/model'
import { dependencyOrder } from '@domain/backup/dependencyOrder'
import { cell, coreStructure, queryRows, selectTables, writeRows, type BackupContext, type LogicalStrategy } from './types'

const USER_SCHEMA = (col: string): string =>
  `${col} NOT IN ('pg_catalog', 'information_schema') AND ${col} NOT LIKE 'pg\\_toast%' AND ${col} NOT LIKE 'pg\\_temp\\_%'`
const NOT_EXTENSION_MEMBER = (classTable: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = '${classTable}'::regclass AND e.objid = ${oid} AND e.deptype = 'e')`

/**
 * PostgreSQL, one database per file, in pg_dump's order: schemas, extensions, types and domains,
 * sequences, functions the tables need, tables without foreign keys or secondary indexes, data,
 * sequence values, indexes, foreign keys, remaining functions, views by dependency, materialized
 * views (refreshed at the end), triggers, owners and privileges. DDL is read with an empty
 * search_path, so every name in it is schema-qualified.
 */
export class PostgresStrategy implements LogicalStrategy {
  async prepare(ctx: BackupContext): Promise<void> {
    await ctx.aux.connection.run("SELECT pg_catalog.set_config('search_path', '', false)", null, { maxRows: 1, chunkSize: 1, direct: true })
  }

  async prologue(ctx: BackupContext): Promise<void> {
    const o = ctx.out
    await o.raw('SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\n')
    await o.raw("SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n")
    await o.raw("SELECT pg_catalog.set_config('search_path', '', false);\n")
    await o.raw('SET check_function_bodies = false;\nSET xmloption = content;\nSET client_min_messages = warning;\nSET row_security = off;\n\n')
  }

  async database(ctx: BackupContext, database: string): Promise<void> {
    const { out, aux, dialect: d, options: o } = ctx
    const ref = (schema: string, name: string, kind: DbObjectRef['kind'], extra?: Partial<DbObjectRef>): DbObjectRef => ({ database, schema, name, kind, ...extra })
    const lit = (s: string): string => d.literal(s)

    // Schemas
    const schemas = await queryRows(
      ctx,
      `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n
        WHERE ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_namespace', 'n.oid')} ORDER BY 1`
    )
    await out.section('Schemas')
    for (const s of schemas) {
      const name = cell(s.name)
      if (name !== 'public') await out.statement(`CREATE SCHEMA IF NOT EXISTS ${d.quoteIdent(name)}`)
    }

    // Relations, types and sequences are read up front: "drop existing objects" removes them before anything is created.
    const relations = await queryRows(
      ctx,
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition AND ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
        ORDER BY c.oid`
    )
    const tables = selectTables(
      ctx,
      database,
      relations.filter((r) => cell(r.kind) === 'r' || cell(r.kind) === 'p').map((r) => ({ schema: cell(r.schema), name: cell(r.name) }))
    )
    const selected = new Set(tables.map((t) => `${t.schema}.${t.name}`))
    const views = relations.filter((r) => (cell(r.kind) === 'v' && o.objects.views) || (cell(r.kind) === 'm' && o.objects.materializedViews))
    const types = o.objects.domainsAndTypes
      ? await queryRows(
          ctx,
          `SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')}
              AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))
            ORDER BY CASE t.typtype WHEN 'e' THEN 0 WHEN 'r' THEN 1 WHEN 'd' THEN 2 ELSE 3 END, t.oid`
        )
      : []
    // Sequences: standalone and serial-owned ones are created; identity sequences come with their table.
    // Those owned by tables left out of the backup are left out too.
    const sequences = (
      await queryRows(
        ctx,
        `SELECT n.nspname AS schema, c.relname AS name, d.deptype AS dep, tn.nspname AS tschema, t.relname AS tname, a.attname AS col,
                s.last_value AS value
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
           LEFT JOIN pg_class t ON t.oid = d.refobjid LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
           LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
           LEFT JOIN pg_sequences s ON s.schemaname = n.nspname AND s.sequencename = c.relname
          WHERE c.relkind = 'S' AND ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
          ORDER BY c.oid`
      )
    ).filter((s) => !s.tname || selected.has(`${cell(s.tschema)}.${cell(s.tname)}`))
    const created = sequences.filter((s) => cell(s.dep) !== 'i' && (o.objects.sequences || cell(s.dep) === 'a'))

    if (o.dropObjects) {
      // Dependents first; CASCADE takes what depends on them (views of other schemas, defaults, FKs).
      await out.section('Drop existing objects')
      for (const v of [...views].reverse()) {
        await out.statement(`DROP ${cell(v.kind) === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} IF EXISTS ${d.qualify(ref(cell(v.schema), cell(v.name), 'view'))} CASCADE`)
      }
      for (const t of [...tables].reverse()) await out.statement(`DROP TABLE IF EXISTS ${d.qualify(ref(t.schema, t.name, 'table'))} CASCADE`)
      for (const s of created) await out.statement(`DROP SEQUENCE IF EXISTS ${d.qualify(ref(cell(s.schema), cell(s.name), 'sequence'))} CASCADE`)
      for (const t of [...types].reverse()) {
        if (cell(t.kind) === 'r') continue
        await out.statement(`DROP ${cell(t.kind) === 'd' ? 'DOMAIN' : 'TYPE'} IF EXISTS ${d.qualify(ref(cell(t.schema), cell(t.name), 'type'))} CASCADE`)
      }
    }

    // Extensions: their objects are created by CREATE EXTENSION and never dumped one by one.
    if (o.objects.extensions) {
      const exts = await queryRows(
        ctx,
        `SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY e.oid`
      )
      if (exts.length) await out.section('Extensions')
      for (const e of exts) await out.statement(`CREATE EXTENSION IF NOT EXISTS ${d.quoteIdent(cell(e.name))} WITH SCHEMA ${d.quoteIdent(cell(e.schema))}`)
    }

    // Enum and composite types, domains (enums first: domains and composites may use them).
    if (types.length) {
      await out.section('Types and domains')
      for (const t of types) {
        if (ctx.isCancelled()) return
        const kind = cell(t.kind)
        if (kind === 'r') {
          ctx.warnings.push(`Range type ${cell(t.schema)}.${cell(t.name)} is not backed up`)
          continue
        }
        await out.statement(await aux.inspector.getObjectDDL(ref(cell(t.schema), cell(t.name), kind === 'd' ? 'domain' : 'type')))
      }
    }

    if (created.length) await out.section('Sequences')
    for (const s of created) {
      const ddl = await aux.inspector.getObjectDDL(ref(cell(s.schema), cell(s.name), 'sequence'))
      // The inspector appends setval(); values are written after the data instead.
      await out.statement(ddl.replace(/\n\s*SELECT\s+setval\([\s\S]*$/i, ''))
    }

    // Functions and procedures. Those whose signature uses a table or view row type, or whose body
    // is parsed at creation (BEGIN ATOMIC), wait for their relations.
    const routines = o.objects.routines
      ? await queryRows(
          ctx,
          `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.prokind AS kind,
                  (p.prosqlbody IS NOT NULL OR EXISTS (
                    SELECT 1 FROM unnest(array_append(COALESCE(p.proallargtypes, p.proargtypes::oid[]), p.prorettype)) x(t)
                      JOIN pg_type ty ON ty.oid = x.t
                      JOIN pg_type el ON el.oid = CASE WHEN ty.typelem <> 0 AND ty.typlen = -1 THEN ty.typelem ELSE ty.oid END
                      JOIN pg_class rc ON rc.oid = el.typrelid WHERE rc.relkind IN ('r', 'p', 'f'))) AS late,
                  EXISTS (
                    SELECT 1 FROM unnest(array_append(COALESCE(p.proallargtypes, p.proargtypes::oid[]), p.prorettype)) x(t)
                      JOIN pg_type ty ON ty.oid = x.t
                      JOIN pg_type el ON el.oid = CASE WHEN ty.typelem <> 0 AND ty.typlen = -1 THEN ty.typelem ELSE ty.oid END
                      JOIN pg_class rc ON rc.oid = el.typrelid WHERE rc.relkind IN ('v', 'm')) AS on_view
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE ${USER_SCHEMA('n.nspname')} AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}
            ORDER BY p.oid`
        )
      : []
    const routineDdl = async (r: (typeof routines)[number]): Promise<void> => {
      if (ctx.isCancelled()) return
      const kind = cell(r.kind) === 'p' ? 'procedure' : 'function'
      await out.routine(await aux.inspector.getObjectDDL(ref(cell(r.schema), cell(r.name), kind, { args: cell(r.args) })))
    }
    const early = routines.filter((r) => !r.late && !r.on_view)
    if (early.length) await out.section('Functions')
    for (const r of early) await routineDdl(r)

    // Tables (partitions are created with their parent; foreign tables need their server).
    const foreign = relations.filter((r) => cell(r.kind) === 'f')
    if (foreign.length) ctx.warnings.push(`Foreign tables are not backed up: ${foreign.map((f) => cell(f.name)).join(', ')}`)
    const structures = new Map<string, TableStructure>()
    await out.section('Tables')
    for (const t of tables) {
      if (ctx.isCancelled()) return
      ctx.progress('schema', t.name)
      const r = ref(t.schema, t.name, 'table')
      const s = await aux.inspector.getTableStructure(r)
      structures.set(`${t.schema}.${t.name}`, s)
      for (const st of d.createTable(coreStructure(s, true))) await out.statement(st)
    }
    for (const s of created) {
      if (cell(s.dep) === 'a' && s.tname) {
        await out.statement(`ALTER SEQUENCE ${d.qualify(ref(cell(s.schema), cell(s.name), 'sequence'))} OWNED BY ${d.qualify(ref(cell(s.tschema), cell(s.tname), 'table'))}.${d.quoteIdent(cell(s.col))}`)
      }
    }

    // Data
    for (const t of tables) {
      if (ctx.isCancelled() || !t.data) continue
      const s = structures.get(`${t.schema}.${t.name}`)!
      await out.section(`Data of ${t.schema}.${t.name}`)
      await writeRows(ctx, ref(t.schema, t.name, 'table'), s, { maxStatementBytes: 4 * 1024 * 1024, maxLiteralChars: Number.POSITIVE_INFINITY, executeBlock: false })
    }

    // Sequence values (identity and serial sequences are found by column at restore time).
    if (o.sequenceValues) {
      const valued = sequences.filter((s) => s.value !== null && s.value !== undefined && (cell(s.dep) !== '' || o.objects.sequences))
      if (valued.length) await out.section('Sequence values')
      for (const s of valued) {
        const target = s.tname
          ? `pg_catalog.pg_get_serial_sequence(${lit(d.qualify(ref(cell(s.tschema), cell(s.tname), 'table')))}, ${lit(cell(s.col))})`
          : lit(d.qualify(ref(cell(s.schema), cell(s.name), 'sequence')))
        await out.statement(`SELECT pg_catalog.setval(${target}, ${cell(s.value)}, true)`)
      }
    }

    // Indexes, checks and foreign keys
    await out.section('Indexes and constraints')
    const fkStatements: string[] = []
    for (const s of structures.values()) {
      for (const st of d.alterTable(coreStructure(s, true), s)) {
        if (/\bFOREIGN\s+KEY\b/i.test(st)) fkStatements.push(st)
        else await out.statement(st)
      }
    }
    for (const st of fkStatements) await out.statement(st)

    // Functions using table row types
    const late = routines.filter((r) => r.late && !r.on_view)
    if (late.length) await out.section('Functions using tables')
    for (const r of late) await routineDdl(r)

    // Views and materialized views, in dependency order.
    if (views.length) {
      const edges = await queryRows(
        ctx,
        `SELECT DISTINCT vn.nspname || '.' || v.relname AS view, rn.nspname || '.' || rc.relname AS uses
           FROM pg_rewrite rw JOIN pg_class v ON v.oid = rw.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
           JOIN pg_depend dep ON dep.classid = 'pg_rewrite'::regclass AND dep.objid = rw.oid AND dep.refclassid = 'pg_class'::regclass
           JOIN pg_class rc ON rc.oid = dep.refobjid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE v.relkind IN ('v', 'm') AND rc.oid <> v.oid AND rc.relkind IN ('v', 'm')`
      )
      const uses = new Map<string, string[]>()
      for (const e of edges) uses.set(cell(e.view), [...(uses.get(cell(e.view)) ?? []), cell(e.uses)])
      const key = (r: (typeof views)[number]): string => `${cell(r.schema)}.${cell(r.name)}`
      await out.section('Views')
      for (const v of dependencyOrder(views, key, (r) => uses.get(key(r)) ?? [])) {
        if (ctx.isCancelled()) return
        const mat = cell(v.kind) === 'm'
        const r = ref(cell(v.schema), cell(v.name), mat ? 'materialized_view' : 'view')
        const ddl = await aux.inspector.getObjectDDL(r)
        await out.statement(mat ? `${ddl.replace(/[\s;]+$/, '')}\nWITH NO DATA` : ddl)
      }
      const onView = routines.filter((r) => r.on_view)
      for (const r of onView) await routineDdl(r)
      for (const v of views.filter((x) => cell(x.kind) === 'm')) {
        await out.statement(`REFRESH MATERIALIZED VIEW ${d.qualify(ref(cell(v.schema), cell(v.name), 'materialized_view'))}`)
      }
    } else for (const r of routines.filter((x) => x.on_view)) await routineDdl(r)

    // Triggers
    if (o.objects.triggers) {
      const triggers = await queryRows(
        ctx,
        `SELECT pg_get_triggerdef(t.oid) AS ddl, t.tgenabled AS enabled, n.nspname AS schema, c.relname AS tbl, t.tgname AS name
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_trigger', 't.oid')} ORDER BY t.oid`
      )
      if (triggers.length) await out.section('Triggers')
      for (const t of triggers) {
        await out.statement(cell(t.ddl))
        if (cell(t.enabled) === 'D') await out.statement(`ALTER TABLE ${d.qualify(ref(cell(t.schema), cell(t.tbl), 'table'))} DISABLE TRIGGER ${d.quoteIdent(cell(t.name))}`)
      }
    }

    if (o.includeOwners) await this.owners(ctx, database)
    if (o.usersAndGrants) await this.grants(ctx)
  }

  private async owners(ctx: BackupContext, database: string): Promise<void> {
    const { out, dialect: d } = ctx
    const rows = await queryRows(
      ctx,
      `SELECT 'SCHEMA' AS kw, quote_ident(n.nspname) AS obj, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n
        WHERE ${USER_SCHEMA('n.nspname')} AND n.nspname <> 'public'
       UNION ALL
       SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
              quote_ident(n.nspname) || '.' || quote_ident(c.relname), pg_get_userbyid(c.relowner)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND NOT c.relispartition AND ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
          AND NOT EXISTS (SELECT 1 FROM pg_depend i WHERE i.objid = c.oid AND i.classid = 'pg_class'::regclass AND i.deptype = 'i')
       UNION ALL
       SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
              quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}
       UNION ALL
       SELECT CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, quote_ident(n.nspname) || '.' || quote_ident(t.typname), pg_get_userbyid(t.typowner)
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${USER_SCHEMA('n.nspname')} AND ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')}
          AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))`
    )
    if (rows.length) await out.section(`Owners (${database})`)
    for (const r of rows) await out.statement(`ALTER ${cell(r.kw)} ${cell(r.obj)} OWNER TO ${d.quoteIdent(cell(r.owner))}`)
  }

  /** Roles used by the database's privileges, then the privileges on its objects. */
  private async grants(ctx: BackupContext): Promise<void> {
    const { out, dialect: d } = ctx
    const roles = await queryRows(
      ctx,
      `SELECT r.rolname AS name, r.rolsuper AS su, r.rolinherit AS inh, r.rolcreaterole AS cr, r.rolcreatedb AS cd, r.rolcanlogin AS login,
              r.rolreplication AS repl, r.rolbypassrls AS rls, r.rolconnlimit AS lim, r.rolvaliduntil AS until
         FROM pg_roles r WHERE r.rolname !~ '^pg_' AND r.oid >= 16384 ORDER BY r.oid`
    )
    let hashes = new Map<string, string>()
    try {
      const rows = await queryRows(ctx, 'SELECT rolname AS name, rolpassword AS pw FROM pg_authid WHERE rolpassword IS NOT NULL')
      hashes = new Map(rows.map((r) => [cell(r.name), cell(r.pw)]))
    } catch {
      if (roles.some((r) => r.login)) ctx.warnings.push('Role passwords need superuser rights (pg_authid): roles are created without passwords')
    }
    if (roles.length) await out.section('Roles')
    const yes = (v: unknown, a: string, b: string): string => (v === true || v === 't' ? a : b)
    for (const r of roles) {
      const name = cell(r.name)
      const q = d.quoteIdent(name)
      // CREATE ROLE fails when the role exists: create it only when missing.
      await out.statement(
        `DO $ost$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${d.literal(name)}) THEN CREATE ROLE ${q}; END IF; END$ost$`
      )
      const attrs = [
        yes(r.su, 'SUPERUSER', 'NOSUPERUSER'),
        yes(r.inh, 'INHERIT', 'NOINHERIT'),
        yes(r.cr, 'CREATEROLE', 'NOCREATEROLE'),
        yes(r.cd, 'CREATEDB', 'NOCREATEDB'),
        yes(r.login, 'LOGIN', 'NOLOGIN'),
        yes(r.repl, 'REPLICATION', 'NOREPLICATION'),
        yes(r.rls, 'BYPASSRLS', 'NOBYPASSRLS'),
        `CONNECTION LIMIT ${cell(r.lim) || '-1'}`
      ]
      const pw = hashes.get(name)
      if (pw) attrs.push(`PASSWORD ${d.literal(pw)}`)
      if (r.until) attrs.push(`VALID UNTIL ${d.literal(cell(r.until))}`)
      await out.statement(`ALTER ROLE ${q} WITH ${attrs.join(' ')}`)
    }
    const members = await queryRows(
      ctx,
      `SELECT g.rolname AS grp, m.rolname AS member FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE g.rolname !~ '^pg_' AND m.rolname !~ '^pg_' AND g.oid >= 16384 AND m.oid >= 16384`
    )
    for (const m of members) await out.statement(`GRANT ${d.quoteIdent(cell(m.grp))} TO ${d.quoteIdent(cell(m.member))}`)

    // Object privileges, from the ACLs (owners' implicit rights are not repeated).
    const acls = await queryRows(
      ctx,
      `SELECT kw, obj, a.privilege_type AS priv, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee, a.is_grantable AS opt
         FROM (
           SELECT 'TABLE' AS kw, quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS obj, c.relacl AS acl, c.relowner AS owner
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm') AND c.relacl IS NOT NULL AND ${USER_SCHEMA('n.nspname')}
           UNION ALL
           SELECT 'SEQUENCE', quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.relacl, c.relowner
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'S' AND c.relacl IS NOT NULL AND ${USER_SCHEMA('n.nspname')}
           UNION ALL
           SELECT 'SCHEMA', quote_ident(n.nspname), n.nspacl, n.nspowner FROM pg_namespace n WHERE n.nspacl IS NOT NULL AND ${USER_SCHEMA('n.nspname')}
           UNION ALL
           SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                  quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.proacl, p.proowner
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proacl IS NOT NULL AND p.prokind IN ('f', 'p') AND ${USER_SCHEMA('n.nspname')}
         ) o, LATERAL aclexplode(o.acl) a
        WHERE a.grantee <> o.owner`
    )
    if (acls.length) await out.section('Privileges')
    for (const a of acls) {
      await out.statement(`GRANT ${cell(a.priv)} ON ${cell(a.kw)} ${cell(a.obj)} TO ${cell(a.grantee)}${a.opt === true || a.opt === 't' ? ' WITH GRANT OPTION' : ''}`)
    }
  }

  async epilogue(): Promise<void> {
    // Nothing to restore at the end: the SET statements only last for the restore session.
  }
}
