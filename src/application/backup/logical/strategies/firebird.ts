import type { DbObjectInfo, DbObjectRef, TableStructure } from '@shared/model'
import { dependencyOrder } from '@domain/backup/dependencyOrder'
import { hasCapability } from '@domain/serverVersion'
import { unwrapSetTerm } from '../scriptWriter'
import { cell, coreStructure, queryRows, selectTables, writeRows, type BackupContext, type LogicalStrategy } from './types'

/** Firebird 2.5 statements are limited to 64 KB; 3.0+ to 10 MB. */
const SMALL_STATEMENT = 60_000
const LARGE_STATEMENT = 1024 * 1024
/** Literals above this length are appended in pieces (string literals are limited to 32 KB). */
const MAX_LITERAL = 8_000

const PRIVILEGES: Record<string, string> = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE', R: 'REFERENCES', X: 'EXECUTE', G: 'USAGE' }
/** RDB$USER_TYPE / RDB$OBJECT_TYPE codes. */
const GRANTEE_PREFIX: Record<number, string> = { 1: 'VIEW ', 2: 'TRIGGER ', 5: 'PROCEDURE ', 13: 'ROLE ', 15: 'FUNCTION ', 18: 'PACKAGE ' }
const OBJECT_PREFIX: Record<number, string> = { 0: 'TABLE ', 5: 'PROCEDURE ', 15: 'FUNCTION ', 18: 'PACKAGE ', 14: 'GENERATOR ', 7: 'EXCEPTION ' }

/**
 * Firebird, like gbak's metadata order: domains, generators, exceptions, tables without foreign
 * keys, indexes or checks, placeholder routines (routines and views may use each other), views by
 * dependency, data in EXECUTE BLOCK batches, generator values, indexes and constraints, the real
 * routine and package bodies, triggers and privileges. Everything is read in one SNAPSHOT
 * transaction; text without a charset is copied as bytes.
 */
export class FirebirdStrategy implements LogicalStrategy {
  async prepare(): Promise<void> {
    // Nothing: the snapshot transaction is all the session needs.
  }

  async prologue(): Promise<void> {
    // SET SQL DIALECT / SET NAMES are isql commands, not statements: the restoring client chooses them.
  }

  async database(ctx: BackupContext): Promise<void> {
    const { out, aux, dialect: d, options: o, info } = ctx
    const v3 = info.version >= 30000
    const objects = await aux.inspector.listObjects()
    const of = (kind: DbObjectInfo['kind']): DbObjectInfo[] => objects.filter((x) => x.kind === kind)
    const ref = (x: { name: string; kind: DbObjectRef['kind']; table?: string }): DbObjectRef => ({ name: x.name, kind: x.kind, table: x.table })
    const ddl = async (x: DbObjectInfo): Promise<string[]> => unwrapSetTerm(await aux.inspector.getObjectDDL(ref(x)))

    if (o.objects.domainsAndTypes) {
      const domains = of('domain')
      if (domains.length) await out.section('Domains')
      for (const x of domains) for (const st of await ddl(x)) await out.statement(st)
    }
    const generators = o.objects.sequences ? of('sequence') : []
    if (generators.length) await out.section('Generators')
    for (const g of generators) await out.statement(`CREATE SEQUENCE ${d.quoteIdent(g.name)}`)
    if (o.objects.domainsAndTypes) {
      const exceptions = of('exception')
      if (exceptions.length) await out.section('Exceptions')
      for (const x of exceptions) for (const st of await ddl(x)) await out.statement(st)
    }

    // Tables
    const tables = selectTables(ctx, '', of('table'))
    const structures = new Map<string, TableStructure>()
    await out.section('Tables')
    for (const t of tables) {
      if (ctx.isCancelled()) return
      ctx.progress('schema', t.name)
      const s = await aux.inspector.getTableStructure(ref(t))
      structures.set(t.name, s)
      for (const st of d.createTable(coreStructure(s, false))) await out.statement(st)
    }

    // Placeholder routines: their signatures, with empty bodies.
    const procedures = o.objects.routines ? of('procedure') : []
    const functions = o.objects.routines && v3 ? of('function') : []
    const packages = o.objects.routines ? of('package') : []
    const bodies = new Map<string, string[]>()
    for (const r of [...procedures, ...functions, ...packages]) bodies.set(`${r.kind}:${r.name}`, await ddl(r))
    if (bodies.size) {
      await out.section('Routine headers')
      await out.beginBlocks()
      for (const p of packages) await out.routine(bodies.get(`package:${p.name}`)![0])
      for (const r of [...procedures, ...functions]) {
        const stub = placeholder(bodies.get(`${r.kind}:${r.name}`)![0], r.kind === 'procedure')
        if (stub) await out.routine(stub)
      }
      await out.endBlocks()
    }
    if (o.objects.routines && !v3 && of('function').length) {
      ctx.warnings.push(`Legacy UDFs (DECLARE EXTERNAL FUNCTION) are not backed up: ${of('function').map((f) => f.name).join(', ')}`)
    }

    // Views
    const views = o.objects.views ? of('view') : []
    if (views.length) {
      const deps = await queryRows(
        ctx,
        `SELECT TRIM(RDB$DEPENDENT_NAME) AS V, TRIM(RDB$DEPENDED_ON_NAME) AS U FROM RDB$DEPENDENCIES WHERE RDB$DEPENDENT_TYPE = 1 AND RDB$DEPENDED_ON_TYPE = 0`
      )
      const uses = new Map<string, string[]>()
      for (const x of deps) uses.set(cell(x.v), [...(uses.get(cell(x.v)) ?? []), cell(x.u)])
      await out.section('Views')
      for (const v of dependencyOrder(views, (x) => x.name, (x) => uses.get(x.name) ?? [])) {
        if (ctx.isCancelled()) return
        for (const st of await ddl(v)) await out.statement(st)
      }
    }

    // Data
    const big = hasCapability(info.capabilities, 'largeStatements')
    for (const t of tables) {
      if (ctx.isCancelled() || !t.data) continue
      await out.section(`Data of ${t.name}`)
      await writeRows(ctx, ref(t), structures.get(t.name)!, {
        maxStatementBytes: big ? LARGE_STATEMENT : SMALL_STATEMENT,
        maxLiteralChars: MAX_LITERAL,
        executeBlock: true,
        rawText: true,
        readAs: wideRowReads(structures.get(t.name)!, d)
      })
    }

    // Generator and identity values
    if (o.sequenceValues) {
      if (generators.length) {
        const values = await aux.inspector.listSequences()
        await out.section('Generator values')
        for (const g of values) if (generators.some((x) => x.name === g.name)) for (const st of d.setSequenceValue({ name: g.name, kind: 'sequence' }, g.value)) await out.statement(st)
      }
      if (v3) await this.identityValues(ctx, tables.map((t) => t.name))
    }

    // Indexes, checks, foreign keys
    await out.section('Indexes and constraints')
    const fks: string[] = []
    for (const s of structures.values()) {
      for (const st of d.alterTable(coreStructure(s, false), s)) {
        if (/\bFOREIGN\s+KEY\b/i.test(st)) fks.push(st)
        else await out.statement(st)
      }
    }
    for (const st of fks) await out.statement(st)

    // Routine bodies
    if (bodies.size) {
      await out.section('Routines')
      await out.beginBlocks()
      for (const r of [...procedures, ...functions]) await out.routine(bodies.get(`${r.kind}:${r.name}`)![0])
      for (const p of packages) {
        const parts = bodies.get(`package:${p.name}`)!
        for (const part of parts.slice(1)) await out.routine(part)
      }
      await out.endBlocks()
    }

    if (o.objects.triggers) {
      const triggers = of('trigger')
      if (triggers.length) {
        await out.section('Triggers')
        await out.beginBlocks()
        for (const t of triggers) for (const st of await ddl(t)) await out.routine(st)
        await out.endBlocks()
      }
    }
  }

  /** Identity columns continue from their current value (RESTART WITH changed meaning in Firebird 4). */
  private async identityValues(ctx: BackupContext, tables: string[]): Promise<void> {
    const rows = await queryRows(
      ctx,
      `SELECT TRIM(RF.RDB$RELATION_NAME) AS T, TRIM(RF.RDB$FIELD_NAME) AS C, TRIM(RF.RDB$GENERATOR_NAME) AS G, COALESCE(GN.RDB$GENERATOR_INCREMENT, 1) AS INC
         FROM RDB$RELATION_FIELDS RF JOIN RDB$GENERATORS GN ON GN.RDB$GENERATOR_NAME = RF.RDB$GENERATOR_NAME
        WHERE RF.RDB$GENERATOR_NAME IS NOT NULL`
    )
    const wanted = rows.filter((r) => tables.includes(cell(r.t)))
    if (!wanted.length) return
    const d = ctx.dialect
    // UNION ALL keeps no guaranteed order: each value comes with its generator's name.
    const values = await queryRows(
      ctx,
      wanted.map((r) => `SELECT CAST(${d.literal(cell(r.g))} AS VARCHAR(63)) AS G, GEN_ID(${d.quoteIdent(cell(r.g))}, 0) AS V FROM RDB$DATABASE`).join(' UNION ALL ')
    )
    const byName = new Map(values.map((x) => [cell(x.g).trim(), cell(x.v)]))
    await ctx.out.beginBlocks()
    for (const r of wanted) {
      const v = BigInt(byName.get(cell(r.g)) || '0')
      const inc = BigInt(cell(r.inc) || '1')
      const alter = (n: bigint): string => d.literal(`ALTER TABLE ${d.quoteIdent(cell(r.t))} ALTER COLUMN ${d.quoteIdent(cell(r.c))} RESTART WITH ${n}`)
      await ctx.out.routine(
        `EXECUTE BLOCK AS BEGIN\n  IF (RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') STARTING WITH '3.') THEN EXECUTE STATEMENT ${alter(v)};\n  ELSE EXECUTE STATEMENT ${alter(v + inc)};\nEND`
      )
    }
    await ctx.out.endBlocks()
  }

  async epilogue(ctx: BackupContext): Promise<void> {
    if (!ctx.options.usersAndGrants) return
    const { out, dialect: d } = ctx
    ctx.warnings.push('Firebird users live in the server security database and are not backed up; roles and privileges are')
    const roles = await queryRows(ctx, `SELECT TRIM(RDB$ROLE_NAME) AS NAME FROM RDB$ROLES WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0`)
    if (roles.length) await out.section('Roles')
    for (const r of roles) await out.statement(`CREATE ROLE ${d.quoteIdent(cell(r.name))}`)
    const grants = await queryRows(
      ctx,
      `SELECT TRIM(P.RDB$USER) AS U, P.RDB$USER_TYPE AS UT, TRIM(P.RDB$PRIVILEGE) AS P, P.RDB$GRANT_OPTION AS OPT,
              TRIM(P.RDB$RELATION_NAME) AS OBJ, P.RDB$OBJECT_TYPE AS OT, TRIM(P.RDB$FIELD_NAME) AS F
         FROM RDB$USER_PRIVILEGES P
        WHERE P.RDB$RELATION_NAME NOT STARTING WITH 'RDB$' AND P.RDB$RELATION_NAME NOT STARTING WITH 'MON$' AND P.RDB$RELATION_NAME NOT STARTING WITH 'SEC$'
          AND P.RDB$USER <> COALESCE((SELECT R.RDB$OWNER_NAME FROM RDB$RELATIONS R WHERE R.RDB$RELATION_NAME = P.RDB$RELATION_NAME AND P.RDB$OBJECT_TYPE = 0), '')
        ORDER BY 5, 1, 3`
    )
    if (grants.length) await out.section('Privileges')
    for (const g of grants) {
      const priv = cell(g.p)
      const grantee = `${GRANTEE_PREFIX[Number(g.ut)] ?? ''}${d.quoteIdent(cell(g.u))}`
      const option = Number(g.opt) === 1 ? (priv === 'M' ? ' WITH ADMIN OPTION' : ' WITH GRANT OPTION') : ''
      if (priv === 'M') {
        await out.statement(`GRANT ${d.quoteIdent(cell(g.obj))} TO ${grantee}${option}`)
        continue
      }
      const name = PRIVILEGES[priv]
      if (!name) continue
      const column = g.f && (priv === 'U' || priv === 'R') ? ` (${d.quoteIdent(cell(g.f))})` : ''
      await out.statement(`GRANT ${name}${column} ON ${OBJECT_PREFIX[Number(g.ot)] ?? ''}${d.quoteIdent(cell(g.obj))} TO ${grantee}${option}`)
    }
  }
}

/**
 * `CREATE OR ALTER PROCEDURE p (…) RETURNS (…) AS <body>` → same signature with an empty body;
 * external routines are created as they are.
 */
export function placeholder(ddl: string, procedure: boolean): string | null {
  const m = /^([\s\S]*?)\n\s*AS\s*\n/i.exec(ddl)
  if (!m) return /\bEXTERNAL\s+NAME\b/i.test(ddl) ? ddl : null
  const head = m[1]
  if (procedure) return `${head}\nAS\nBEGIN\n  ${/\bRETURNS\s*\(/i.test(head) ? 'SUSPEND' : 'EXIT'};\nEND`
  return `${head}\nAS\nBEGIN\n  RETURN NULL;\nEND`
}

/** Charsets of more than one byte per character: the server sends them as they are stored. */
const MULTIBYTE = new Set(['UTF8', 'UNICODE_FSS', 'SJIS_0208', 'EUCJ_0208', 'BIG_5', 'GB_2312', 'KSC_5601', 'GBK', 'CP943C', 'GB18030'])
/** A row travels as one message of at most 64 KB (less some room for null flags and alignment). */
const MESSAGE_LIMIT = 60_000

/**
 * On a UTF8 connection the server converts text of single-byte charsets (WIN1252, ISO8859_1…) and
 * reserves 4 bytes per character for it, so a table whose row fits on disk can exceed the 64 KB
 * message: Firebird rejects the SELECT ("block size exceeds implementation restriction"). Such tables
 * read those columns as OCTETS, their stored bytes, written back as hex literals into the same charset.
 */
export function wideRowReads(s: TableStructure, d: { quoteIdent(name: string): string }): Record<string, string> | undefined {
  const text = (c: TableStructure['columns'][number]): boolean => (c.dataType === 'CHAR' || c.dataType === 'VARCHAR') && !!c.length
  const singleByte = (c: TableStructure['columns'][number]): boolean => text(c) && !!c.charset && c.charset !== 'NONE' && c.charset !== 'OCTETS' && !MULTIBYTE.has(c.charset)
  const columns = s.columns.filter((c) => !c.generated)
  const size = columns.reduce((sum, c) => sum + (text(c) ? c.length! * (c.charset === 'NONE' || c.charset === 'OCTETS' ? 1 : 4) + 2 : 16), 0)
  if (size <= MESSAGE_LIMIT) return undefined
  const reads: Record<string, string> = {}
  for (const c of columns) if (singleByte(c)) reads[c.name] = `CAST(${d.quoteIdent(c.name)} AS VARCHAR(${c.length}) CHARACTER SET OCTETS)`
  return Object.keys(reads).length ? reads : undefined
}
