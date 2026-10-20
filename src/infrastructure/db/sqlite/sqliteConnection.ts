import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CellValue, ColumnMeta, ConnectionProfile, ServerInfo, TypeCategory } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, RunOutcome } from '@domain/ports/database'
import { capabilitiesFor, formatVersion, parseVersion } from '@domain/serverVersion'
import { normalizeValue } from '../common/columnar'
import type { ProcessColumn, ProcessRequest, ProcessResponse } from './sqliteProtocol'

/** Lock wait for user statements; forms and tree actions pass a shorter one. */
const DEFAULT_LOCK_TIMEOUT_SEC = 30

/** The bundle ships sqliteProcess.js next to connectionWorker.js; tests run the .mts source. */
function processFile(): string {
  const built = join(__dirname, 'sqliteProcess.js')
  return existsSync(built) ? built : join(__dirname, 'sqliteProcess.mts')
}

/** Category from SQLite's type affinity rules (declared type), or from a sample value for expressions. */
export function sqliteCategory(declared: string | null, sample?: unknown): TypeCategory {
  if (declared) {
    const t = declared.toUpperCase()
    if (t.includes('INT')) return 'integer'
    if (/BOOL/.test(t)) return 'boolean'
    if (/DATE|TIME/.test(t)) return 'datetime'
    if (/JSON/.test(t)) return 'json'
    if (/CHAR|CLOB/.test(t)) return 'string'
    if (/TEXT/.test(t)) return 'text'
    if (/BLOB/.test(t)) return 'binary'
    if (/REAL|FLOA|DOUB/.test(t)) return 'float'
    if (/NUM|DEC/.test(t)) return 'decimal'
    return 'other'
  }
  if (typeof sample === 'number') return Number.isInteger(sample) ? 'integer' : 'float'
  if (typeof sample === 'string') return 'string'
  if (sample instanceof Uint8Array) return 'binary'
  return 'other'
}

/** A process request without its id (distributes over the union). */
type RequestBody = ProcessRequest extends infer R ? (R extends ProcessRequest ? Omit<R, 'id'> : never) : never

interface Pending {
  sink: ResultSink | null
  resolve(value: ProcessResponse): void
  reject(err: Error): void
}

class SqliteError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly errcode?: number
  ) {
    super(message)
  }
}

/**
 * One SQLite connection, hosted in a child process (Electron runs it as plain Node). Cancelling
 * kills the process, since node:sqlite has no interrupt, and reopens the file; SQLite rolls back an
 * open transaction from its journal.
 */
export class SqliteConnection implements DbConnection {
  private worker: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private autocommit = true
  private tx = false
  private busyTimeoutSec = DEFAULT_LOCK_TIMEOUT_SEC
  /** `PRAGMA foreign_keys = ON` requested inside a transaction, applied once it ends. */
  private pendingForeignKeys: string | null = null
  /** Set while the process is replaced after a cancel; requests wait for it. */
  private reopening: Promise<unknown> | null = null
  info: ServerInfo | null = null

  constructor(private readonly profile: ConnectionProfile) {}

  private get path(): string {
    return (this.profile.database ?? '').trim()
  }

  private spawn(): ChildProcess {
    const worker = fork(processFile(), [], {
      // Electron's executable runs the script as Node; "advanced" keeps Uint8Array and BigInt values.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    worker.on('message', (msg: ProcessResponse) => this.onMessage(msg))
    // Only the current process's failures reach pending requests; a cancelled one was already settled.
    worker.on('error', (err) => {
      if (this.worker === worker) this.failAll(err)
    })
    worker.on('exit', () => {
      if (this.worker !== worker) return
      this.worker = null
      this.failAll(new Error('The SQLite connection was closed'))
    })
    this.worker = worker
    return worker
  }

  private onMessage(msg: ProcessResponse): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    switch (msg.type) {
      case 'start':
        p.sink?.start(msg.columns.map(toColumnMeta))
        return
      case 'rows':
        p.sink?.rows(msg.columns.map((col) => col.map(normalizeValue)) as CellValue[][], msg.count)
        return
      case 'error':
        this.pending.delete(msg.id)
        p.reject(new SqliteError(msg.message, msg.code, msg.errcode))
        return
      default:
        this.pending.delete(msg.id)
        p.resolve(msg)
    }
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(err)
  }

  private async request(msg: RequestBody, sink: ResultSink | null = null): Promise<ProcessResponse> {
    if (this.reopening && msg.type !== 'open') await this.reopening.catch(() => undefined)
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('Not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { sink, resolve, reject })
      worker.send({ ...msg, id })
    })
  }

  private async open(): Promise<string> {
    this.spawn()
    const res = await this.request({ type: 'open', path: this.path, readOnly: !!this.profile.options.readOnly, busyTimeoutMs: this.busyTimeoutSec * 1000 })
    return res.type === 'ok' ? (res.value ?? '') : ''
  }

  async connect(): Promise<ServerInfo> {
    const path = this.path
    if (!path) throw new Error('Choose the SQLite database file')
    if (path !== ':memory:' && !existsSync(path)) {
      if (this.profile.options.readOnly) throw new Error(`The database file does not exist: ${path}`)
      if (!this.profile.options.createIfMissing) throw new Error(`The database file does not exist: ${path}. Enable "Create if missing" to create it.`)
    }
    const versionString = await this.open()
    const version = parseVersion(versionString)
    this.info = {
      engine: 'sqlite',
      versionString,
      version,
      label: `SQLite ${formatVersion(version)}`,
      capabilities: capabilitiesFor('sqlite', version)
    }
    return this.info
  }

  async close(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    await this.request({ type: 'close' }).catch(() => undefined)
    this.worker = null
    if (worker.exitCode === null) worker.kill()
  }

  async ping(): Promise<void> {
    await this.exec('SELECT 1')
  }

  private async exec(sql: string, sink: ResultSink | null = null, maxRows = 1000, chunkSize = 1000, readOnly = false): Promise<Extract<ProcessResponse, { type: 'end' }>> {
    const res = await this.request({ type: 'run', sql, maxRows, chunkSize, readOnly }, sink)
    if (res.type !== 'end') throw new Error('Unexpected SQLite response')
    return res
  }

  async run(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const head = sql.trimStart().slice(0, 30).toUpperCase()
    const lockTimeout = options.lockTimeoutSec ?? DEFAULT_LOCK_TIMEOUT_SEC
    if (lockTimeout !== this.busyTimeoutSec) {
      await this.exec(`PRAGMA busy_timeout = ${Math.round(lockTimeout * 1000)}`)
      this.busyTimeoutSec = lockTimeout
    }
    // foreign_keys is a no-op inside a transaction (SQLite ignores it). Table rebuilds switch it
    // off before their transaction starts and back on after it ends.
    const foreignKeys = /^PRAGMA\s+FOREIGN_KEYS\s*=\s*(\w+)/.exec(head)
    if (foreignKeys) {
      if (this.tx) {
        if (/^(OFF|0|FALSE|NO)$/.test(foreignKeys[1])) throw new Error('Commit or roll back the open transaction first: foreign key enforcement cannot be switched off inside a transaction.')
        this.pendingForeignKeys = sql
        return { hasResultSet: false, rowCount: 0, truncated: false }
      }
      await this.exec(sql)
      return { hasResultSet: false, rowCount: 0, truncated: false }
    }
    // Manual-commit mode opens a transaction before the first statement, like the other engines.
    if (!this.autocommit && !this.tx && !/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(head) && !options.readOnly) {
      await this.exec('BEGIN')
      this.tx = true
    }
    const res = await this.exec(sql, sink, options.maxRows, options.chunkSize, !!options.readOnly)
    if (/^BEGIN\b/.test(head)) this.tx = true
    else if (/^(COMMIT|END)\b/.test(head) || (/^ROLLBACK\b/.test(head) && !/^ROLLBACK\s+(TRANSACTION\s+)?TO\b/.test(head))) await this.ended()
    if (res.hasResultSet) sink?.end({ rowCount: res.rowCount, truncated: res.truncated })
    return { hasResultSet: res.hasResultSet, rowCount: res.rowCount, affectedRows: res.hasResultSet ? undefined : res.changes, truncated: res.truncated }
  }

  /** node:sqlite cannot interrupt a statement: the process is killed and the file reopened. */
  async cancel(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    // Statements issued while the process is replaced wait for the new one.
    const reopen = (async () => {
      await new Promise<void>((resolve) => {
        if (worker.exitCode !== null || worker.signalCode !== null) return resolve()
        worker.once('exit', () => resolve())
        worker.kill('SIGKILL')
      })
      this.tx = false
      this.busyTimeoutSec = DEFAULT_LOCK_TIMEOUT_SEC
      await this.open()
    })()
    this.reopening = reopen
    this.failAll(new Error('Query cancelled'))
    try {
      await reopen
    } finally {
      if (this.reopening === reopen) this.reopening = null
    }
  }

  async explainPlan(sql: string): Promise<string> {
    const lines: string[] = []
    const sink: ResultSink = {
      start() {},
      rows(columns, count) {
        // EXPLAIN QUERY PLAN columns: id, parent, notused, detail
        for (let r = 0; r < count; r++) lines.push(String(columns[3][r] ?? ''))
      },
      end() {}
    }
    await this.exec(`EXPLAIN QUERY PLAN ${sql}`, sink)
    return lines.join('\n')
  }

  async useDatabase(): Promise<void> {
    // A SQLite connection is bound to one file ("main").
  }

  /** Single-database engine: objects are addressed without a database, like Firebird. */
  currentDatabase(): string | undefined {
    return undefined
  }

  async setAutocommit(enabled: boolean): Promise<void> {
    if (enabled && this.tx) await this.commit()
    this.autocommit = enabled
  }

  async commit(): Promise<void> {
    if (!this.tx) return
    await this.exec('COMMIT')
    await this.ended()
  }

  async rollback(): Promise<void> {
    if (!this.tx) return
    try {
      await this.exec('ROLLBACK')
    } finally {
      await this.ended()
    }
  }

  /** The transaction is over: apply what had to wait for it. */
  private async ended(): Promise<void> {
    this.tx = false
    const pragma = this.pendingForeignKeys
    this.pendingForeignKeys = null
    if (pragma) await this.exec(pragma)
  }

  inTransaction(): boolean {
    return this.tx
  }
}

function toColumnMeta(c: ProcessColumn): ColumnMeta {
  return { name: c.name, type: c.declared ?? '', category: sqliteCategory(c.declared, c.sample), table: c.table, orgName: c.column }
}
