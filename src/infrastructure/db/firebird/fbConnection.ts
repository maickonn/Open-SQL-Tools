import Firebird from 'node-firebird'
import type { ColumnMetadata, Database, Options, Transaction } from 'node-firebird'
import type { EventEmitter } from 'node:events'
import type { ColumnMeta, ConnectionProfile, ConnectionSecrets, ServerInfo, TypeCategory } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, RunOutcome } from '@domain/ports/database'
import { capabilitiesFor, formatVersion, parseVersion } from '@domain/serverVersion'
import { ColumnarBuffer, formatDate } from '../common/columnar'
import type { Endpoint } from '../mysql-family/mysqlConnection'

const T = {
  TEXT: 452, VARYING: 448, SHORT: 500, LONG: 496, FLOAT: 482, DOUBLE: 480, D_FLOAT: 530, TIMESTAMP: 510, BLOB: 520,
  ARRAY: 540, QUAD: 550, TIME: 560, DATE: 570, INT64: 580, INT128: 32752, TIMESTAMP_TZ: 32754, TIMESTAMP_TZ_EX: 32748,
  TIME_TZ: 32756, TIME_TZ_EX: 32750, DEC16: 32760, DEC34: 32762, BOOLEAN: 32764, NULL: 32766
} as const

const STMT_SELECT = 1
const STMT_EXEC_PROCEDURE = 8
const STMT_SELECT_FOR_UPDATE = 12
const OCTETS_CHARSET = 1
/** Binary BLOBs larger than this are truncated in grids; full values load on demand. */
const MAX_INLINE_BLOB = 16 * 1024 * 1024

function typeInfo(m: ColumnMetadata): { name: string; category: TypeCategory } {
  const type = m.type & ~1
  const scaled = (m.scale ?? 0) < 0
  const charset = (m.subType ?? 0) & 0xff
  switch (type) {
    case T.SHORT: return scaled ? { name: 'NUMERIC', category: 'decimal' } : { name: 'SMALLINT', category: 'integer' }
    case T.LONG: return scaled ? { name: 'NUMERIC', category: 'decimal' } : { name: 'INTEGER', category: 'integer' }
    case T.INT64: return scaled ? { name: 'NUMERIC', category: 'decimal' } : { name: 'BIGINT', category: 'integer' }
    case T.INT128: return scaled ? { name: 'NUMERIC', category: 'decimal' } : { name: 'INT128', category: 'integer' }
    case T.FLOAT: return { name: 'FLOAT', category: 'float' }
    case T.DOUBLE: case T.D_FLOAT: return { name: 'DOUBLE PRECISION', category: 'float' }
    case T.DEC16: return { name: 'DECFLOAT(16)', category: 'decimal' }
    case T.DEC34: return { name: 'DECFLOAT(34)', category: 'decimal' }
    case T.DATE: return { name: 'DATE', category: 'datetime' }
    case T.TIME: return { name: 'TIME', category: 'datetime' }
    case T.TIMESTAMP: return { name: 'TIMESTAMP', category: 'datetime' }
    case T.TIME_TZ: case T.TIME_TZ_EX: return { name: 'TIME WITH TIME ZONE', category: 'datetime' }
    case T.TIMESTAMP_TZ: case T.TIMESTAMP_TZ_EX: return { name: 'TIMESTAMP WITH TIME ZONE', category: 'datetime' }
    case T.BOOLEAN: return { name: 'BOOLEAN', category: 'boolean' }
    case T.TEXT: return charset === OCTETS_CHARSET ? { name: 'BINARY', category: 'binary' } : { name: 'CHAR', category: 'string' }
    case T.VARYING: return charset === OCTETS_CHARSET ? { name: 'VARBINARY', category: 'binary' } : { name: 'VARCHAR', category: 'string' }
    case T.BLOB: return m.subType === 1 ? { name: 'BLOB SUB_TYPE TEXT', category: 'text' } : { name: 'BLOB', category: 'binary' }
    default: return { name: `TYPE_${type}`, category: 'other' }
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Per-column converter applied before values are buffered. */
function converterFor(m: ColumnMetadata): ((v: unknown) => unknown) | null {
  const type = m.type & ~1
  if (type === T.DATE) {
    return (v) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : v)
  }
  if (type === T.TIME || type === T.TIME_TZ || type === T.TIME_TZ_EX) {
    return (v) => (v instanceof Date ? formatDate(v).slice(11) : v)
  }
  return null
}

function readBinaryBlob(fn: (tx: Transaction, cb: (err: unknown, name: string, e: EventEmitter) => void) => void, tx: Transaction): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fn(tx, (err, _name, e) => {
      if (err) {
        reject(err)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      e.on('data', (chunk: Buffer) => {
        if (size < MAX_INLINE_BLOB) chunks.push(chunk)
        size += chunk.length
      })
      e.on('end', () => resolve(Buffer.concat(chunks)))
      e.on('error', reject)
    })
  })
}

/** Sentinel used to stop `sequentially` once enough rows were read. */
const STOP = new Error('fetch limit reached')

export class FbConnection implements DbConnection {
  private db: Database | null = null
  private tx: Transaction | null = null
  private autocommit = true
  info: ServerInfo | null = null

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly secrets: ConnectionSecrets,
    private readonly endpoint: Endpoint
  ) {}

  private options(): Options {
    const p = this.profile
    return {
      host: this.endpoint.host,
      port: this.endpoint.port,
      database: p.database ?? '',
      user: p.user,
      password: this.secrets.password ?? '',
      role: p.options.role || undefined,
      encoding: (p.options.charset || 'UTF8') as Options['encoding'],
      lowercase_keys: false,
      blobAsText: true,
      numericMode: 'string',
      wireCrypt: p.options.wireCrypt === 'disabled' ? Firebird.WIRE_CRYPT_DISABLE : Firebird.WIRE_CRYPT_ENABLE,
      wireCompression: !!p.options.wireCompression,
      connectTimeout: (p.options.connectTimeoutSec ?? 15) * 1000,
      retryConnectionInterval: 1000,
      enableKeepAlive: true
    }
  }

  async connect(): Promise<ServerInfo> {
    this.db = await Firebird.attachAsync(this.options())
    const rows = (await this.db.queryAsync<Record<string, unknown>>(
      "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS V, CURRENT_USER AS U FROM RDB$DATABASE"
    )) as Record<string, unknown>[]
    const versionString = String(rows[0]?.V ?? '')
    const version = parseVersion(versionString)
    this.info = {
      engine: 'firebird',
      versionString,
      version,
      label: `Firebird ${formatVersion(version)}`,
      capabilities: capabilitiesFor('firebird', version),
      currentUser: String(rows[0]?.U ?? '').trim(),
      currentDatabase: this.profile.database
    }
    return this.info
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('Not connected')
    return this.db
  }

  async close(): Promise<void> {
    const db = this.db
    this.db = null
    if (!db) return
    if (this.tx) await this.tx.rollbackAsync().catch(() => undefined)
    this.tx = null
    await db.detachAsync().catch(() => undefined)
  }

  async ping(): Promise<void> {
    await this.requireDb().queryAsync('SELECT 1 FROM RDB$DATABASE')
  }

  private async startTransaction(readOnly = false): Promise<Transaction> {
    return this.requireDb().transactionAsync(readOnly ? Firebird.ISOLATION_READ_COMMITTED_READ_ONLY : Firebird.ISOLATION_READ_COMMITTED)
  }

  async run(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const head = sql.trimStart().slice(0, 30).toUpperCase()
    // Transaction control statements map onto the driver's transaction handle.
    if (/^COMMIT\b/.test(head)) {
      await this.commit()
      return { hasResultSet: false, rowCount: 0, truncated: false }
    }
    if (/^ROLLBACK\b/.test(head) && !/^ROLLBACK\s+TO\b/.test(head)) {
      await this.rollback()
      return { hasResultSet: false, rowCount: 0, truncated: false }
    }
    const ownTx = this.autocommit || (options.readOnly && !this.tx)
    const tx = ownTx ? await this.startTransaction(options.readOnly) : (this.tx ??= await this.startTransaction())
    try {
      const outcome = await this.runIn(tx, sql, sink, options)
      if (ownTx) await (options.readOnly ? tx.rollbackAsync() : tx.commitAsync())
      return outcome
    } catch (err) {
      if (ownTx) await tx.rollbackAsync().catch(() => undefined)
      throw err
    }
  }

  private async runIn(tx: Transaction, sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const stmt = await tx.newStatementAsync(sql)
    const output = ((stmt as unknown as { output?: ColumnMetadata[] }).output ?? []).slice()
    const type = (stmt as unknown as { type?: number }).type
    await stmt.releaseAsync().catch(() => undefined)

    const columns: ColumnMeta[] = output.map((m) => {
      const info = typeInfo(m)
      return { name: m.alias || m.field || '', type: info.name, category: info.category, table: m.relation || undefined, orgName: m.field || undefined, nullable: m.nullable }
    })

    if (output.length && (type === STMT_SELECT || type === STMT_SELECT_FOR_UPDATE)) {
      sink?.start(columns)
      const buffer = sink ? new ColumnarBuffer(columns.length, options.chunkSize, sink) : null
      const converters = output.map(converterFor)
      let rowCount = 0
      let truncated = false
      try {
        await tx.sequentiallyAsync(
          sql,
          [],
          async (row: unknown[]) => {
            if (rowCount >= options.maxRows) {
              truncated = true
              throw STOP
            }
            for (let c = 0; c < row.length; c++) {
              const v = row[c]
              if (typeof v === 'function') row[c] = await readBinaryBlob(v as never, tx)
              else if (converters[c] && v !== null) row[c] = converters[c]!(v)
            }
            buffer?.pushRow(row)
            rowCount++
          },
          { asObject: false } as never
        )
      } catch (err) {
        if (err !== STOP) throw err
      }
      buffer?.flush()
      sink?.end({ rowCount, truncated })
      return { hasResultSet: true, rowCount, truncated }
    }

    const result = (await tx.executeAsync(sql, [], { withMeta: true })) as unknown as {
      rows?: unknown[] | Record<string, unknown>
      affectedRows?: number
    }
    if (output.length && type === STMT_EXEC_PROCEDURE) {
      // EXECUTE PROCEDURE / RETURNING: a single output row.
      const raw = result?.rows
      const row = Array.isArray(raw) ? (Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw) : raw ? Object.values(raw) : []
      sink?.start(columns)
      if (sink && row.length) {
        const buffer = new ColumnarBuffer(columns.length, 1, sink)
        buffer.pushRow(row)
      }
      sink?.end({ rowCount: row.length ? 1 : 0, truncated: false })
      return { hasResultSet: true, rowCount: row.length ? 1 : 0, affectedRows: result?.affectedRows, truncated: false }
    }
    return { hasResultSet: false, rowCount: 0, affectedRows: result?.affectedRows, truncated: false }
  }

  async cancel(): Promise<void> {
    await this.requireDb().cancelAsync()
  }

  async useDatabase(): Promise<void> {
    // A Firebird attachment is bound to a single database file.
  }

  currentDatabase(): string | undefined {
    return this.profile.database
  }

  async setAutocommit(enabled: boolean): Promise<void> {
    if (enabled && this.tx) await this.commit()
    this.autocommit = enabled
  }

  async commit(): Promise<void> {
    const tx = this.tx
    this.tx = null
    if (tx) await tx.commitAsync()
  }

  async rollback(): Promise<void> {
    const tx = this.tx
    this.tx = null
    if (tx) await tx.rollbackAsync()
  }

  inTransaction(): boolean {
    return this.tx !== null
  }
}
