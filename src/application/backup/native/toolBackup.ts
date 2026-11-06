import type { BackupRequest, BackupResult, BackupToolName, RestoreRequest, RestoreResult } from '@shared/model'
import type { OpenDatabase } from '@domain/ports/database'
import type { BackupFiles, LocatedTool, ToolInvocation } from '@domain/ports/backup'
import { isMariaDbTool, toolCompatibility } from '@domain/backup/toolVersion'
import { isSingleDatabase } from '@domain/engineTraits'
import type { BackupToolDeps, ConnectionTarget } from '../backupService'
import type { BackupControl } from '../logical/logicalBackup'
import { backupFileNames } from '../logical/logicalBackup'
import type { RestoreControl } from '../restore/logicalRestore'
import { BackupCancelled } from '../logical/tableDataWriter'
import {
  gbakBackupInvocation,
  gbakRestoreInvocation,
  mysqlDumpInvocations,
  mysqlRestoreInvocation,
  pgDumpInvocation,
  pgRestoreInvocation,
  psqlInvocation,
  type ToolTarget
} from './commands'

const DEFAULT_LOGICAL = {
  objects: { views: true, routines: true, triggers: true, sequences: true, domainsAndTypes: true, events: true, materializedViews: true, extensions: true },
  sequenceValues: true,
  usersAndGrants: false,
  createDatabase: false,
  dropObjects: true,
  stripDefiners: false,
  includeOwners: false,
  consistentSnapshot: true,
  rowsPerInsert: 500
}

/** Tools that can run each method, best first. */
const CANDIDATES: Record<string, BackupToolName[]> = {
  mysqldump: ['mariadb-dump', 'mysqldump'],
  mysql: ['mariadb', 'mysql'],
  pg_dump: ['pg_dump'],
  pg_restore: ['pg_restore'],
  psql: ['psql'],
  gbak: ['gbak']
}

async function pickTool(db: OpenDatabase, tools: BackupToolDeps, method: string, toolPath?: string): Promise<LocatedTool> {
  let names = CANDIDATES[method] ?? []
  // Prefer the client built for the server family.
  if (db.info.engine === 'mysql') names = [...names].reverse()
  const overrides = toolPath ? Object.fromEntries(names.map((n) => [n, toolPath])) : undefined
  const found = await tools.locator.detect(db.info.engine, overrides)
  const usable = names.map((n) => found.find((f) => f.tool === n)).filter((f): f is LocatedTool => !!f)
  const ok = usable.find((t) => toolCompatibility(t.tool, t.version, db.info, isMariaDbTool(t.tool, t.banner)).compatible)
  if (ok) return ok
  if (usable[0]) throw new Error(toolCompatibility(usable[0].tool, usable[0].version, db.info, isMariaDbTool(usable[0].tool, usable[0].banner)).reason ?? `${usable[0].tool} is not compatible`)
  throw new Error(`${names.join(' / ')} not found: install it or set its path in Settings → Tools`)
}

function toolTarget(target: ConnectionTarget): ToolTarget {
  return { ...target, tunneled: target.profile.ssh.enabled }
}

async function run(
  tools: BackupToolDeps,
  inv: ToolInvocation,
  io: Parameters<BackupToolDeps['runner']['run']>[1],
  ctl: { onAbort(abort: (() => Promise<void>) | null): void },
  onLine: (line: string) => void
): Promise<void> {
  const controller = new AbortController()
  ctl.onAbort(async () => controller.abort())
  try {
    const r = await tools.runner.run(inv, io, (_stream, line) => onLine(line), controller.signal)
    if (controller.signal.aborted) throw new BackupCancelled()
    if (r.exitCode !== 0) throw new Error(r.stderrTail.trim() || `${inv.path} exited with code ${r.exitCode}`)
  } finally {
    ctl.onAbort(null)
  }
}

/** Backup with mysqldump / mariadb-dump, pg_dump or gbak. */
export async function runToolBackup(db: OpenDatabase, tools: BackupToolDeps, files: BackupFiles, req: BackupRequest, target: ConnectionTarget, ctl: BackupControl): Promise<BackupResult> {
  const started = Date.now()
  const tool = await pickTool(db, tools, req.method, req.native?.toolPath)
  const t = toolTarget(target)
  const o = { ...DEFAULT_LOGICAL, databases: [] as string[], ...req.logical }
  const extra = req.native?.extraArgs ?? []
  const warnings: string[] = []
  const written: string[] = []
  let bytes = 0
  let lines = 0
  const onLine = (line: string): void => {
    lines++
    ctl.progress({ phase: 'tool', object: line.slice(0, 200), done: lines, bytes })
  }

  if (req.method === 'gbak' && req.native?.serverPath) {
    await run(tools, gbakBackupInvocation(tool.path, t, req.native.serverPath, extra), {}, ctl, onLine)
    return { method: req.method, files: [req.native.serverPath], bytes: 0, statements: 0, warnings, durationMs: Date.now() - started }
  }

  const targets =
    req.method === 'pg_dump'
      ? backupFileNames('postgres', req.filePath, o.databases.length ? o.databases : [target.profile.database ?? 'postgres'])
      : [{ file: req.filePath, databases: isSingleDatabase(db.info.engine) ? [''] : o.databases }]
  for (const f of targets) {
    if (ctl.isCancelled()) throw new BackupCancelled()
    // pg_dump's custom format is compressed already.
    const custom = req.method === 'pg_dump' && (req.native?.pgFormat ?? 'custom') === 'custom'
    const out = await files.createWriter(f.file, { gzip: req.compress && !custom })
    try {
      if (req.method === 'mysqldump') {
        if (o.usersAndGrants) warnings.push('mysqldump does not back up users and privileges; use the built-in backup for them')
        const { invocation, runs } = mysqlDumpInvocations(tool.path, t, { ...o, databases: f.databases }, { maria: isMariaDbTool(tool.tool, tool.banner), serverIsMaria: db.info.engine === 'mariadb' }, extra)
        for (const r of runs) await run(tools, { ...invocation, args: r.args }, { stdout: out }, ctl, onLine)
      } else if (req.method === 'pg_dump') {
        await run(tools, pgDumpInvocation(tool.path, t, f.databases[0], o, custom ? 'custom' : 'plain', extra), { stdout: out }, ctl, onLine)
      } else if (req.method === 'gbak') {
        await run(tools, gbakBackupInvocation(tool.path, t, undefined, extra), { stdout: out }, ctl, onLine)
      } else throw new Error(`Unknown backup method: ${req.method}`)
      await out.commit()
      bytes += out.bytesWritten()
      written.push(f.file)
    } catch (err) {
      await out.abort()
      throw ctl.isCancelled() ? new BackupCancelled() : err
    }
  }
  return { method: req.method, files: written, bytes, statements: 0, warnings, durationMs: Date.now() - started }
}

/** Restore with mysql / mariadb, pg_restore, psql or gbak. */
export async function runToolRestore(db: OpenDatabase, tools: BackupToolDeps, files: BackupFiles, req: RestoreRequest, target: ConnectionTarget, ctl: RestoreControl): Promise<RestoreResult> {
  const started = Date.now()
  const tool = await pickTool(db, tools, req.method, req.native?.toolPath)
  const t = toolTarget(target)
  const extra = req.native?.extraArgs ?? []
  let lines = 0
  let errors = 0
  const onLine = (line: string): void => {
    lines++
    if (/\berror\b/i.test(line)) {
      errors++
      ctl.error(line, '')
    }
    ctl.progress({ done: lines, errors, bytes: 0, totalBytes: 0 })
  }
  const database = req.createDatabase || req.database || target.profile.database || ''
  if (req.createDatabase && !isSingleDatabase(db.info.engine)) {
    await db.metaLock.run(() => db.meta.run(`CREATE DATABASE ${db.dialect.quoteIdent(req.createDatabase!)}`, null, { maxRows: 1, chunkSize: 1 }))
  }
  switch (req.method) {
    case 'mysql':
      await run(tools, mysqlRestoreInvocation(tool.path, t, { database: database || undefined, stopOnError: req.stopOnError }, extra), { stdinFile: req.filePath }, ctl, onLine)
      break
    case 'pg_restore': {
      if ((await files.head(req.filePath, 2)).compressed) throw new Error('pg_restore reads custom archives, not .gz files')
      await run(tools, pgRestoreInvocation(tool.path, t, database, req.filePath, { ...req.native, singleTransaction: req.singleTransaction, stopOnError: req.stopOnError }, extra), {}, ctl, onLine)
      break
    }
    case 'psql':
      await run(tools, psqlInvocation(tool.path, t, database, req, extra), { stdinFile: req.filePath }, ctl, onLine)
      break
    case 'gbak': {
      if (!req.file?.targetPath) throw new Error('Choose the database file to restore into')
      await run(tools, gbakRestoreInvocation(tool.path, t, req.file, 'stdin', extra), { stdinFile: req.filePath }, ctl, onLine)
      break
    }
    default:
      throw new Error(`Unknown restore method: ${req.method}`)
  }
  return { statements: 0, errors, warnings: [], durationMs: Date.now() - started }
}
