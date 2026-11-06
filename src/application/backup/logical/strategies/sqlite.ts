import type { DbObjectRef } from '@shared/model'
import { cell, queryRows, selectTables, writeRows, type BackupContext, type LogicalStrategy } from './types'

/** Tables virtual-table modules keep their data in (recreated by CREATE VIRTUAL TABLE). */
const SHADOW_SUFFIXES: Record<string, string[]> = {
  fts3: ['content', 'segments', 'segdir', 'docsize', 'stat'],
  fts4: ['content', 'segments', 'segdir', 'docsize', 'stat'],
  fts5: ['data', 'idx', 'content', 'docsize', 'config'],
  rtree: ['node', 'rowid', 'parent'],
  rtree_i32: ['node', 'rowid', 'parent'],
  geopoly: ['node', 'rowid', 'parent']
}

/**
 * SQLite, like the sqlite3 shell's .dump: one transaction with foreign keys off, tables in creation
 * order, data, AUTOINCREMENT counters, then indexes, views and triggers (so triggers do not fire
 * while rows are loaded). Statistics tables and virtual-table shadow tables are left out.
 */
export class SqliteStrategy implements LogicalStrategy {
  async prepare(): Promise<void> {}

  async prologue(ctx: BackupContext): Promise<void> {
    await ctx.out.raw('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n')
  }

  async database(ctx: BackupContext): Promise<void> {
    const { out, dialect: d, options: o } = ctx
    const master = await queryRows(ctx, "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
    const virtual = master.filter((m) => cell(m.type) === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(cell(m.sql)))
    const shadows = new Set<string>()
    for (const v of virtual) {
      const module = /\bUSING\s+(\w+)/i.exec(cell(v.sql))?.[1]?.toLowerCase() ?? ''
      for (const s of SHADOW_SUFFIXES[module] ?? []) shadows.add(`${cell(v.name)}_${s}`.toLowerCase())
    }
    const isUserTable = (name: string): boolean => !/^sqlite_/i.test(name) && !shadows.has(name.toLowerCase())
    const all = master.filter((m) => cell(m.type) === 'table' && isUserTable(cell(m.name)))
    const tables = selectTables(ctx, '', all.map((m) => ({ name: cell(m.name), sql: cell(m.sql), virtual: virtual.includes(m) })))
    const ref = (name: string): DbObjectRef => ({ name, kind: 'table' })

    await out.section('Tables')
    for (const t of tables) {
      if (ctx.isCancelled()) return
      if (o.dropObjects) await out.statement(`DROP TABLE IF EXISTS ${d.quoteIdent(t.name)}`)
      await out.statement(t.sql)
    }
    for (const t of tables) {
      if (ctx.isCancelled() || !t.data) continue
      await out.section(`Data of ${t.name}`)
      try {
        const s = await ctx.aux.inspector.getTableStructure(ref(t.name))
        await writeRows(ctx, ref(t.name), s, { maxStatementBytes: 4 * 1024 * 1024, maxLiteralChars: Number.POSITIVE_INFINITY, executeBlock: false })
      } catch (err) {
        if (!t.virtual) throw err
        ctx.warnings.push(`${t.name}: rows of the virtual table were not backed up (${err instanceof Error ? err.message : String(err)})`)
      }
    }

    if (o.sequenceValues && master.some((m) => cell(m.name) === 'sqlite_sequence')) {
      const names = new Set(tables.map((t) => t.name))
      const seq = (await queryRows(ctx, 'SELECT name, seq FROM sqlite_sequence')).filter((r) => names.has(cell(r.name)))
      if (seq.length) {
        await out.section('AUTOINCREMENT counters')
        for (const r of seq) {
          await out.statement(`DELETE FROM sqlite_sequence WHERE name = ${d.literal(cell(r.name))}`)
          await out.statement(`INSERT INTO sqlite_sequence (name, seq) VALUES (${d.literal(cell(r.name))}, ${cell(r.seq)})`)
        }
      }
    }

    const tableNames = new Set(tables.map((t) => t.name.toLowerCase()))
    const indexes = master.filter((m) => cell(m.type) === 'index' && tableNames.has(cell(m.tbl).toLowerCase()))
    if (indexes.length) await out.section('Indexes')
    for (const i of indexes) {
      if (o.dropObjects) await out.statement(`DROP INDEX IF EXISTS ${d.quoteIdent(cell(i.name))}`)
      await out.statement(cell(i.sql))
    }
    if (o.objects.views) {
      const views = master.filter((m) => cell(m.type) === 'view')
      if (views.length) await out.section('Views')
      for (const v of views) {
        if (o.dropObjects) await out.statement(`DROP VIEW IF EXISTS ${d.quoteIdent(cell(v.name))}`)
        await out.statement(cell(v.sql))
      }
    }
    if (o.objects.triggers) {
      const triggers = master.filter((m) => cell(m.type) === 'trigger')
      if (triggers.length) await out.section('Triggers')
      for (const t of triggers) {
        if (o.dropObjects) await out.statement(`DROP TRIGGER IF EXISTS ${d.quoteIdent(cell(t.name))}`)
        await out.routine(cell(t.sql))
      }
    }
  }

  async epilogue(ctx: BackupContext): Promise<void> {
    await ctx.out.raw('COMMIT;\n')
  }
}
