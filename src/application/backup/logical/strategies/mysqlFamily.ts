import type { DbObjectInfo, DbObjectRef } from '@shared/model'
import { cell, queryRows, selectTables, stripDefiner, writeRows, type BackupContext, type LogicalStrategy } from './types'

/**
 * MySQL / MariaDB, in mysqldump's order: tables (foreign key checks off), data, then views over
 * placeholder views (views may use each other), routines, triggers and events. The snapshot is
 * START TRANSACTION WITH CONSISTENT SNAPSHOT (InnoDB tables only).
 */
export class MySqlFamilyStrategy implements LogicalStrategy {
  private sqlMode = 'NO_AUTO_VALUE_ON_ZERO'
  private maxStatementBytes = 4 * 1024 * 1024

  async prepare(ctx: BackupContext): Promise<void> {
    const conn = ctx.aux.connection
    // dateStrings: TIMESTAMP values are read in the session time zone; the script restores them in UTC.
    await conn.run("SET time_zone = '+00:00'", null, { maxRows: 1, chunkSize: 1, direct: true })
    const r = await queryRows(ctx, 'SELECT @@sql_mode AS mode, @@max_allowed_packet AS packet')
    const mode = cell(r[0]?.mode).toUpperCase()
    // String literals were written for this server's escaping rules.
    if (mode.includes('NO_BACKSLASH_ESCAPES')) this.sqlMode += ',NO_BACKSLASH_ESCAPES'
    if (mode.includes('ANSI_QUOTES')) this.sqlMode += ',ANSI_QUOTES'
    const packet = Number(cell(r[0]?.packet))
    if (packet > 0) this.maxStatementBytes = Math.max(64 * 1024, Math.min(packet - 1024, 8 * 1024 * 1024))
  }

  async prologue(ctx: BackupContext): Promise<void> {
    const o = ctx.out
    await o.raw('/*!40101 SET NAMES utf8mb4 */;\n')
    await o.raw("/*!40103 SET TIME_ZONE = '+00:00' */;\n")
    await o.raw('/*!40014 SET FOREIGN_KEY_CHECKS = 0 */;\n')
    await o.raw('/*!40014 SET UNIQUE_CHECKS = 0 */;\n')
    await o.raw(`/*!40101 SET SQL_MODE = '${this.sqlMode}' */;\n`)
    await o.raw('/*!40111 SET SQL_NOTES = 0 */;\n\n')
  }

  async database(ctx: BackupContext, database: string): Promise<void> {
    const { out, dialect: d, options: o, aux } = ctx
    const q = d.quoteIdent(database)
    const multi = ctx.options.databases.length > 1
    await out.section(`Database ${database}`)
    if (o.createDatabase) {
      if (o.dropObjects) await out.statement(`DROP DATABASE IF EXISTS ${q}`)
      const ddl = await aux.inspector.getObjectDDL({ name: database, kind: 'database' })
      await out.statement(ddl.replace(/^CREATE\s+DATABASE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE DATABASE IF NOT EXISTS '))
    }
    if (o.createDatabase || multi) await out.statement(`USE ${q}`)

    // SHOW CREATE VIEW qualifies tables with their database unless it is the current one.
    if (aux.connection.currentDatabase() !== database) await aux.connection.useDatabase(database)
    const objects = (await aux.inspector.listObjects(database)).filter((x) => !x.system)
    const ref = (x: DbObjectInfo): DbObjectRef => ({ database, name: x.name, kind: x.kind, table: x.table })
    // Names in the script are local: USE (or the restore target) chooses the database.
    const local = (x: DbObjectInfo): DbObjectRef => ({ name: x.name, kind: x.kind, table: x.table })
    const ddl = async (x: DbObjectInfo): Promise<string> => {
      const text = await aux.inspector.getObjectDDL(ref(x))
      return o.stripDefiners ? stripDefiner(text) : text
    }

    // MariaDB sequences are tables to information_schema; they are created before the tables using them.
    const sequences = o.objects.sequences ? objects.filter((x) => x.kind === 'sequence') : []
    for (const s of sequences) {
      if (ctx.isCancelled()) return
      if (o.dropObjects) await out.statement(`DROP SEQUENCE IF EXISTS ${d.qualify(local(s))}`)
      await out.statement(await ddl(s))
    }

    const tables = selectTables(ctx, database, objects.filter((x) => x.kind === 'table'))
    const nonTransactional = tables.filter((t) => t.engine && !/^(InnoDB|Aria|RocksDB|NDB(CLUSTER)?|TokuDB)$/i.test(t.engine))
    if (nonTransactional.length && o.consistentSnapshot) {
      ctx.warnings.push(`${database}: ${nonTransactional.map((t) => `${t.name} (${t.engine})`).join(', ')} are not transactional; their rows may change during the backup`)
    }
    for (const t of tables) {
      if (ctx.isCancelled()) return
      ctx.progress('schema', t.name)
      if (o.dropObjects) await out.statement(`DROP TABLE IF EXISTS ${d.qualify(local(t))}`)
      let text = await ddl(t)
      if (!o.sequenceValues) text = text.replace(/\s+AUTO_INCREMENT=\d+/i, '')
      if (/WITH SYSTEM VERSIONING/i.test(text) && t.data) ctx.warnings.push(`${t.name}: system-versioned table, only current rows are backed up`)
      await out.statement(text)
    }
    for (const t of tables) {
      if (ctx.isCancelled() || !t.data) continue
      const r = ref(t)
      const s = await aux.inspector.getTableStructure(r)
      await writeRows(ctx, r, s, { maxStatementBytes: this.maxStatementBytes, maxLiteralChars: Number.POSITIVE_INFINITY, executeBlock: false, insertRef: local(t) })
    }
    if (o.sequenceValues && sequences.length) {
      const values = await aux.inspector.listSequences(database)
      for (const s of sequences) {
        const v = values.find((x) => x.name === s.name)
        if (v?.value) await out.statement(`SELECT SETVAL(${d.qualify(local(s))}, ${v.value}, 1)`)
      }
    }

    if (o.objects.views) {
      const views = objects.filter((x) => x.kind === 'view')
      if (views.length) {
        ctx.progress('post', 'views')
        await out.section('Views')
        // Placeholders with the right columns first, so views can be created in any order.
        const columns = await aux.inspector.listColumns(database)
        for (const v of views) {
          const cols = columns.filter((c) => c.table === v.name)
          const list = cols.length ? cols.map((c) => `1 AS ${d.quoteIdent(c.name)}`).join(', ') : '1 AS `dummy`'
          if (o.dropObjects) await out.statement(`DROP TABLE IF EXISTS ${d.qualify(local(v))}`)
          await out.statement(`CREATE OR REPLACE VIEW ${d.qualify(local(v))} AS SELECT ${list}`)
        }
        for (const v of views) {
          if (ctx.isCancelled()) return
          const text = (await ddl(v)).replace(/^CREATE\s+(?!OR\s+REPLACE\b)/i, 'CREATE OR REPLACE ')
          await out.statement(text)
        }
      }
    }

    const routines = o.objects.routines ? objects.filter((x) => x.kind === 'procedure' || x.kind === 'function' || x.kind === 'package') : []
    if (routines.length) await out.section('Routines')
    for (const r of routines) {
      if (ctx.isCancelled()) return
      if (o.dropObjects) await out.statement(`DROP ${r.kind.toUpperCase()} IF EXISTS ${d.qualify(local(r))}`)
      const text = await ddl(r)
      // A package comes with its body: two statements.
      for (const part of r.kind === 'package' ? text.split(/;\s*\n\s*\n(?=CREATE\b)/i) : [text]) await out.routine(part)
    }
    const triggers = o.objects.triggers ? objects.filter((x) => x.kind === 'trigger') : []
    if (triggers.length) await out.section('Triggers')
    for (const t of triggers) {
      if (ctx.isCancelled()) return
      if (o.dropObjects) await out.statement(`DROP TRIGGER IF EXISTS ${d.qualify(local(t))}`)
      await out.routine(await ddl(t))
    }
    const events = o.objects.events ? objects.filter((x) => x.kind === 'event') : []
    if (events.length) await out.section('Events')
    for (const e of events) {
      if (ctx.isCancelled()) return
      if (o.dropObjects) await out.statement(`DROP EVENT IF EXISTS ${d.qualify(local(e))}`)
      await out.routine(await ddl(e))
    }
  }

  async epilogue(ctx: BackupContext, databases: string[]): Promise<void> {
    const { out, aux } = ctx
    if (ctx.options.usersAndGrants) {
      await out.section('Users and privileges')
      const dbs = new Set(databases.map((x) => x.toLowerCase()))
      const users = await aux.inspector.listUsers().catch((err: Error) => {
        ctx.warnings.push(`Users: ${err.message}`)
        return []
      })
      for (const u of users) {
        if (ctx.isCancelled()) return
        const account = `${ctx.dialect.literal(u.name)}@${ctx.dialect.literal(u.host ?? '%')}`
        if (/^(mysql\.(sys|session|infoschema)|mariadb\.sys|root)$/i.test(u.name)) continue
        const create = await queryRows(ctx, `SHOW CREATE USER ${account}`).catch(() => [])
        const grants = await aux.inspector.getUserPrivileges(u).catch(() => ({ grants: [] as string[] }))
        // Privileges on the backed-up databases, plus global ones (ON *.*).
        const relevant = grants.grants.filter((g) => {
          const m = /\bON\s+(?:(?:PROCEDURE|FUNCTION)\s+)?(`(?:[^`]|``)*`|\*|[^.\s]+)\./i.exec(g)
          if (!m) return true
          const db = m[1] === '*' ? '*' : m[1].replace(/^`|`$/g, '').replace(/``/g, '`').replace(/\\_/g, '_')
          return db === '*' || dbs.has(db.toLowerCase())
        })
        const createSql = create[0] ? cell(Object.values(create[0])[0]) : ''
        if (!createSql && !relevant.length) continue
        if (createSql) await out.statement(createSql.replace(/^CREATE\s+USER\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE USER IF NOT EXISTS '))
        for (const g of relevant) await out.statement(g)
      }
    }
    await out.raw('\n/*!40014 SET FOREIGN_KEY_CHECKS = 1 */;\n/*!40014 SET UNIQUE_CHECKS = 1 */;\n')
  }
}
