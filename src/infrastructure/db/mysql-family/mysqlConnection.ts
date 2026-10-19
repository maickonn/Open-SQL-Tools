import mysql from 'mysql2'
import type { Connection, ConnectionOptions, FieldPacket } from 'mysql2'
import { readFileSync } from 'node:fs'
import type { ColumnMeta, ConnectionProfile, ConnectionSecrets, ServerInfo, TypeCategory } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, RunOutcome } from '@domain/ports/database'
import { capabilitiesFor, formatVersion, parseMySqlFamilyVersion } from '@domain/serverVersion'
import { ColumnarBuffer } from '../common/columnar'
import { mariadbAuthPlugins } from './mariadbAuth'

const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP',
  8: 'BIGINT', 9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 14: 'DATE', 15: 'VARCHAR',
  16: 'BIT', 17: 'TIMESTAMP', 18: 'DATETIME', 19: 'TIME', 242: 'VECTOR', 245: 'JSON', 246: 'DECIMAL', 247: 'ENUM',
  248: 'SET', 249: 'TINYBLOB', 250: 'MEDIUMBLOB', 251: 'LONGBLOB', 252: 'BLOB', 253: 'VARCHAR', 254: 'CHAR', 255: 'GEOMETRY'
}

const BINARY_CHARSET = 63

function categorize(typeId: number, charset: number): TypeCategory {
  switch (typeId) {
    case 1: case 2: case 3: case 8: case 9: case 13:
      return 'integer'
    case 0: case 246:
      return 'decimal'
    case 4: case 5:
      return 'float'
    case 7: case 10: case 11: case 12: case 14: case 17: case 18: case 19:
      return 'datetime'
    case 245:
      return 'json'
    case 16: case 255: case 242:
      return 'binary'
    case 249: case 250: case 251: case 252:
      return charset === BINARY_CHARSET ? 'binary' : 'text'
    case 15: case 253: case 254:
      return charset === BINARY_CHARSET ? 'binary' : 'string'
    case 247: case 248:
      return 'string'
    default:
      return 'other'
  }
}

export function toColumnMeta(f: FieldPacket): ColumnMeta {
  const typeId = f.columnType ?? f.type ?? 253
  const charset = f.characterSet ?? 0
  let type = TYPE_NAMES[typeId] ?? `TYPE_${typeId}`
  if (charset === BINARY_CHARSET) {
    if (typeId === 253) type = 'VARBINARY'
    else if (typeId === 254) type = 'BINARY'
  } else if (typeId === 252) type = 'TEXT'
  return {
    name: f.name,
    type,
    category: categorize(typeId, charset),
    table: f.orgTable || f.table || undefined,
    orgName: f.orgName || undefined,
    nullable: f.flags !== undefined ? (Number(f.flags) & 1) === 0 : undefined
  }
}

/** ER_QUERY_INTERRUPTED: raised on the victim connection after KILL QUERY. */
const QUERY_INTERRUPTED = 1317

export interface Endpoint {
  host: string
  port: number
}

export class MySqlConnection implements DbConnection {
  private conn: Connection | null = null
  private threadId = 0
  private database: string | undefined
  private autocommit = true
  private inTx = false
  private killer: (() => Promise<void>) | null = null
  private killRequested = false
  noBackslashEscapes = false
  info: ServerInfo | null = null

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly secrets: ConnectionSecrets,
    private readonly endpoint: Endpoint
  ) {
    this.database = profile.database || undefined
  }

  /** Lets the session register a side channel used for KILL QUERY. */
  setKiller(killer: () => Promise<void>): void {
    this.killer = killer
  }

  get connectionId(): number {
    return this.threadId
  }

  private options(): ConnectionOptions {
    const p = this.profile
    const opts: ConnectionOptions = {
      host: this.endpoint.host,
      port: this.endpoint.port,
      user: p.user,
      password: this.secrets.password ?? '',
      database: this.database,
      // mysql2 accepts charset or collation names; default keeps full Unicode support.
      charset: p.options.charset || 'UTF8MB4_UNICODE_CI',
      connectTimeout: (p.options.connectTimeoutSec ?? 15) * 1000,
      rowsAsArray: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      jsonStrings: true,
      multipleStatements: false,
      enableKeepAlive: true,
      // MariaDB ed25519 / parsec accounts.
      authPlugins: mariadbAuthPlugins as unknown as ConnectionOptions['authPlugins']
    }
    if (p.ssl.enabled) {
      opts.ssl = {
        rejectUnauthorized: p.ssl.rejectUnauthorized,
        ca: p.ssl.caPath ? readFileSync(p.ssl.caPath, 'utf8') : undefined,
        cert: p.ssl.certPath ? readFileSync(p.ssl.certPath, 'utf8') : undefined,
        key: p.ssl.keyPath ? readFileSync(p.ssl.keyPath, 'utf8') : undefined
      }
    }
    return opts
  }

  async connect(): Promise<ServerInfo> {
    const conn = mysql.createConnection(this.options())
    await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())))
    conn.on('error', () => {
      // Fatal errors surface on the next query; swallow to avoid unhandled 'error' events.
    })
    this.conn = conn
    this.threadId = conn.threadId ?? 0
    const r = await this.simple('SELECT VERSION(), CURRENT_USER(), DATABASE(), @@sql_mode')
    const row = r[0] ?? []
    const versionString = String(row[0] ?? '')
    const { engine, version } = parseMySqlFamilyVersion(versionString)
    this.database = row[2] ? String(row[2]) : undefined
    this.noBackslashEscapes = /NO_BACKSLASH_ESCAPES/i.test(String(row[3] ?? ''))
    this.info = {
      engine,
      versionString,
      version,
      label: `${engine === 'mariadb' ? 'MariaDB' : 'MySQL'} ${formatVersion(version)}`,
      capabilities: capabilitiesFor(engine, version),
      currentUser: row[1] ? String(row[1]) : undefined,
      currentDatabase: this.database
    }
    return this.info
  }

  private requireConn(): Connection {
    if (!this.conn) throw new Error('Not connected')
    return this.conn
  }

  /** Runs a statement and returns all rows as arrays (internal use). */
  simple(sql: string): Promise<unknown[][]> {
    const conn = this.requireConn()
    return new Promise((resolve, reject) => {
      conn.query({ sql, rowsAsArray: true }, (err, rows) => {
        if (err) reject(err)
        else resolve(Array.isArray(rows) ? (rows as unknown[][]) : [])
      })
    })
  }

  async close(): Promise<void> {
    const conn = this.conn
    this.conn = null
    if (!conn) return
    await new Promise<void>((resolve) => conn.end(() => resolve()))
  }

  async ping(): Promise<void> {
    const conn = this.requireConn()
    await new Promise<void>((resolve, reject) => conn.ping((err) => (err ? reject(err) : resolve())))
  }

  run(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    if (options.readOnly) return this.runReadOnly(sql, sink, options)
    return this.runRaw(sql, sink, options)
  }

  private async runReadOnly(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    if (this.inTx) return this.runRaw(sql, sink, options)
    const version = this.info?.version ?? 0
    // START TRANSACTION READ ONLY: MySQL 5.6.5+, MariaDB 10.0+
    await this.simple(version >= 50605 ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION')
    try {
      return await this.runRaw(sql, sink, { ...options, readOnly: false })
    } finally {
      await this.simple('ROLLBACK').catch(() => undefined)
    }
  }

  private runRaw(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const conn = this.requireConn()
    this.killRequested = false
    return new Promise<RunOutcome>((resolve, reject) => {
      let buffer: ColumnarBuffer | null = null
      let width = 0
      let rowCount = 0
      let resultRows = 0
      let hasResultSet = false
      let truncated = false
      let affectedRows: number | undefined
      let settled = false

      const finishResultSet = (): void => {
        if (!buffer) return
        buffer.flush()
        sink?.end({ rowCount: resultRows, truncated })
        buffer = null
      }

      const q = conn.query({ sql, rowsAsArray: true })
      q.on('fields', (fields: FieldPacket[] | undefined) => {
        // mysql2 also emits 'fields' (with undefined) for statements without a result set.
        if (!fields) return
        finishResultSet()
        hasResultSet = true
        width = fields.length
        resultRows = 0
        sink?.start(fields.map(toColumnMeta))
        if (sink) buffer = new ColumnarBuffer(width, options.chunkSize, sink)
      })
      q.on('result', (row: unknown) => {
        if (!Array.isArray(row)) {
          const header = row as { affectedRows?: number }
          if (typeof header.affectedRows === 'number') affectedRows = (affectedRows ?? 0) + header.affectedRows
          return
        }
        if (resultRows >= options.maxRows) {
          if (!truncated) {
            truncated = true
            // Stop the server from streaming the rest of a huge result.
            void this.killer?.().catch(() => undefined)
          }
          return
        }
        buffer?.pushRow(row)
        resultRows++
        rowCount++
      })
      q.on('error', (err: { errno?: number }) => {
        if (settled) return
        if (err.errno === QUERY_INTERRUPTED && truncated) {
          settled = true
          finishResultSet()
          resolve({ hasResultSet, rowCount, affectedRows, truncated })
          return
        }
        settled = true
        buffer = null
        reject(err)
      })
      q.on('end', () => {
        if (settled) return
        settled = true
        finishResultSet()
        this.trackTransaction(sql)
        resolve({ hasResultSet, rowCount, affectedRows, truncated })
      })
    })
  }

  private trackTransaction(sql: string): void {
    const head = sql.trimStart().slice(0, 40).toUpperCase()
    if (/^(COMMIT|ROLLBACK)\b/.test(head) && !/^ROLLBACK\s+TO\b/.test(head)) this.inTx = false
    else if (/^(START\s+TRANSACTION|BEGIN)\b/.test(head)) this.inTx = true
    else if (!this.autocommit && !/^(SELECT|SHOW|SET|USE|DESC|EXPLAIN)\b/.test(head)) this.inTx = true
    if (/^USE\b/.test(head)) {
      const m = /^\s*USE\s+`?([^`;\s]+)`?/i.exec(sql)
      if (m) this.database = m[1]
    }
  }

  async cancel(): Promise<void> {
    this.killRequested = true
    await this.killer?.()
  }

  get wasKilled(): boolean {
    return this.killRequested
  }

  async useDatabase(database: string): Promise<void> {
    await this.simple(`USE \`${database.replace(/`/g, '``')}\``)
    this.database = database
  }

  currentDatabase(): string | undefined {
    return this.database
  }

  async setAutocommit(enabled: boolean): Promise<void> {
    await this.simple(`SET autocommit = ${enabled ? 1 : 0}`)
    this.autocommit = enabled
    if (enabled) this.inTx = false
  }

  async commit(): Promise<void> {
    await this.simple('COMMIT')
    this.inTx = false
  }

  async rollback(): Promise<void> {
    await this.simple('ROLLBACK')
    this.inTx = false
  }

  inTransaction(): boolean {
    return this.inTx
  }
}
