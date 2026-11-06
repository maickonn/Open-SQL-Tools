import type { BackupPhase, BackupTableSelection, CellValue, DbEngine, DbObjectRef, LogicalBackupOptions, ServerInfo, TableStructure } from '@shared/model'
import type { AuxiliaryConnection, SqlDialect } from '@domain/ports/database'
import type { ScriptWriter } from '../scriptWriter'
import { writeTableData, type DataWriterOptions } from '../tableDataWriter'

export interface BackupContext {
  engine: DbEngine
  info: ServerInfo
  dialect: SqlDialect
  aux: AuxiliaryConnection
  out: ScriptWriter
  options: LogicalBackupOptions
  warnings: string[]
  isCancelled(): boolean
  progress(phase: BackupPhase, object?: string, rows?: number, total?: number): void
}

/** Engine-specific part of a built-in backup. One instance per backup file. */
export interface LogicalStrategy {
  /** Session settings on the auxiliary connection (before the snapshot starts). */
  prepare(ctx: BackupContext): Promise<void>
  /** Statements at the top of the file. */
  prologue(ctx: BackupContext): Promise<void>
  /** Everything in one database ('' on single-database engines). */
  database(ctx: BackupContext, database: string): Promise<void>
  /** Server-level objects (users and grants) and the closing statements. */
  epilogue(ctx: BackupContext, databases: string[]): Promise<void>
}

/** Tables chosen in the dialog (all, with data, when nothing was chosen). */
export function selectTables<T extends { schema?: string; name: string }>(ctx: BackupContext, database: string, tables: T[]): (T & { data: boolean })[] {
  const chosen = ctx.options.tables?.[database]
  if (!chosen) return tables.map((t) => ({ ...t, data: true }))
  const byKey = new Map<string, BackupTableSelection>(chosen.map((c) => [`${c.schema ?? ''}.${c.name}`, c]))
  return tables.flatMap((t) => {
    const c = byKey.get(`${t.schema ?? ''}.${t.name}`)
    return c ? [{ ...t, data: c.data }] : []
  })
}

/** Columns a table's rows are written with: generated columns are computed by the server. */
export function dataColumns(s: TableStructure): { columns: string[]; keyColumns: string[]; overridingSystemValue: boolean } {
  const columns = s.columns.filter((c) => !c.generated).map((c) => c.name)
  const pk = s.indexes.find((i) => i.type === 'PRIMARY') ?? s.indexes.find((i) => i.type === 'UNIQUE' && !i.expression && i.columns.length)
  const keyColumns = pk && !pk.expression ? pk.columns.filter((c) => columns.includes(c)) : []
  return {
    columns,
    keyColumns: pk && keyColumns.length === pk.columns.length ? keyColumns : [],
    overridingSystemValue: s.columns.some((c) => c.identity === 'always' && !c.generated)
  }
}

export async function writeRows(
  ctx: BackupContext,
  ref: DbObjectRef,
  structure: TableStructure,
  o: Pick<DataWriterOptions, 'maxStatementBytes' | 'maxLiteralChars' | 'executeBlock'> & { rawText?: boolean; insertRef?: DbObjectRef; readAs?: Record<string, string> }
): Promise<number> {
  const cols = dataColumns(structure)
  if (!cols.columns.length) return 0
  const mode = ctx.options.dataMode ?? 'insert'
  if (mode === 'delete_insert') await ctx.out.statement(`DELETE FROM ${ctx.dialect.qualify(o.insertRef ?? ref)}`)
  ctx.progress('data', ref.name, 0)
  const r = await writeTableData(ctx.aux.connection, ctx.out, { ref, insertRef: o.insertRef, readAs: o.readAs, ...cols }, {
    engine: ctx.engine,
    dialect: ctx.dialect,
    verb: mode === 'replace' ? 'REPLACE' : mode === 'insert_ignore' ? 'INSERT IGNORE' : 'INSERT',
    rowsPerInsert: ctx.options.rowsPerInsert,
    maxStatementBytes: o.maxStatementBytes,
    maxLiteralChars: o.maxLiteralChars,
    executeBlock: o.executeBlock,
    rawText: o.rawText,
    isCancelled: ctx.isCancelled,
    onRows: (n) => ctx.progress('data', ref.name, n)
  })
  ctx.warnings.push(...r.warnings)
  return r.rows
}

export const cell = (v: CellValue | undefined): string => (v === null || v === undefined ? '' : v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v))

/** Rows of a small catalog query as objects keyed by lower-case column names. */
export async function queryRows(ctx: BackupContext, sql: string): Promise<Record<string, CellValue>[]> {
  const r = await ctx.aux.query(sql, 1_000_000)
  const names = r.columns.map((c) => c.name.toLowerCase())
  return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])))
}

/** Statement text without `DEFINER=…` (MySQL family). */
export function stripDefiner(ddl: string): string {
  return ddl.replace(/\bDEFINER\s*=\s*(?:`[^`]*`|'[^']*'|"[^"]*"|[^\s@]+)(?:@(?:`[^`]*`|'[^']*'|"[^"]*"|[^\s*]+))?\s+/i, '')
}

/** Structure without foreign keys, secondary indexes and checks: those are added after the data. */
export function coreStructure(s: TableStructure, keepChecks: boolean): TableStructure {
  return {
    ...s,
    foreignKeys: [],
    checks: keepChecks ? s.checks : [],
    indexes: s.indexes.filter((i) => i.type === 'PRIMARY' || (i.type === 'UNIQUE' && i.constraint))
  }
}
