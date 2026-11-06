import type { RestoreRequest, RestoreResult } from '@shared/model'
import type { OpenDatabase } from '@domain/ports/database'
import type { BackupFiles } from '@domain/ports/backup'
import { isSingleDatabase } from '@domain/engineTraits'
import { restoreScript, type RestoreTransactionMode } from './scriptRestorer'

export interface RestoreControl {
  isCancelled(): boolean
  onAbort(abort: (() => Promise<void>) | null): void
  progress(p: { done: number; errors: number; bytes: number; totalBytes: number }): void
  error(message: string, sql: string): void
}

/** Restores a SQL script (gzip or not) on an auxiliary connection, so the session's own stays free. */
export async function runLogicalRestore(db: OpenDatabase, files: BackupFiles, req: RestoreRequest, ctl: RestoreControl): Promise<RestoreResult> {
  const started = Date.now()
  const engine = db.info.engine
  const reader = await files.openScript(req.filePath)
  const aux = await db.openAuxiliary().catch(async (err) => {
    await reader.close()
    throw err
  })
  ctl.onAbort(() => aux.connection.cancel())
  try {
    const conn = aux.connection
    let target = req.database
    if (req.createDatabase && !isSingleDatabase(engine)) {
      await conn.run(`CREATE DATABASE ${db.dialect.quoteIdent(req.createDatabase)}`, null, { maxRows: 1, chunkSize: 1 })
      target = req.createDatabase
    }
    if (target && !isSingleDatabase(engine)) await conn.useDatabase(target)
    // PostgreSQL and SQLite roll a whole restore back; MySQL commits DDL implicitly and Firebird
    // must commit new objects before using them, so they commit in batches.
    const transactional = engine === 'postgres' || engine === 'sqlite'
    const mode: RestoreTransactionMode = transactional && req.singleTransaction && req.stopOnError ? 'single' : 'batched'
    const r = await restoreScript(reader, conn, {
      engine,
      mode,
      commitEvery: Math.max(1, req.commitEvery || 100),
      stopOnError: req.stopOnError,
      isCancelled: () => ctl.isCancelled(),
      onProgress: (p) => ctl.progress({ done: p.statements, errors: p.errors, bytes: p.bytesRead, totalBytes: p.totalBytes }),
      onError: (message, sql) => ctl.error(message, sql)
    })
    return { statements: r.statements, errors: r.errors, warnings: r.warnings, durationMs: Date.now() - started }
  } finally {
    ctl.onAbort(null)
    await reader.close().catch(() => undefined)
    await aux.close().catch(() => undefined)
  }
}
