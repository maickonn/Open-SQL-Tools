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
  RestoreResult
} from '@shared/model'
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
          await native.restore(req.filePath, req.file, (done, total) => ctl.progress({ done: 0, errors: 0, bytes: done, totalBytes: total ?? 0 }), signal.signal)
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
          return await runToolRestore(db, this.requireTools(), this.deps.files, req, target, ctl)
        } finally {
          if (replacesCurrent) await ctl.reopen()
        }
      }
    }
  }

  async inspect(db: OpenDatabase, filePath: string): Promise<BackupFileInfo> {
    const head = await this.deps.files.head(filePath, 64 * 1024)
    const sniffed = sniffBackupFile(head.bytes, head.compressed, head.size, db.info.engine)
    const info = serviceRestoreSupported(db) ? sniffed : { ...sniffed, methods: sniffed.methods.filter((m) => m !== 'firebird-service') }
    // Firebird backups (.fbk) carry no magic number.
    if (info.kind === 'unknown' && db.info.engine === 'firebird' && /\.(fbk|gbk)(\.gz)?$/i.test(filePath)) {
      return { ...info, kind: 'fbk', methods: serviceRestoreSupported(db) ? ['gbak', 'firebird-service'] : ['gbak'] }
    }
    return info
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

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
