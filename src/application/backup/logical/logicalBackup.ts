import type { BackupPhase, BackupResult, DbEngine, LogicalBackupOptions } from '@shared/model'
import type { OpenDatabase } from '@domain/ports/database'
import type { BackupFiles } from '@domain/ports/backup'
import { formatBackupHeader } from '@domain/backup/backupHeader'
import { isSingleDatabase } from '@domain/engineTraits'
import { ScriptWriter } from './scriptWriter'
import { BackupCancelled } from './tableDataWriter'
import type { BackupContext, LogicalStrategy } from './strategies/types'
import { MySqlFamilyStrategy } from './strategies/mysqlFamily'
import { PostgresStrategy } from './strategies/postgres'
import { FirebirdStrategy } from './strategies/firebird'
import { SqliteStrategy } from './strategies/sqlite'

export interface BackupControl {
  isCancelled(): boolean
  /** Called with a function that interrupts the running statement (cancel). */
  onAbort(abort: (() => Promise<void>) | null): void
  progress(p: { phase: BackupPhase; object?: string; done: number; total?: number; bytes: number }): void
}

function strategyFor(engine: DbEngine): LogicalStrategy {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return new MySqlFamilyStrategy()
    case 'postgres':
      return new PostgresStrategy()
    case 'firebird':
      return new FirebirdStrategy()
    case 'sqlite':
      return new SqliteStrategy()
  }
}

/** PostgreSQL can only restore one database per connection: one file each (name_db.sql[.gz]). */
export function backupFileNames(engine: DbEngine, filePath: string, databases: string[]): { file: string; databases: string[] }[] {
  if (engine !== 'postgres' || databases.length <= 1) return [{ file: filePath, databases }]
  const m = /^(.*?)((?:\.[^./\\]+)?(?:\.gz)?)$/i.exec(filePath)!
  return databases.map((db) => ({ file: `${m[1]}_${db.replace(/[^\w.-]+/g, '_')}${m[2]}`, databases: [db] }))
}

/** Built-in backup: a SQL script per engine conventions, read on an auxiliary connection. */
export async function runLogicalBackup(
  db: OpenDatabase,
  files: BackupFiles,
  req: { filePath: string; compress: boolean; options: LogicalBackupOptions },
  ctl: BackupControl
): Promise<BackupResult> {
  const started = Date.now()
  const engine = db.info.engine
  const databases = isSingleDatabase(engine) ? [''] : req.options.databases
  if (!databases.length) throw new Error('Choose at least one database')
  const warnings: string[] = []
  const written: string[] = []
  let bytes = 0
  let statements = 0

  for (const target of backupFileNames(engine, req.filePath, databases)) {
    if (ctl.isCancelled()) throw new BackupCancelled()
    const writer = await files.createWriter(target.file, { gzip: req.compress })
    const aux = await db.openAuxiliary().catch(async (err) => {
      await writer.abort()
      throw err
    })
    const out = new ScriptWriter(writer, engine)
    let lastReport = 0
    let phase: BackupPhase = 'schema'
    const ctx: BackupContext = {
      engine,
      info: db.info,
      dialect: db.dialect,
      aux,
      out,
      options: { ...req.options, databases: target.databases },
      warnings,
      isCancelled: () => ctl.isCancelled(),
      progress: (p, object, rows) => {
        const now = Date.now()
        if (p === phase && now - lastReport < 200) return
        phase = p
        lastReport = now
        ctl.progress({ phase: p, object, done: rows ?? out.statements, bytes: bytes + writer.bytesWritten() })
      }
    }
    ctl.onAbort(() => aux.connection.cancel())
    try {
      const strategy = strategyFor(engine)
      if (engine === 'postgres' && target.databases[0]) await aux.connection.useDatabase(target.databases[0])
      await strategy.prepare(ctx)
      if (req.options.consistentSnapshot) await aux.connection.beginSnapshot()
      await out.raw(
        formatBackupHeader({
          v: 1,
          engine,
          serverVersion: db.info.version,
          serverLabel: db.info.label,
          databases: target.databases.filter(Boolean),
          createdAt: new Date().toISOString(),
          app: 'Open SQL Tools'
        })
      )
      await out.comment(`Server: ${db.info.label}\nDate: ${new Date().toISOString()}`)
      await out.raw('\n')
      await strategy.prologue(ctx)
      for (const database of target.databases) {
        if (ctl.isCancelled()) throw new BackupCancelled()
        await strategy.database(ctx, database)
      }
      if (ctl.isCancelled()) throw new BackupCancelled()
      await strategy.epilogue(ctx, target.databases)
      if (ctl.isCancelled()) throw new BackupCancelled()
      await writer.commit()
      written.push(target.file)
      bytes += writer.bytesWritten()
      statements += out.statements
    } catch (err) {
      await writer.abort()
      throw ctl.isCancelled() ? new BackupCancelled() : err
    } finally {
      ctl.onAbort(null)
      if (aux.connection.inTransaction()) await aux.connection.rollback().catch(() => undefined)
      await aux.close().catch(() => undefined)
    }
  }
  return { method: 'logical', files: written, bytes, statements, warnings, durationMs: Date.now() - started }
}
