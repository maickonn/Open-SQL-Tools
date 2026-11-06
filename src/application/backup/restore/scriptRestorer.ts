import type { DbEngine } from '@shared/model'
import type { DbConnection } from '@domain/ports/database'
import type { ScriptReader } from '@domain/ports/backup'
import { SqlScanner, stripLeadingComments, type SqlStatement } from '@domain/sql/splitter'
import { classifyStatement } from '@domain/sql/classifier'

/**
 * - `none`: run statements as they come, under the connection's own autocommit setting ("Run SQL file").
 * - `single`: one transaction around the whole script; the script's own BEGIN/COMMIT are skipped.
 * - `batched`: commit every `commitEvery` statements (and right after DDL on Firebird, whose new
 *   objects take no DML before they are committed).
 */
export type RestoreTransactionMode = 'none' | 'single' | 'batched'

export interface ScriptRestoreOptions {
  engine: DbEngine
  mode: RestoreTransactionMode
  commitEvery: number
  stopOnError: boolean
  isCancelled(): boolean
  onProgress(p: { statements: number; errors: number; bytesRead: number; totalBytes: number }): void
  onError(message: string, sql: string): void
}

export interface ScriptRestoreResult {
  statements: number
  errors: number
  warnings: string[]
}

export class RestoreCancelled extends Error {
  constructor() {
    super('Restore cancelled')
  }
}

const TX_CONTROL = /^(?:BEGIN(?:\s+(?:TRANSACTION|WORK|DEFERRED|IMMEDIATE|EXCLUSIVE))?|START\s+TRANSACTION|COMMIT(?:\s+(?:TRANSACTION|WORK))?|END(?:\s+(?:TRANSACTION|WORK))?)\s*$/i
/** psql-only input the built-in restore cannot run. */
const PSQL_ONLY = /^(?:COPY\s[\s\S]*\bFROM\s+stdin\b|\\)/i

/** Error thrown for plain PostgreSQL dumps that need psql. */
export class NeedsPsqlError extends Error {
  constructor() {
    super('This script uses COPY … FROM stdin or psql meta-commands: restore it with psql')
  }
}

/** Streams a (possibly gzip compressed) SQL script into a connection, statement by statement. */
export async function restoreScript(reader: ScriptReader, conn: DbConnection, o: ScriptRestoreOptions): Promise<ScriptRestoreResult> {
  const scanner = new SqlScanner(o.engine)
  const warnings: string[] = []
  let statements = 0
  let errors = 0
  let sinceCommit = 0
  let lastReport = 0
  const isFb = o.engine === 'firebird'
  const batched = o.mode === 'batched'
  const single = o.mode === 'single'

  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReport < 250) return
    lastReport = now
    o.onProgress({ statements, errors, bytesRead: reader.position(), totalBytes: reader.size })
  }

  const run = async (st: SqlStatement): Promise<void> => {
    if (o.isCancelled()) throw new RestoreCancelled()
    // Comments before a statement (section headers) would hide it from the drivers' own checks:
    // SQLite applies PRAGMA foreign_keys and tracks BEGIN/COMMIT by the statement's first word.
    const sql = stripLeadingComments(st.sql)
    if (PSQL_ONLY.test(sql) && o.engine === 'postgres') throw new NeedsPsqlError()
    // Our wrapping transaction replaces the script's own.
    if (o.mode !== 'none' && TX_CONTROL.test(sql)) return
    try {
      await conn.run(sql, null, { maxRows: 1, chunkSize: 1 })
    } catch (err) {
      errors++
      o.onError(err instanceof Error ? err.message : String(err), sql)
      if (o.stopOnError || single) throw err
    }
    statements++
    sinceCommit++
    if (batched && (sinceCommit >= o.commitEvery || (isFb && classifyStatement(sql) === 'ddl'))) {
      if (conn.inTransaction()) await conn.commit()
      sinceCommit = 0
    }
    report()
  }

  if (o.mode !== 'none') await conn.setAutocommit(false)
  try {
    for await (const chunk of reader.chunks()) {
      for (const st of scanner.feed(chunk)) await run(st)
    }
    for (const st of scanner.end()) await run(st)
    if (o.mode !== 'none' && conn.inTransaction()) await conn.commit()
  } catch (err) {
    if (o.mode !== 'none' && conn.inTransaction()) await conn.rollback().catch(() => undefined)
    throw err
  } finally {
    if (o.mode !== 'none') await conn.setAutocommit(true).catch(() => undefined)
    report(true)
  }
  return { statements, errors, warnings }
}
