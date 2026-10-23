import Firebird from 'node-firebird'
import FbWire from 'node-firebird/lib/wire/connection.js'
import Xsql from 'node-firebird/lib/wire/xsqlvar.js'
import type { ColumnMetadata, Database, Options, Transaction } from 'node-firebird'
import type { EventEmitter } from 'node:events'
import type { ColumnMeta, ConnectionProfile, ConnectionSecrets, ServerInfo, TypeCategory } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, RunOutcome } from '@domain/ports/database'
import { capabilitiesFor, formatVersion, parseVersion } from '@domain/serverVersion'
import { ColumnarBuffer, driverValue, formatDate } from '../common/columnar'
import type { Endpoint } from '../mysql-family/mysqlConnection'
import { LegacyText, rawNoneText } from './fbLegacyText'
import { EncodingProfiles } from '@domain/text/legacyText'

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

/** A fetched row travels as one message, whose length the wire protocol stores in 16 bits. */
const MAX_MESSAGE = 0xffff
const MAX_STRING = 32765

interface WireVar {
  type: number
  subType?: number
  length: number
  /** Set by the driver when it widened a column for the connection charset. */
  nativeLength?: number
}

const isText = (v: WireVar): boolean => (v.type & ~1) === T.VARYING || (v.type & ~1) === T.TEXT

/** Upper bound of a column's share of the message: data, null indicator and alignment. */
const varSize = (v: WireVar): number => ((v.type & ~1) === T.VARYING ? v.length + 2 : (v.type & ~1) === T.TEXT ? v.length : 16) + 2 + 7

/**
 * node-firebird widens CHAR/VARCHAR columns of charset NONE (and others the server doesn't
 * transliterate) to 4 bytes per character under a UTF8 connection, capped at 64 KB per column.
 * A VARCHAR(32765) NONE then becomes 65532 bytes and the row message overflows the protocol's
 * 64 KB: Firebird 2.5 rejects it on its own (-804) and crashes when other columns follow.
 * Keeps each widened column within the string limit and the whole row within a message, giving
 * back the widening of the largest columns first (they never shrink below their native length).
 */
function fitOutputMessage(output: WireVar[] | undefined, rawNoneText: boolean): void {
  if (!output?.length) return
  // NONE text travels as the stored bytes when FbConnection decodes it (fbLegacyText): no widening.
  if (rawNoneText) for (const v of output) if (v.subType === 0 && v.nativeLength !== undefined && isText(v)) v.length = v.nativeLength
  const widened = output.filter((v) => v.nativeLength !== undefined && v.length > v.nativeLength)
  if (!widened.length) return
  for (const v of widened) v.length = Math.max(v.nativeLength!, Math.min(v.length, MAX_STRING))
  let excess = output.reduce((sum, v) => sum + varSize(v), 0) - MAX_MESSAGE
  for (const v of widened.sort((a, b) => b.length - b.nativeLength! - (a.length - a.nativeLength!))) {
    if (excess <= 0) break
    const give = Math.min(excess, v.length - v.nativeLength!)
    v.length -= give
    excess -= give
  }
}

// The fetch request carries the output message format built from statement.output.
const wireFetch = FbWire.prototype.fetch
FbWire.prototype.fetch = function (this: FbWire, statement: { output?: WireVar[] }, ...rest: unknown[]) {
  fitOutputMessage(statement.output, rawNoneText((this as unknown as { options?: Options & { legacyText?: boolean } }).options))
  return (wireFetch as (...args: unknown[]) => void).call(this, statement, ...rest)
} as typeof wireFetch

/**
 * node-firebird declares text outputs without a charset (blr_text/blr_varying), asking the server to
 * convert them to the connection charset. Firebird 5 and older pass NONE and OCTETS through, but
 * Firebird 6 converts them: it measures the bytes as UTF-8 characters (string right truncation) and
 * rejects bytes that aren't valid UTF-8 (malformed string). Declaring their own charset keeps the
 * stored bytes on every version.
 */
interface BlrWriter {
  addByte(b: number): void
  addWord(w: number): void
}
type CalcBlr = (this: WireVar & { subType: number }, blr: BlrWriter) => void
const xsql = Xsql as unknown as { SQLVarText: { prototype: { calcBlr: CalcBlr } }; SQLVarString: { prototype: { calcBlr: CalcBlr } } }
const BLR_TEXT2 = 15
const BLR_VARYING2 = 38
for (const [cls, code] of [[xsql.SQLVarText, BLR_TEXT2], [xsql.SQLVarString, BLR_VARYING2]] as const) {
  const calcBlr = cls.prototype.calcBlr
  cls.prototype.calcBlr = function (blr) {
    const charset = this.subType & 0xff
    // 0 = NONE, 1 = OCTETS.
    if (charset > 1) return calcBlr.call(this, blr)
    blr.addByte(code)
    blr.addWord(charset)
    blr.addWord(this.length)
  }
}

/** Lock wait for user statements; forms and tree actions pass a shorter one. */
const DEFAULT_LOCK_TIMEOUT_SEC = 30

/** Rows held back at the start of a result while their NONE text is learned. */
const HELD_ROWS = 200

/** Columns whose values may be NONE text: CHAR/VARCHAR of charset NONE and text BLOBs. */
const mayHoldNoneText = (m: ColumnMetadata): boolean => {
  const t = m.type & ~1
  return ((t === T.TEXT || t === T.VARYING) && m.subType === 0) || (t === T.BLOB && m.subType === 1)
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
    private readonly endpoint: Endpoint,
    /** Evidence about the database's NONE text, shared with the session's other connection. */
    readonly profiles: EncodingProfiles = new EncodingProfiles()
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
      // One round trip per op_get_segment: the driver's 1 KB default turned a table with 70 MB of
      // BLOBs into ~70,000 round trips, blocking the session for seconds locally and minutes on a LAN.
      blobReadChunkSize: 65535,
      numericMode: 'string',
      wireCrypt: p.options.wireCrypt === 'disabled' ? Firebird.WIRE_CRYPT_DISABLE : Firebird.WIRE_CRYPT_ENABLE,
      wireCompression: !!p.options.wireCompression,
      connectTimeout: (p.options.connectTimeoutSec ?? 15) * 1000,
      retryConnectionInterval: 1000,
      enableKeepAlive: true,
      // NONE text comes as LegacyText and is decoded here (fbLegacyText).
      legacyText: true
    } as Options
  }

  async connect(): Promise<ServerInfo> {
    this.db = await Firebird.attachAsync(this.options())
    const rows = (await this.db.queryAsync<Record<string, unknown>>(
      "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS V, CURRENT_USER AS U, TRIM(RDB$CHARACTER_SET_NAME) AS CS FROM RDB$DATABASE"
    )) as Record<string, unknown>[]
    // Context variables are NONE text on some versions: they come as LegacyText too.
    const text = (v: unknown): string => (v instanceof LegacyText ? this.profiles.decode(v.bytes) : String(v ?? '')).trim()
    const versionString = text(rows[0]?.V)
    const version = parseVersion(versionString)
    this.info = {
      engine: 'firebird',
      versionString,
      version,
      label: `Firebird ${formatVersion(version)}`,
      capabilities: capabilitiesFor('firebird', version),
      currentUser: text(rows[0]?.U),
      currentDatabase: this.profile.database,
      defaultCharset: text(rows[0]?.CS) || 'NONE'
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

  /**
   * READ COMMITTED with REC_VERSION (the driver's misnamed ISOLATION_READ_UNCOMMITTED): reads the last
   * committed version instead of waiting for other attachments' uncommitted changes. The driver's
   * READ_COMMITTED uses NO_REC_VERSION, so a pending metadata change elsewhere (e.g. a trigger compiled
   * in another tool and not yet committed) froze every catalog read.
   */
  private async startTransaction(readOnly = false, lockTimeoutSec = DEFAULT_LOCK_TIMEOUT_SEC): Promise<Transaction> {
    // Writes wait for conflicting locks only for a while: an uncommitted change in another tool
    // (e.g. a trigger being compiled) would otherwise block the statement forever.
    return this.requireDb().transactionAsync({ isolation: Firebird.ISOLATION_READ_UNCOMMITTED, readOnly, wait: true, waitTimeout: readOnly ? 0 : lockTimeoutSec })
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
    const tx = ownTx ? await this.startTransaction(options.readOnly, options.lockTimeoutSec) : (this.tx ??= await this.startTransaction(false, options.lockTimeoutSec))
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
      // NONE text is decoded with its column's evidence: the first rows are held back until they
      // have all been learned, so even they get the column's code page.
      let held: unknown[][] | null = output.some(mayHoldNoneText) ? [] : null
      const release = (): void => {
        for (const r of held ?? []) buffer?.pushRow(this.decodeRow(r))
        held = null
      }
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
              if (v instanceof LegacyText) this.profiles.learn(v.bytes, v.column)
              else if (typeof v === 'function') row[c] = await readBinaryBlob(v as never, tx)
              else if (converters[c] && v !== null) row[c] = converters[c]!(v)
            }
            rowCount++
            if (held) {
              held.push(row)
              if (held.length >= HELD_ROWS) release()
            } else {
              buffer?.pushRow(this.decodeRow(row))
            }
          },
          { asObject: false } as never
        )
      } catch (err) {
        if (err !== STOP) throw err
      }
      release()
      buffer?.flush()
      sink?.end({ rowCount, truncated })
      return { hasResultSet: true, rowCount, truncated }
    }

    // Binary parameters become BLOBs written as-is (no transliteration), so files keep their bytes.
    const result = (await tx.executeAsync(sql, (options.params ?? []).map(driverValue), { withMeta: true })) as unknown as {
      rows?: unknown[] | Record<string, unknown>
      affectedRows?: number
    }
    if (output.length && type === STMT_EXEC_PROCEDURE) {
      // EXECUTE PROCEDURE / RETURNING: a single output row.
      const raw = result?.rows
      const row = this.decodeRow(Array.isArray(raw) ? (Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw) : raw ? Object.values(raw) : [])
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

  /** Decodes the NONE text of a row (LegacyText) with what the profiles learned. */
  private decodeRow(row: unknown[]): unknown[] {
    for (let c = 0; c < row.length; c++) {
      const v = row[c]
      if (v instanceof LegacyText) {
        this.profiles.learn(v.bytes, v.column)
        row[c] = this.profiles.decode(v.bytes, v.column)
      }
    }
    return row
  }

  async cancel(): Promise<void> {
    await this.requireDb().cancelAsync()
  }

  /** Prepares the statement with isc_info_sql_get_plan in a read-only transaction; nothing is executed. */
  async explainPlan(sql: string): Promise<string> {
    const tx = await this.startTransaction(true)
    try {
      type Prepared = { plan?: string; releaseAsync(): Promise<void> }
      const cnx = (tx as unknown as { connection: { prepare(tx: Transaction, sql: string, plan: boolean, cb: (err: unknown, stmt: Prepared) => void): void } }).connection
      const stmt = await new Promise<Prepared>((resolve, reject) => cnx.prepare(tx, sql, true, (err, s) => (err ? reject(err) : resolve(s))))
      const plan = (stmt.plan ?? '').trim()
      await stmt.releaseAsync().catch(() => undefined)
      return plan
    } finally {
      await tx.rollbackAsync().catch(() => undefined)
    }
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
