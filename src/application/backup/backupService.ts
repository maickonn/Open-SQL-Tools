import type {
  AppSettings,
  BackupFileInfo,
  BackupRequest,
  BackupResult,
  BackupToolInfo,
  ConnectionProfile,
  ConnectionSecrets,
  DbEngine,
  RestoreRequest,
  RestoreResult,
  ServerInfo,
  StandaloneRestoreRequest
} from '@shared/model'
import { capabilitiesFor, encodeVersion } from '@domain/serverVersion'
import type { OpenDatabase } from '@domain/ports/database'
import type { BackupFiles, EngineNativeBackup, NativeToolRunner, ToolLocator } from '@domain/ports/backup'
import { sniffBackupFile } from '@domain/backup/backupHeader'
import { isMariaDbTool, toolCompatibility } from '@domain/backup/toolVersion'
import { runLogicalBackup, type BackupControl } from './logical/logicalBackup'
import { runLogicalRestore, type RestoreControl } from './restore/logicalRestore'
import { runToolBackup, runToolRestore } from './native/toolBackup'

export interface ConnectionTarget {
  profile: ConnectionProfile
  secrets: ConnectionSecrets
  /** Where the session connects: the server, or the local end of its SSH tunnel. */
  endpoint: { host: string; port: number }
}

export interface BackupToolDeps {
  locator: ToolLocator
  runner: NativeToolRunner
}

/** Engine-native backup of the session's database (null when the engine has none). */
export type NativeBackupFactory = (engine: DbEngine, target: ConnectionTarget) => EngineNativeBackup | null

export interface BackupServiceDeps {
  files: BackupFiles
  tools?: BackupToolDeps
  native?: NativeBackupFactory
}

export type RestoreRunControl = RestoreControl & {
  /** Reconnects the session after its database file was replaced. */
  reopen(): Promise<void>
}

/** Routes backups and restores to the built-in script, the engine-native path or a client tool. */
export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  async backup(db: OpenDatabase, req: BackupRequest, target: ConnectionTarget, ctl: BackupControl): Promise<BackupResult> {
    const started = Date.now()
    switch (req.method) {
      case 'logical':
        if (!req.logical) throw new Error('Missing backup options')
        return runLogicalBackup(db, this.deps.files, { filePath: req.filePath, compress: req.compress, options: req.logical }, ctl)
      case 'sqlite-file':
      case 'firebird-service': {
        const native = this.native(db.info.engine, target)
        const signal = abortSignal(ctl)
        const dest = req.method === 'firebird-service' ? (req.native?.serverPath ?? '') : req.filePath
        if (!dest) throw new Error('Choose where the backup is written')
        try {
          await native.backup(dest, { gzip: req.method === 'sqlite-file' && req.compress }, (done, total, line) => ctl.progress({ phase: 'tool', object: line, done, total, bytes: 0 }), signal.signal)
        } finally {
          signal.dispose()
        }
        return { method: req.method, files: [dest], bytes: 0, statements: 0, warnings: [], durationMs: Date.now() - started }
      }
      default:
        return runToolBackup(db, this.requireTools(), this.deps.files, req, target, ctl)
    }
  }

  async restore(db: OpenDatabase, req: RestoreRequest, target: ConnectionTarget, ctl: RestoreRunControl): Promise<RestoreResult> {
    const started = Date.now()
    switch (req.method) {
      case 'logical':
        return runLogicalRestore(db, this.deps.files, req, ctl)
      case 'sqlite-file':
      case 'firebird-service': {
        if (req.method === 'firebird-service' && !serviceRestoreSupported(db)) throw new Error(SERVICE_RESTORE_UNSUPPORTED)
        const native = this.native(db.info.engine, target)
        if (!req.file?.targetPath) throw new Error('Choose the database file to restore into')
        const current = target.profile.database
        const replacesCurrent = !!current && samePath(req.file.targetPath, current)
        // The file being replaced cannot stay attached.
        if (replacesCurrent) await db.close()
        const signal = abortSignal(ctl)
        try {
          await native.restore(req.filePath, req.file, (done, total, line) => ctl.progress({ done, errors: 0, bytes: 0, totalBytes: total ?? 0, line }), signal.signal)
        } finally {
          signal.dispose()
          if (replacesCurrent) await ctl.reopen()
        }
        return { statements: 0, errors: 0, warnings: [], durationMs: Date.now() - started }
      }
      default: {
        // gbak -rep cannot replace a database the session still has attached.
        const current = target.profile.database
        const replacesCurrent = req.method === 'gbak' && !!req.file?.targetPath && !!current && samePath(req.file.targetPath, current)
        if (replacesCurrent) await db.close()
        try {
          const toolDb = {
            info: db.info,
            createDatabase: (name: string) =>
              db.metaLock.run(async () => {
                await db.meta.run(`CREATE DATABASE ${db.dialect.quoteIdent(name)}`, null, { maxRows: 1, chunkSize: 1 })
              })
          }
          return await runToolRestore(toolDb, this.requireTools(), this.deps.files, req, target, ctl)
        } finally {
          if (replacesCurrent) await ctl.reopen()
        }
      }
    }
  }

  /**
   * Firebird restore into a database file with nothing attached (the Session Manager's restore):
   * gbak or the services API rebuild it from a .fbk, a built-in SQL backup runs into a new file.
   */
  async restoreStandalone(target: ConnectionTarget, req: StandaloneRestoreRequest, ctl: RestoreControl, open: (profile: ConnectionProfile) => Promise<OpenDatabase>): Promise<RestoreResult> {
    const started = Date.now()
    if (target.profile.engine !== 'firebird') throw new Error('Restoring without a session is only available for Firebird')
    if (!req.targetPath) throw new Error('Choose the database file to restore into')
    if (!req.filePath) throw new Error('Choose the backup file')
    const native = this.native('firebird', target)
    const file = { targetPath: req.targetPath, replace: req.replace, pageSize: req.pageSize, verbose: req.verbose, noValidity: req.noValidity }
    const done = (r: Partial<RestoreResult> = {}): RestoreResult => ({ statements: 0, errors: 0, warnings: [], ...r, durationMs: Date.now() - started })
    switch (req.method) {
      case 'firebird-service': {
        const signal = abortSignal(ctl)
        try {
          await native.restore(req.filePath, file, (n, total, line) => ctl.progress({ done: n, errors: 0, bytes: 0, totalBytes: total ?? 0, line }), signal.signal)
        } finally {
          signal.dispose()
        }
        return done()
      }
      case 'gbak': {
        const info = firebirdServerInfo(await native.serverVersion?.().catch(() => '') ?? '')
        const r = await runToolRestore({ info }, this.requireTools(), this.deps.files, {
          operationId: req.operationId,
          filePath: req.filePath,
          method: 'gbak',
          stopOnError: req.stopOnError,
          singleTransaction: false,
          commitEvery: 100,
          file,
          native: req.toolPath ? { toolPath: req.toolPath } : undefined
        }, target, ctl)
        return done(r)
      }
      case 'logical': {
        if (!native.createDatabase || !native.dropDatabase) throw new Error('This server cannot create databases here')
        if (req.replace) await native.dropDatabase(req.targetPath).catch(() => undefined)
        await native.createDatabase(req.targetPath, { pageSize: req.pageSize, charset: req.charset })
        let db: OpenDatabase | null = null
        try {
          db = await open({ ...target.profile, database: req.targetPath })
          const r = await runLogicalRestore(db, this.deps.files, { operationId: req.operationId, filePath: req.filePath, method: 'logical', stopOnError: req.stopOnError, singleTransaction: false, commitEvery: 100 }, ctl)
          return done(r)
        } catch (err) {
          // A cancelled restore leaves no half-built database behind.
          if (ctl.isCancelled()) {
            await db?.close().catch(() => undefined)
            db = null
            await native.dropDatabase(req.targetPath).catch(() => undefined)
          }
          throw err
        } finally {
          await db?.close().catch(() => undefined)
        }
      }
      default:
        throw new Error(`Unknown restore method: ${String(req.method)}`)
    }
  }

  async inspect(db: OpenDatabase, filePath: string): Promise<BackupFileInfo> {
    return inspectBackupHead(filePath, await this.deps.files.head(filePath, 64 * 1024), db.info.engine, serviceRestoreSupported(db))
  }

  async detectTools(db: OpenDatabase, paths?: AppSettings['backupTools']): Promise<BackupToolInfo[]> {
    if (!this.deps.tools) return []
    const found = await this.deps.tools.locator.detect(db.info.engine, paths?.paths, paths?.searchDirs)
    return found.map((t) => ({ tool: t.tool, path: t.path, version: t.version, ...toolCompatibility(t.tool, t.version, db.info, isMariaDbTool(t.tool, t.banner)) }))
  }

  private native(engine: DbEngine, target: ConnectionTarget): EngineNativeBackup {
    const n = this.deps.native?.(engine, target)
    if (!n) throw new Error('This engine has no native backup')
    return n
  }

  private requireTools(): BackupToolDeps {
    if (!this.deps.tools) throw new Error('External backup tools are not available')
    return this.deps.tools
  }
}

/**
 * Firebird 2.5's server crashes (segmentation fault) now and then when it restores through the
 * services API while it serves other attachments; gbak as a client process or the built-in SQL
 * backup restore safely there.
 */
export function serviceRestoreSupported(db: OpenDatabase): boolean {
  return db.info.engine !== 'firebird' || db.info.version >= 30000
}

const SERVICE_RESTORE_UNSUPPORTED = 'Firebird 2.5 can crash when it restores through the services API: restore with gbak or from a built-in SQL backup'

/** An AbortSignal that fires when the operation is cancelled. */
function abortSignal(ctl: { onAbort(abort: (() => Promise<void>) | null): void }): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  ctl.onAbort(async () => controller.abort())
  return { signal: controller.signal, dispose: () => ctl.onAbort(null) }
}

/** What a backup file holds, from its first bytes; `serviceRestore` offers the Firebird services restore. */
export function inspectBackupHead(filePath: string, head: { bytes: Uint8Array; compressed: boolean; size: number }, engine: DbEngine, serviceRestore = true): BackupFileInfo {
  const sniffed = sniffBackupFile(head.bytes, head.compressed, head.size, engine)
  const info = serviceRestore ? sniffed : { ...sniffed, methods: sniffed.methods.filter((m) => m !== 'firebird-service') }
  // Firebird backups (.fbk) carry no magic number.
  if (info.kind === 'unknown' && engine === 'firebird' && /\.(fbk|gbk)(\.gz)?$/i.test(filePath)) {
    return { ...info, kind: 'fbk', methods: serviceRestore ? ['gbak', 'firebird-service'] : ['gbak'] }
  }
  return info
}

/** ServerInfo of a Firebird server known only by its services version string (e.g. "LI-V2.5.9.27139 Firebird 2.5"). */
export function firebirdServerInfo(versionString: string): ServerInfo {
  const m = /V(\d+)\.(\d+)\.(\d+)/.exec(versionString) ?? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionString)
  const version = m ? encodeVersion(Number(m[1]), Number(m[2]), Number(m[3] ?? 0)) : 0
  return { engine: 'firebird', versionString, version, label: m ? `Firebird ${m[1]}.${m[2]}.${m[3] ?? 0}` : 'Firebird', capabilities: capabilitiesFor('firebird', version) }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
