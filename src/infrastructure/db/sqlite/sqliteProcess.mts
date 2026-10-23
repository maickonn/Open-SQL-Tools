/**
 * Child process hosting one SQLite connection (node:sqlite is synchronous and has no interrupt).
 * Running it outside the session worker keeps RPC and catalog reads responsive while a query runs,
 * and makes cancelling possible: the owner kills the process, which also stops a statement that is
 * busy inside SQLite's native code (a worker thread cannot be terminated there).
 *
 * Self-contained on purpose (Node built-ins and type-only imports): the bundle runs it as
 * sqliteProcess.js and integration tests run this .mts file directly with Node's type stripping.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type { ProcessRequest, ProcessResponse, ProcessColumn } from './sqliteProtocol'

let db: DatabaseSync | null = null

const send = (msg: ProcessResponse): void => {
  process.send?.(msg)
}

function requireDb(): DatabaseSync {
  if (!db) throw new Error('The database is not open')
  return db
}

/** BigInt only when the value does not fit a double exactly. */
function cell(v: unknown): unknown {
  if (typeof v === 'bigint') return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString()
  return v
}

function run(id: number, sql: string, maxRows: number, chunkSize: number, params: SQLInputValue[] = []): void {
  const stmt: StatementSync = requireDb().prepare(sql)
  const meta = stmt.columns()
  if (meta.length === 0) {
    const r = stmt.run(...params)
    send({ id, type: 'end', rowCount: 0, truncated: false, hasResultSet: false, changes: Number(r.changes) })
    return
  }
  stmt.setReturnArrays(true)
  stmt.setReadBigInts(true)
  const width = meta.length
  const columns: ProcessColumn[] = meta.map((c) => ({ name: c.name, declared: c.type ?? null, table: c.table ?? undefined, column: c.column ?? undefined }))
  let cols: unknown[][] = Array.from({ length: width }, () => [])
  let count = 0
  let rowCount = 0
  let truncated = false
  let started = false
  const flush = (): void => {
    if (!started) {
      // Expressions have no declared type: the first chunk tells the renderer what they hold.
      for (let c = 0; c < width; c++) if (!columns[c].declared) columns[c].sample = cols[c].find((v) => v !== null && v !== undefined)
      send({ id, type: 'start', columns })
      started = true
    }
    if (count === 0) return
    send({ id, type: 'rows', columns: cols, count })
    cols = Array.from({ length: width }, () => [])
    count = 0
  }
  const it = stmt.iterate(...params) as Iterator<unknown[]>
  try {
    for (;;) {
      const next = it.next()
      if (next.done) break
      if (rowCount >= maxRows) {
        truncated = true
        break
      }
      const row = next.value
      for (let c = 0; c < width; c++) cols[c].push(cell(row[c]))
      count++
      rowCount++
      if (count >= chunkSize) flush()
    }
  } finally {
    // Resets the statement when the loop stopped early (truncation).
    it.return?.()
  }
  flush()
  send({ id, type: 'end', rowCount, truncated, hasResultSet: true })
}

process.on('message', (msg: ProcessRequest) => {
  try {
    switch (msg.type) {
      case 'open':
        db = new DatabaseSync(msg.path, { readOnly: msg.readOnly, timeout: msg.busyTimeoutMs, enableForeignKeyConstraints: true })
        send({ id: msg.id, type: 'ok', value: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v })
        break
      case 'run':
        if (!msg.readOnly) {
          run(msg.id, msg.sql, msg.maxRows, msg.chunkSize, msg.params)
          break
        }
        // Read-only statements (AI agent, previews): SQLite refuses any write while query_only is on.
        requireDb().exec('PRAGMA query_only = ON')
        try {
          run(msg.id, msg.sql, msg.maxRows, msg.chunkSize, msg.params)
        } finally {
          requireDb().exec('PRAGMA query_only = OFF')
        }
        break
      case 'close':
        db?.close()
        db = null
        send({ id: msg.id, type: 'ok' })
        process.disconnect?.()
        break
    }
  } catch (err) {
    const e = err as { message?: string; code?: string; errcode?: number; errstr?: string }
    send({ id: msg.id, type: 'error', message: e.message ?? String(err), code: e.errstr ?? e.code, errcode: e.errcode })
  }
})

// The session worker went away (closed or crashed): release the file.
process.on('disconnect', () => {
  db?.close()
  process.exit(0)
})
