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

export class PgConnection implements DbConnection {
  private client: pg.Client | null = null
  private database: string
  private autocommit = true
  private inTx = false
  private types = new Map<number, PgTypeInfo>()
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
    client.on('error', () => {
      // Surfaces on the next query; avoid crashing on unhandled 'error'.
    })
    await client.connect()
    this.client = client
    const r = await client.query({
      text: "SELECT current_setting('server_version_num')::int, version(), current_user, current_database()",
      rowMode: 'array'
    })
    const [num, versionString, user, db] = r.rows[0] as [number, string, string, string]
    const version = fromPgVersionNum(Number(num))
    this.database = db
    await this.loadTypes()
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

  private async loadTypes(): Promise<void> {
    const r = await this.requireClient().query({ text: 'SELECT oid::int, typname, typcategory FROM pg_type', rowMode: 'array' })
    this.types.clear()
    for (const [oid, name, category] of r.rows as [number, string, string][]) this.types.set(Number(oid), { name, category })
  }

  private requireClient(): pg.Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async close(): Promise<void> {
    const c = this.client
    this.client = null
    await c?.end().catch(() => undefined)
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
      return await this.stream(client, sql, sink, options)
    } finally {
      if (wrapReadOnly) await client.query('ROLLBACK').catch(() => undefined)
      else this.trackTransaction(sql)
    }
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

  /** PostgreSQL cannot switch databases on a live connection: reconnect. */
  async useDatabase(database: string): Promise<void> {
    if (database === this.database && this.client) return
    if (this.inTx) throw new Error('Commit or roll back the current transaction before switching databases')
    const previous = this.database
    await this.close()
    this.database = database
    try {
      await this.connect()
    } catch (err) {
      this.database = previous
      await this.connect()
      throw err
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
