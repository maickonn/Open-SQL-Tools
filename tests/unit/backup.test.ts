import { describe, expect, it } from 'vitest'
import type { CellValue, ConnectionProfile, LogicalBackupOptions, ServerInfo } from '@shared/model'
import type { DbConnection, ResultSink, RunOptions, TextWriter } from '@domain/ports/database'
import type { ScriptReader } from '@domain/ports/backup'
import { dependencyOrder } from '@domain/backup/dependencyOrder'
import { formatBackupHeader, parseBackupHeader, sniffBackupFile } from '@domain/backup/backupHeader'
import { parseToolVersion, toolCompatibility } from '@domain/backup/toolVersion'
import { splitSql } from '@domain/sql/splitter'
import { ScriptWriter, unwrapSetTerm } from '@application/backup/logical/scriptWriter'
import { writeTableData } from '@application/backup/logical/tableDataWriter'
import { stripDefiner } from '@application/backup/logical/strategies/types'
import { placeholder } from '@application/backup/logical/strategies/firebird'
import { backupFileNames } from '@application/backup/logical/logicalBackup'
import { restoreScript, NeedsPsqlError } from '@application/backup/restore/scriptRestorer'
import { gbakBackupInvocation, mysqlDumpInvocations, pgDumpInvocation, CREDENTIAL_PLACEHOLDER, type ToolTarget } from '@application/backup/native/commands'
import { MySqlDialect } from '@infrastructure/db/mysql-family/mysqlDialect'
import { FbDialect } from '@infrastructure/db/firebird/fbDialect'
import { PgDialect } from '@infrastructure/db/postgres/pgDialect'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

class MemoryWriter implements TextWriter {
  text = ''
  async write(chunk: string | Uint8Array): Promise<void> {
    this.text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
  }
  async close(): Promise<void> {}
}

/** A connection that returns fixed rows for SELECTs and records every statement it runs. */
function fakeConnection(rows: CellValue[][] = [], fail?: (sql: string) => boolean): DbConnection & { ran: string[]; commits: number } {
  let tx = false
  let autocommit = true
  const c = {
    ran: [] as string[],
    commits: 0,
    async connect() {
      return {} as ServerInfo
    },
    async close() {},
    async ping() {},
    async run(sql: string, sink: ResultSink | null, _o: RunOptions) {
      c.ran.push(sql)
      if (fail?.(sql)) throw new Error(`failed: ${sql}`)
      if (!autocommit) tx = true
      if (sink && /^SELECT/i.test(sql)) {
        sink.start([])
        const cols = rows[0]?.map((_, i) => rows.map((r) => r[i])) ?? []
        if (rows.length) sink.rows(cols, rows.length)
        sink.end({ rowCount: rows.length, truncated: false })
      }
      return { hasResultSet: !!sink, rowCount: rows.length, truncated: false }
    },
    async cancel() {},
    async useDatabase() {},
    currentDatabase: () => undefined,
    async setAutocommit(v: boolean) {
      autocommit = v
    },
    async commit() {
      c.commits++
      tx = false
    },
    async rollback() {
      tx = false
    },
    inTransaction: () => tx,
    async beginSnapshot() {}
  }
  return c
}

function reader(text: string, chunk = 7): ScriptReader {
  let pos = 0
  return {
    size: text.length,
    compressed: false,
    position: () => pos,
    async *chunks() {
      for (let i = 0; i < text.length; i += chunk) {
        pos = Math.min(text.length, i + chunk)
        yield text.slice(i, i + chunk)
      }
    },
    async close() {}
  }
}

const restoreOptions = {
  commitEvery: 2,
  stopOnError: true,
  isCancelled: () => false,
  onProgress: () => undefined,
  onError: () => undefined
}

describe('dependencyOrder', () => {
  it('puts dependencies first, keeps input order otherwise and breaks cycles', () => {
    const deps: Record<string, string[]> = { a: ['c'], b: [], c: ['b'], d: ['e'], e: ['d'], f: ['zzz'] }
    expect(dependencyOrder(Object.keys(deps), (x) => x, (x) => deps[x])).toEqual(['b', 'c', 'a', 'f', 'd', 'e'])
  })
})

describe('backup files', () => {
  const header = { v: 1, engine: 'postgres' as const, serverVersion: 160000, serverLabel: 'PostgreSQL 16', databases: ['shop'], createdAt: '2026-01-01T00:00:00Z', app: 'Open SQL Tools' }

  it('round-trips the header line', () => {
    expect(parseBackupHeader(formatBackupHeader(header) + 'SET x;')).toEqual(header)
    expect(parseBackupHeader('-- something else\n')).toBeUndefined()
  })

  it('recognizes scripts, pg_dump archives, SQLite files and psql-only dumps', () => {
    expect(sniffBackupFile(enc(formatBackupHeader(header)), true, 10, 'postgres')).toMatchObject({ kind: 'sql', compressed: true, header, methods: ['logical', 'psql'] })
    expect(sniffBackupFile(enc('PGDMP\x01\x0e'), false, 10, 'postgres')).toMatchObject({ kind: 'pg-custom', methods: ['pg_restore'] })
    expect(sniffBackupFile(enc('SQLite format 3\0rest'), false, 10, 'sqlite')).toMatchObject({ kind: 'sqlite', methods: ['sqlite-file'] })
    expect(sniffBackupFile(enc('SET x;\nCOPY public.t (a) FROM stdin;\n1\n\\.\n'), false, 10, 'postgres')).toMatchObject({ needsPsql: true, methods: ['psql'] })
    expect(sniffBackupFile(enc('CREATE TABLE t (a int);'), false, 10, 'mysql').methods).toEqual(['logical', 'mysql'])
  })

  it('names one file per PostgreSQL database', () => {
    expect(backupFileNames('postgres', '/b/x.sql.gz', ['a', 'b'])).toEqual([
      { file: '/b/x_a.sql.gz', databases: ['a'] },
      { file: '/b/x_b.sql.gz', databases: ['b'] }
    ])
    expect(backupFileNames('mysql', '/b/x.sql', ['a', 'b'])).toEqual([{ file: '/b/x.sql', databases: ['a', 'b'] }])
  })
})

describe('tool versions', () => {
  const server = (engine: ServerInfo['engine'], version: number): ServerInfo => ({ engine, version, versionString: '', label: '', capabilities: [] })

  it('parses --version outputs', () => {
    expect(parseToolVersion('pg_dump', 'pg_dump (PostgreSQL) 16.4')).toBe('16.4')
    expect(parseToolVersion('mysqldump', 'mysqldump  Ver 8.4.3 for Win64 on x86_64 (MySQL Community Server - GPL)')).toBe('8.4.3')
    expect(parseToolVersion('mariadb-dump', 'mariadb-dump  Ver 10.19 Distrib 10.11.6-MariaDB, for Linux')).toBe('10.11.6')
    expect(parseToolVersion('mysql', 'C:\Program Files\MySQL\MySQL Workbench 8.0 CE\mysql.exe  Ver 8.0.45 for Win64 on x86_64')).toBe('8.0.45')
    expect(parseToolVersion('gbak', 'gbak:gbak version WI-V3.0.12.33787 Firebird 3.0')).toBe('3.0.12.33787')
  })

  it('refuses pg_dump and gbak older than the server', () => {
    expect(toolCompatibility('pg_dump', '15.8', server('postgres', 160200)).compatible).toBe(false)
    expect(toolCompatibility('pg_dump', '17.1', server('postgres', 160200)).compatible).toBe(true)
    expect(toolCompatibility('gbak', '2.5.9', server('firebird', 30000)).compatible).toBe(false)
    expect(toolCompatibility('mysqldump', '8.4.3', server('mariadb', 110400))).toMatchObject({ compatible: true, reason: expect.stringMatching(/MariaDB/) })
  })
})

describe('client tool commands', () => {
  const profile = { host: 'db.example', port: 3306, user: 'admin', database: 'shop', options: {}, ssl: { enabled: false, rejectUnauthorized: false }, ssh: { enabled: true } } as unknown as ConnectionProfile
  const target: ToolTarget = { profile, secrets: { password: 's3cr"et' }, endpoint: { host: '127.0.0.1', port: 40000 }, tunneled: true }
  const o: LogicalBackupOptions = {
    databases: ['shop'],
    objects: { views: true, routines: true, triggers: true, sequences: true, domainsAndTypes: true, events: true, materializedViews: true, extensions: true },
    sequenceValues: true,
    usersAndGrants: false,
    createDatabase: false,
    dropObjects: true,
    stripDefiners: false,
    includeOwners: false,
    consistentSnapshot: true,
    rowsPerInsert: 100,
    tables: { shop: [{ name: 'orders', data: true }, { name: 'logs', data: false }] }
  }

  it('keeps the MySQL password in a private option file and connects through the tunnel', () => {
    const { invocation, runs } = mysqlDumpInvocations('mysqldump', target, o, { maria: false, serverIsMaria: false })
    expect(runs.every((r) => r.args[0] === `--defaults-extra-file=${CREDENTIAL_PLACEHOLDER}`)).toBe(true)
    expect(runs.flatMap((r) => r.args).join(' ')).not.toContain('s3cr')
    expect(invocation.credentialFile?.contents).toContain('password="s3cr\\"et"')
    expect(invocation.credentialFile?.contents).toContain('host="127.0.0.1"')
    // Oracle mysqldump has no --ignore-table-data: structure-only tables get a second run.
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({ append: true })
    expect(runs[1].args).toContain('--no-data')
    expect(runs[1].args.slice(-2)).toEqual(['shop', 'logs'])
  })

  it('writes no USE for one database restored elsewhere', () => {
    const { runs } = mysqlDumpInvocations('mysqldump', target, { ...o, tables: undefined }, { maria: false, serverIsMaria: false })
    expect(runs[0].args).not.toContain('--databases')
    expect(runs[0].args.at(-1)).toBe('shop')
    expect(mysqlDumpInvocations('mysqldump', target, { ...o, tables: undefined, databases: ['a', 'b'] }, { maria: false, serverIsMaria: false }).runs[0].args).toContain('--databases')
  })

  it('uses --ignore-table-data with mariadb-dump', () => {
    const { runs } = mysqlDumpInvocations('mariadb-dump', target, o, { maria: true, serverIsMaria: true })
    expect(runs).toHaveLength(1)
    expect(runs[0].args).toContain('--ignore-table-data=shop.logs')
  })

  it('passes the PostgreSQL password in the environment', () => {
    const inv = pgDumpInvocation('pg_dump', target, 'shop', { ...o, tables: { shop: [{ schema: 'public', name: 'a"b', data: false }] } }, 'custom')
    expect(inv.args.join(' ')).not.toContain('s3cr')
    expect(inv.env?.PGPASSWORD).toBe('s3cr"et')
    expect(inv.args).toContain('--table="public"."a""b"')
    expect(inv.args).toContain('--exclude-table-data="public"."a""b"')
    expect(inv.args).toContain('--host=127.0.0.1')
  })

  it('streams gbak backups to stdout without verbose output', () => {
    const inv = gbakBackupInvocation('gbak', { ...target, profile: { ...profile, database: '/data/x.fdb' } }, undefined)
    expect(inv.args).toEqual(['-b', '127.0.0.1/40000:/data/x.fdb', 'stdout'])
    expect(inv.env).toEqual({ ISC_USER: 'admin', ISC_PASSWORD: 's3cr"et' })
  })
})

describe('script writer helpers', () => {
  it('strips DEFINER clauses', () => {
    expect(stripDefiner('CREATE DEFINER=`root`@`%` PROCEDURE p() SELECT 1')).toBe('CREATE PROCEDURE p() SELECT 1')
    expect(stripDefiner("CREATE ALGORITHM=UNDEFINED DEFINER='a'@'localhost' SQL SECURITY DEFINER VIEW v AS SELECT 1")).toBe(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW v AS SELECT 1'
    )
  })

  it('unwraps Firebird SET TERM blocks and builds placeholder routines', () => {
    const ddl = 'SET TERM ^ ;\nCREATE OR ALTER PROCEDURE "P" (\n  "A" INTEGER\n)\nRETURNS (\n  "N" INTEGER\n)\nAS\nBEGIN N = A; SUSPEND; END^\nSET TERM ; ^'
    const [st] = unwrapSetTerm(ddl)
    expect(st).toBe('CREATE OR ALTER PROCEDURE "P" (\n  "A" INTEGER\n)\nRETURNS (\n  "N" INTEGER\n)\nAS\nBEGIN N = A; SUSPEND; END')
    expect(placeholder(st, true)).toBe('CREATE OR ALTER PROCEDURE "P" (\n  "A" INTEGER\n)\nRETURNS (\n  "N" INTEGER\n)\nAS\nBEGIN\n  SUSPEND;\nEND')
    expect(unwrapSetTerm('SET TERM ^ ;\nCREATE OR ALTER PACKAGE "K"\nAS\nBEGIN END^\nRECREATE PACKAGE BODY "K"\nAS\nBEGIN END^\nSET TERM ; ^')).toHaveLength(2)
  })

  it('writes routines so the engine splitter reads them back', async () => {
    for (const [engine, body] of [
      ['mysql', 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END'],
      ['firebird', 'CREATE OR ALTER PROCEDURE P AS BEGIN EXIT; END'],
      ['postgres', 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$BEGIN RETURN 1; END$$']
    ] as const) {
      const out = new MemoryWriter()
      const w = new ScriptWriter(out, engine)
      await w.statement('SELECT 0;')
      await w.routine(body)
      await w.statement('SELECT 3')
      expect(splitSql(out.text, engine).map((s) => s.sql)).toEqual(['SELECT 0', body, 'SELECT 3'])
    }
  })
})

describe('table data writer', () => {
  const ref = { name: 't', kind: 'table' as const }

  it('caps multi-row INSERTs by rows and bytes', async () => {
    const out = new MemoryWriter()
    const rows: CellValue[][] = Array.from({ length: 10 }, (_, i) => [i, 'x'.repeat(100)])
    await writeTableData(fakeConnection(rows), new ScriptWriter(out, 'mysql'), { ref, columns: ['id', 'v'], keyColumns: ['id'] }, {
      engine: 'mysql',
      dialect: new MySqlDialect(80000, false),
      verb: 'INSERT',
      rowsPerInsert: 4,
      maxStatementBytes: 300,
      maxLiteralChars: Number.POSITIVE_INFINITY,
      executeBlock: false,
      isCancelled: () => false,
      onRows: () => undefined
    })
    const statements = splitSql(out.text, 'mysql')
    expect(statements.length).toBeGreaterThanOrEqual(5)
    expect(statements.every((s) => s.sql.length <= 300 || s.sql.split('\n').length === 2)).toBe(true)
    expect(statements.map((s) => s.sql.split('\n').length - 1).reduce((a, b) => a + b)).toBe(10)
  })

  it('batches Firebird rows in EXECUTE BLOCK and appends large values by key', async () => {
    const out = new MemoryWriter()
    const big = new Uint8Array(40_000).fill(0xab)
    const rows: CellValue[][] = [[1, 'a'], [2, big], [3, null]]
    const r = await writeTableData(fakeConnection(rows), new ScriptWriter(out, 'firebird'), { ref, columns: ['ID', 'B'], keyColumns: ['ID'] }, {
      engine: 'firebird',
      dialect: new FbDialect(30000),
      verb: 'INSERT',
      rowsPerInsert: 100,
      maxStatementBytes: 60_000,
      maxLiteralChars: 8_000,
      executeBlock: true,
      isCancelled: () => false,
      onRows: () => undefined
    })
    expect(r.rows).toBe(3)
    const statements = splitSql(out.text, 'firebird').map((s) => s.sql)
    expect(statements[0]).toBe(`EXECUTE BLOCK AS BEGIN\nINSERT INTO "t" (ID, B) VALUES (1, 'a');\nINSERT INTO "t" (ID, B) VALUES (2, NULL);\nEND`)
    const ups = statements.filter((s) => s.startsWith('UPDATE'))
    expect(ups).toHaveLength(3)
    expect(ups[0]).toMatch(/^UPDATE "t" SET B = x'AB/i)
    expect(ups[1]).toMatch(/SET B = B \|\| x'/i)
    expect(ups.every((u) => u.endsWith('WHERE ID = 2') && u.length < 60_000)).toBe(true)
    expect(statements.at(-1)).toBe('INSERT INTO "t" (ID, B) VALUES (3, NULL)')
  })

  it('writes OVERRIDING SYSTEM VALUE for PostgreSQL identity columns', async () => {
    const out = new MemoryWriter()
    await writeTableData(fakeConnection([[1]]), new ScriptWriter(out, 'postgres'), { ref: { ...ref, schema: 'public' }, columns: ['id'], keyColumns: ['id'], overridingSystemValue: true }, {
      engine: 'postgres',
      dialect: new PgDialect(160000),
      verb: 'INSERT',
      rowsPerInsert: 10,
      maxStatementBytes: 1 << 20,
      maxLiteralChars: Number.POSITIVE_INFINITY,
      executeBlock: false,
      isCancelled: () => false,
      onRows: () => undefined
    })
    expect(out.text).toContain('INSERT INTO public.t (id) OVERRIDING SYSTEM VALUE VALUES\n(1);')
  })
})

describe('script restorer', () => {
  it('replaces the script transaction with its own and commits once', async () => {
    const conn = fakeConnection()
    const r = await restoreScript(reader('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t (a);\nINSERT INTO t VALUES (1);\nCOMMIT;\n'), conn, {
      ...restoreOptions,
      engine: 'sqlite',
      mode: 'single'
    })
    expect(r).toMatchObject({ statements: 3, errors: 0 })
    expect(conn.ran).toEqual(['PRAGMA foreign_keys = OFF', 'CREATE TABLE t (a)', 'INSERT INTO t VALUES (1)'])
    expect(conn.commits).toBe(1)
  })

  it('runs statements without their leading comments (drivers look at the first word)', async () => {
    const conn = fakeConnection()
    await restoreScript(reader('-- OST-Backup: {}\n-- Server: x\n\nPRAGMA foreign_keys = OFF;\n--\n-- Tables\n--\nBEGIN TRANSACTION;\nCREATE TABLE t (a);\n'), conn, {
      ...restoreOptions,
      engine: 'sqlite',
      mode: 'single'
    })
    expect(conn.ran).toEqual(['PRAGMA foreign_keys = OFF', 'CREATE TABLE t (a)'])
  })

  it('commits in batches and right after Firebird DDL', async () => {
    const conn = fakeConnection()
    await restoreScript(reader('CREATE TABLE T (A INT);\nINSERT INTO T VALUES (1);\nINSERT INTO T VALUES (2);\nINSERT INTO T VALUES (3);\n'), conn, {
      ...restoreOptions,
      engine: 'firebird',
      mode: 'batched'
    })
    // After the DDL, then after two inserts, then the final commit.
    expect(conn.commits).toBe(3)
  })

  it('counts errors and goes on unless told to stop', async () => {
    const conn = fakeConnection([], (sql) => sql.includes('bad'))
    const errors: string[] = []
    const r = await restoreScript(reader('SELECT 1; SELECT bad; SELECT 2;'), conn, { ...restoreOptions, stopOnError: false, engine: 'mysql', mode: 'none', onError: (m) => errors.push(m) })
    expect(r).toMatchObject({ statements: 3, errors: 1 })
    expect(errors).toEqual(['failed: SELECT bad'])
    await expect(restoreScript(reader('SELECT bad; SELECT 2;'), fakeConnection([], (sql) => sql.includes('bad')), { ...restoreOptions, engine: 'mysql', mode: 'none' })).rejects.toThrow('failed')
  })

  it('refuses psql-only dumps', async () => {
    await expect(restoreScript(reader('COPY public.t (a) FROM stdin;\n1\n\\.\n'), fakeConnection(), { ...restoreOptions, engine: 'postgres', mode: 'single' })).rejects.toBeInstanceOf(NeedsPsqlError)
  })
})
