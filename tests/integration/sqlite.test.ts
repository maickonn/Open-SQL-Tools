import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionProfile, TableStructure } from '@shared/model'
import type { WorkerEvents } from '@shared/workerApi'
import { SessionService } from '@application/session/sessionService'
import { copyTable, type CopySession } from '@application/copy/copyTable'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'

// SQLite-specific behaviour (no container needed): file handling, table rebuilds, dumps.
const wanted = process.env.DB_TARGETS?.split(',').map((s) => s.trim())
const enabled = !wanted?.length || wanted.includes('sqlite')

const dir = mkdtempSync(join(tmpdir(), 'ost-sqlite-it-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function profile(file: string, options: ConnectionProfile['options'] = { createIfMissing: true }): ConnectionProfile {
  const now = new Date().toISOString()
  return {
    id: file,
    name: 'sqlite',
    engine: 'sqlite',
    host: '',
    port: 0,
    user: '',
    database: file,
    options,
    ssl: { enabled: false, rejectUnauthorized: false },
    // A profile switched from a server engine may keep SSH settings: they must be ignored.
    ssh: { enabled: true, host: 'unreachable.invalid', port: 22, user: 'x', authMethod: 'password' },
    savePassword: false,
    createdAt: now,
    updatedAt: now
  }
}

function service(): SessionService {
  return new SessionService({
    openDatabase,
    openTunnel: async () => {
      throw new Error('SQLite must not open an SSH tunnel')
    },
    createWriter: createFileWriter,
    readText: readTextFile,
    emit: () => undefined
  })
}

async function open(file: string, options?: ConnectionProfile['options']): Promise<SessionService> {
  const svc = service()
  await svc.connect({ profile: profile(file, options), secrets: {} })
  return svc
}

async function run(svc: SessionService, sql: string): Promise<void> {
  const r = await svc.execute({ queryId: 'q', sql, maxRows: 1000 })
  expect(r.statements.find((s) => s.error)?.error?.message ?? null).toBeNull()
}

async function rows(svc: SessionService, sql: string): Promise<unknown[][]> {
  return (await svc.query({ sql })).rows
}

describe.skipIf(!enabled)('sqlite', () => {
  it('refuses a missing file unless "create if missing" is on', async () => {
    const file = join(dir, 'missing.db')
    await expect(open(file, {})).rejects.toThrow(/does not exist/)
    expect(existsSync(file)).toBe(false)
    const svc = await open(file, { createIfMissing: true })
    expect(svc.serverInfo().label).toMatch(/^SQLite 3\./)
    expect(existsSync(file)).toBe(true)
    await svc.disconnect()
  })

  it('opens read-only files without allowing writes', async () => {
    const file = join(dir, 'ro.db')
    const rw = await open(file)
    await run(rw, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'a\');')
    await rw.disconnect()

    const ro = await open(file, { readOnly: true })
    expect(await rows(ro, 'SELECT v FROM t')).toEqual([['a']])
    const r = await ro.execute({ queryId: 'w', sql: "INSERT INTO t (v) VALUES ('b')", maxRows: 10 })
    expect(r.statements[0].error?.message).toMatch(/readonly|read-only/i)
    await ro.disconnect()
  })

  it('reads integers beyond 2^53, reals and blobs exactly', async () => {
    const svc = await open(join(dir, 'types.db'))
    const [row] = await rows(svc, "SELECT 9007199254740993 AS big, 42 AS small, 1.25 AS real, X'00FF' AS bin, NULL AS empty, 'é' AS txt")
    expect(row).toEqual(['9007199254740993', 42, 1.25, new Uint8Array([0, 255]), null, 'é'])
    await svc.disconnect()
  })

  it('uses ALTER TABLE for supported changes', async () => {
    const svc = await open(join(dir, 'native.db'))
    await run(svc, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, old TEXT)')
    const original = await svc.getTableStructure({ ref: { name: 't', kind: 'table' } })
    const target: TableStructure = structuredClone(original)
    target.columns[1] = { ...target.columns[1], name: 'title' }
    target.columns = target.columns.filter((c) => c.name !== 'old')
    target.columns.push({ name: 'qty', dataType: 'INTEGER', fullType: 'INTEGER', nullable: true, defaultValue: '0' })
    target.indexes.push({ name: 't_title', type: 'INDEX', columns: ['title'] })
    const statements = svc.generateTableDDL({ original, target })
    expect(statements.every((s) => /^(ALTER TABLE|CREATE INDEX)/.test(s))).toBe(true)
    await svc.executeStatements({ statements, transactional: true })
    const after = await svc.getTableStructure({ ref: { name: 't', kind: 'table' } })
    expect(after.columns.map((c) => c.name)).toEqual(['id', 'title', 'qty'])
    expect(after.indexes.some((i) => i.name === 't_title')).toBe(true)
    await svc.disconnect()
  })

  it('rebuilds a table keeping data, indexes, triggers, views and foreign keys', async () => {
    const svc = await open(join(dir, 'rebuild.db'))
    await run(
      svc,
      `CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL CHECK (price >= 0));
       CREATE INDEX parent_name ON parent (name);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id) ON DELETE CASCADE);
       CREATE TABLE audit (msg TEXT);
       CREATE TRIGGER parent_ai AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES ('added ' || NEW.name); END;
       CREATE VIEW parent_names AS SELECT name FROM parent;
       INSERT INTO parent (name, price) VALUES ('a', 1), ('b', 2);
       INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 2);`
    )
    const original = await svc.getTableStructure({ ref: { name: 'parent', kind: 'table' } })
    expect(original.columns[0].autoIncrement).toBe(true)
    expect(original.checks).toHaveLength(1)
    expect(original.dependents?.map((d) => `${d.kind}:${d.name}`).sort()).toEqual(['trigger:parent_ai', 'view:parent_names'])

    // Changing a type and the column order is beyond ALTER TABLE: the table is rebuilt.
    const target: TableStructure = structuredClone(original)
    target.columns = [target.columns[0], { ...target.columns[2], fullType: 'NUMERIC', dataType: 'NUMERIC' }, target.columns[1]]
    const statements = svc.generateTableDDL({ original, target })
    expect(statements.some((s) => s.startsWith('DROP TABLE'))).toBe(true)
    await svc.executeStatements({ statements, transactional: true })

    const after = await svc.getTableStructure({ ref: { name: 'parent', kind: 'table' } })
    expect(after.columns.map((c) => `${c.name} ${c.fullType}`)).toEqual(['id INTEGER', 'price NUMERIC', 'name TEXT'])
    expect(after.columns[0].autoIncrement).toBe(true)
    expect(after.checks).toHaveLength(1)
    expect(after.indexes.some((i) => i.name === 'parent_name')).toBe(true)
    expect(await rows(svc, 'SELECT id, name FROM parent ORDER BY id')).toEqual([[1, 'a'], [2, 'b']])
    expect(await rows(svc, 'SELECT count(*) FROM child')).toEqual([[2]])
    expect(await rows(svc, 'SELECT count(*) FROM parent_names')).toEqual([[2]])
    await run(svc, "INSERT INTO parent (name, price) VALUES ('c', 3)")
    expect(await rows(svc, "SELECT msg FROM audit WHERE msg = 'added c'")).toEqual([['added c']])
    expect(await rows(svc, "SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_ost%' ESCAPE '\\'")).toEqual([[0]])
    await svc.disconnect()
  })

  it('rolls back a failed rebuild completely', async () => {
    const svc = await open(join(dir, 'rollback.db'))
    await run(svc, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x'), (NULL);")
    const original = await svc.getTableStructure({ ref: { name: 't', kind: 'table' } })
    const target: TableStructure = structuredClone(original)
    target.columns[1] = { ...target.columns[1], nullable: false }
    const statements = svc.generateTableDDL({ original, target })
    await expect(svc.executeStatements({ statements, transactional: true })).rejects.toThrow(/NOT NULL/)
    expect(await rows(svc, 'SELECT count(*) FROM t')).toEqual([[2]])
    await svc.disconnect()
  })

  it('dumps a file that loads into a new database without firing triggers', async () => {
    const svc = await open(join(dir, 'dump-src.db'))
    await run(
      svc,
      `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, data BLOB);
       CREATE INDEX items_name ON items (name);
       CREATE TABLE log (msg TEXT);
       CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO log VALUES (NEW.name); END;
       INSERT INTO items (id, name, data) VALUES (1, 'it''s', X'CAFE'), (2, 'b', NULL);
       DELETE FROM log;`
    )
    const file = join(dir, 'dump.sql')
    await svc.dumpSql({
      operationId: 'dump',
      options: {
        filePath: file,
        databases: [''],
        createDatabase: false,
        dropDatabase: false,
        createTables: true,
        dropTables: true,
        data: 'insert',
        rowsPerInsert: 100,
        includeRoutines: false,
        includeViews: true,
        includeTriggers: true
      }
    })
    await svc.disconnect()
    const script = readFileSync(file, 'utf8')
    expect(script).toMatch(/^BEGIN TRANSACTION;/m)
    expect(script.indexOf('CREATE TRIGGER')).toBeGreaterThan(script.indexOf('INSERT INTO "items"'))

    const copy = await open(join(dir, 'dump-dst.db'))
    await run(copy, script)
    expect(await rows(copy, 'SELECT id, name, data FROM items ORDER BY id')).toEqual([[1, "it's", new Uint8Array([0xca, 0xfe])], [2, 'b', null]])
    expect(await rows(copy, 'SELECT count(*) FROM log')).toEqual([[0]])
    expect(await rows(copy, "SELECT count(*) FROM sqlite_master WHERE name IN ('items_name', 'items_ai')")).toEqual([[2]])
    await copy.disconnect()
  })

  it('copies a table within the file', async () => {
    const svc = await open(join(dir, 'copy.db'))
    await run(svc, "CREATE TABLE src (id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INTEGER DEFAULT 1); INSERT INTO src (name) VALUES ('a'), ('b');")
    const client = {
      call: (method: string, params: unknown) => Promise.resolve((svc as unknown as Record<string, (p: unknown) => unknown>)[method](params)),
      on: () => () => undefined
    }
    const session = { id: 's', info: svc.serverInfo(), client } as unknown as CopySession
    const r = await copyTable({ source: session, ref: { name: 'src', kind: 'table' }, target: session, newName: 'dst', withData: true, dropExisting: true })
    expect(r.rows).toBe(2)
    expect(await rows(svc, 'SELECT name, n FROM dst ORDER BY id')).toEqual([['a', 1], ['b', 1]])
    await svc.disconnect()
  })

  it('explains, finds text and lists host information', async () => {
    const svc = await open(join(dir, 'misc.db'))
    await run(svc, "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, raw); INSERT INTO notes (body, raw) VALUES ('Hello World', 'x'), ('bye', 'hello');")
    const plan = await svc.query({ sql: 'EXPLAIN QUERY PLAN SELECT * FROM notes WHERE id = 1' })
    expect(plan.rows.length).toBeGreaterThan(0)
    const found = await svc.findText({ operationId: 'f', text: 'hello', databases: [], caseSensitive: false, matchType: 'like' })
    expect(found.matches).toEqual([expect.objectContaining({ table: 'notes', count: 2 })])
    const exact = await svc.findText({ operationId: 'f2', text: 'hello', databases: [], caseSensitive: true, matchType: 'like' })
    expect(exact.matches[0]?.count).toBe(1)
    const host = await svc.hostInfo()
    expect(host.variables.rows.some((r) => r[0] === 'journal_mode')).toBe(true)
    await svc.disconnect()
  })
})

// Keeps the worker event type referenced for parity with the other suites' helpers.
export type { WorkerEvents }
