import pg from 'pg'
import Cursor from 'pg-cursor'
import { readFileSync } from 'node:fs'
import type { ColumnMeta, ConnectionProfile, ConnectionSecrets, ServerInfo, TypeCategory } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, RunOutcome } from '@domain/ports/database'
import { capabilitiesFor, formatVersion, fromPgVersionNum } from '@domain/serverVersion'
import { ColumnarBuffer } from '../common/columnar'
import type { Endpoint } from '../mysql-family/mysqlConnection'

const BUILTIN = pg.types.builtins

/**
 * Keep exact textual representation for everything except types that map losslessly
 * to JS: booleans, small integers, floats and bytea.
 */
const PARSED_OIDS = new Set<number>([BUILTIN.BOOL, BUILTIN.INT2, BUILTIN.INT4, BUILTIN.FLOAT4, BUILTIN.FLOAT8, BUILTIN.BYTEA, BUILTIN.OID])

const typeOverrides = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (PARSED_OIDS.has(oid)) return pg.types.getTypeParser(oid, format)
    return (value: string) => value
  }
} as pg.CustomTypesConfig

interface PgTypeInfo {
  name: string
  category: string
}

function categorize(t: PgTypeInfo | undefined): TypeCategory {
  if (!t) return 'other'
  switch (t.name) {
    case 'int2': case 'int4': case 'int8': case 'oid':
      return 'integer'
    case 'numeric': case 'money':
      return 'decimal'
    case 'float4': case 'float8':
      return 'float'
    case 'bool':
      return 'boolean'
    case 'json': case 'jsonb':
      return 'json'
    case 'bytea':
      return 'binary'
    case 'text':
      return 'text'
  }
  switch (t.category) {
    case 'N': return 'decimal'
    case 'S': return 'string'
    case 'D': return 'datetime'
    case 'B': return 'boolean'
    default: return 'other'
  }
}

/** Idle per-database connections kept after switching away, so going back costs nothing. */
const MAX_IDLE_DATABASES = 4

interface ParkedClient {
  client: pg.Client
  types: Map<number, PgTypeInfo>
  broken: boolean
}

export class PgConnection implements DbConnection {
  private client: pg.Client | null = null
  private database: string
  private autocommit = true
  private inTx = false
  private types = new Map<number, PgTypeInfo>()
  private readonly idle = new Map<string, ParkedClient>()
  private broken = false
  private killer: ((pid: number) => Promise<void>) | null = null
  info: ServerInfo | null = null

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly secrets: ConnectionSecrets,
    private readonly endpoint: Endpoint
  ) {
    this.database = profile.database || 'postgres'
  }

  setKiller(killer: (pid: number) => Promise<void>): void {
    this.killer = killer
  }

  get pid(): number {
    return (this.client as unknown as { processID?: number })?.processID ?? 0
  }

  private config(database: string): pg.ClientConfig {
    const p = this.profile
    const cfg: pg.ClientConfig = {
      host: this.endpoint.host,
      port: this.endpoint.port,
      user: p.user,
      password: this.secrets.password ?? '',
      database,
      application_name: p.options.applicationName || 'Open SQL Tool',
      connectionTimeoutMillis: (p.options.connectTimeoutSec ?? 15) * 1000,
      keepAlive: true,
      types: typeOverrides
    }
    if (p.ssl.enabled) {
      cfg.ssl = {
        rejectUnauthorized: p.ssl.rejectUnauthorized,
        ca: p.ssl.caPath ? readFileSync(p.ssl.caPath, 'utf8') : undefined,
        cert: p.ssl.certPath ? readFileSync(p.ssl.certPath, 'utf8') : undefined,
        key: p.ssl.keyPath ? readFileSync(p.ssl.keyPath, 'utf8') : undefined
      }
    }
    return cfg
  }

  async connect(): Promise<ServerInfo> {
    const client = new pg.Client(this.config(this.database))
    this.broken = false
    const markBroken = (): void => {
      if (client === this.client) this.broken = true
      else for (const parked of this.idle.values()) if (parked.client === client) parked.broken = true
    }
    // Errors surface on the next query; listening avoids crashing on an unhandled 'error'.
    client.on('error', markBroken)
    client.on('end', markBroken)
    await client.connect()
    this.client = client
    // Server info and the type catalog in one round trip (simple protocol, two statements).
    const [info, types] = (await client.query({
      text: "SELECT current_setting('server_version_num')::int, version(), current_user, current_database(); SELECT oid::int, typname, typcategory FROM pg_type",
      rowMode: 'array'
    })) as unknown as pg.QueryArrayResult[]
    const [num, versionString, user, db] = info.rows[0] as [number, string, string, string]
    const version = fromPgVersionNum(Number(num))
    this.database = db
    this.types = new Map()
    for (const [oid, name, category] of types.rows as [number, string, string][]) this.types.set(Number(oid), { name, category })
    this.info = {
      engine: 'postgres',
      versionString,
      version,
      label: `PostgreSQL ${formatVersion(version).replace(/\.0$/, '')}`,
      capabilities: capabilitiesFor('postgres', version),
      currentUser: user,
      currentDatabase: db
    }
    return this.info
  }

  private requireClient(): pg.Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async close(): Promise<void> {
    const clients = [this.client, ...[...this.idle.values()].map((p) => p.client)]
    this.client = null
    this.idle.clear()
    await Promise.allSettled(clients.map((c) => c?.end()))
  }

  async ping(): Promise<void> {
    await this.requireClient().query('SELECT 1')
  }

  private columnMeta(fields: { name: string; dataTypeID: number; tableID: number }[]): ColumnMeta[] {
    return fields.map((f) => {
      const t = this.types.get(f.dataTypeID)
      return { name: f.name, type: t?.name ?? String(f.dataTypeID), category: categorize(t) }
    })
  }

  async run(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const client = this.requireClient()
    const wrapReadOnly = options.readOnly && !this.inTx
    if (wrapReadOnly) await client.query('BEGIN READ ONLY')
    else if (!this.autocommit && !this.inTx && !/^\s*(BEGIN|START|COMMIT|ROLLBACK|END|ABORT)\b/i.test(sql)) {
      await client.query('BEGIN')
      this.inTx = true
    }
    try {
      return options.direct ? await this.runDirect(client, sql, sink, options) : await this.stream(client, sql, sink, options)
    } finally {
      if (wrapReadOnly) await client.query('ROLLBACK').catch(() => undefined)
      else this.trackTransaction(sql)
    }
  }

  /** Whole result in one round trip (no portal); only for small internal queries. */
  private async runDirect(client: pg.Client, sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const res = (await client.query({ text: sql, rowMode: 'array' })) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[]
    const r = Array.isArray(res) ? res[res.length - 1] : res
    if (!r.fields?.length) return { hasResultSet: false, rowCount: 0, affectedRows: r.rowCount ?? undefined, truncated: false }
    const truncated = r.rows.length > options.maxRows
    const rows = truncated ? r.rows.slice(0, options.maxRows) : r.rows
    if (sink) {
      sink.start(this.columnMeta(r.fields))
      const buffer = new ColumnarBuffer(r.fields.length, options.chunkSize, sink)
      for (const row of rows) buffer.pushRow(row)
      buffer.flush()
      sink.end({ rowCount: rows.length, truncated })
    }
    return { hasResultSet: true, rowCount: rows.length, truncated }
  }

  private async stream(client: pg.Client, sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome> {
    const cursor = client.query(new Cursor(sql, undefined, { rowMode: 'array' }))
    type CursorResult = { fields: { name: string; dataTypeID: number; tableID: number }[]; rowCount: number | null; command: string }
    const read = (n: number): Promise<{ rows: unknown[][]; result?: CursorResult }> =>
      new Promise((resolve, reject) =>
        cursor.read(n, (err: Error | undefined, rows: unknown[][], result?: CursorResult) => (err ? reject(err) : resolve({ rows, result })))
      )
    let buffer: ColumnarBuffer | null = null
    let rowCount = 0
    let truncated = false
    let started = false
    let failed = false
    try {
      for (;;) {
        // Always read at least one row so the portal executes even when no rows are wanted.
        const allowed = options.maxRows - rowCount
        const want = Math.max(1, Math.min(options.chunkSize, allowed))
        const { rows: fetched, result } = await read(want)
        const rows = fetched.length > allowed ? fetched.slice(0, Math.max(0, allowed)) : fetched
        if (fetched.length > allowed) truncated = true
        const res = result ?? ((cursor as unknown as { _result: CursorResult })._result)
        if (!started && res?.fields?.length) {
          started = true
          sink?.start(this.columnMeta(res.fields))
          if (sink) buffer = new ColumnarBuffer(res.fields.length, options.chunkSize, sink)
        }
        for (const row of rows) buffer?.pushRow(row)
        rowCount += rows.length
        if (truncated || fetched.length < want) break
      }
      const res = (cursor as unknown as { _result: CursorResult })._result
      if (started) {
        buffer?.flush()
        sink?.end({ rowCount, truncated })
      }
      const isSelectLike = started
      return {
        hasResultSet: isSelectLike,
        rowCount,
        affectedRows: !isSelectLike && res?.rowCount !== null ? (res?.rowCount ?? undefined) : undefined,
        truncated
      }
    } catch (err) {
      // After an error pg-cursor already synced the connection; closing again would wait forever.
      failed = true
      throw err
    } finally {
      if (!failed) await new Promise<void>((resolve) => cursor.close(() => resolve()))
    }
  }

  private trackTransaction(sql: string): void {
    const head = sql.trimStart().slice(0, 30).toUpperCase()
    if (/^(COMMIT|ROLLBACK|END|ABORT)\b/.test(head) && !/^ROLLBACK\s+TO\b/.test(head)) this.inTx = false
    else if (/^(BEGIN|START\s+TRANSACTION)\b/.test(head)) this.inTx = true
  }

  async cancel(): Promise<void> {
    if (this.killer && this.pid) await this.killer(this.pid)
  }

  /**
   * PostgreSQL cannot switch databases on a live connection. The current connection is parked
   * and reused when coming back, so browsing several databases only pays each handshake once.
   */
  async useDatabase(database: string): Promise<void> {
    if (database === this.database && this.client) return
    if (this.inTx) throw new Error('Commit or roll back the current transaction before switching databases')
    const previous = this.database
    if (this.client) this.park(previous, { client: this.client, types: this.types, broken: this.broken })
    this.client = null
    const parked = this.idle.get(database)
    if (parked) {
      this.idle.delete(database)
      if (!parked.broken) {
        this.client = parked.client
        this.types = parked.types
        this.broken = false
        this.database = database
        return
      }
      void parked.client.end().catch(() => undefined)
    }
    this.database = database
    try {
      await this.connect()
    } catch (err) {
      // Stay on the previous database.
      const back = this.idle.get(previous)
      this.idle.delete(previous)
      this.database = previous
      if (back && !back.broken) {
        this.client = back.client
        this.types = back.types
        this.broken = false
      } else await this.connect()
      throw err
    }
  }

  private park(database: string, entry: ParkedClient): void {
    this.idle.delete(database)
    this.idle.set(database, entry)
    while (this.idle.size > MAX_IDLE_DATABASES) {
      const [oldest, evicted] = this.idle.entries().next().value as [string, ParkedClient]
      this.idle.delete(oldest)
      void evicted.client.end().catch(() => undefined)
    }
  }

  currentDatabase(): string | undefined {
    return this.database
  }

  async setAutocommit(enabled: boolean): Promise<void> {
    if (enabled && this.inTx) await this.commit()
    this.autocommit = enabled
  }

  async commit(): Promise<void> {
    if (this.inTx) await this.requireClient().query('COMMIT')
    this.inTx = false
  }

  async rollback(): Promise<void> {
    if (this.inTx) await this.requireClient().query('ROLLBACK')
    this.inTx = false
  }

  inTransaction(): boolean {
    return this.inTx
  }
}
