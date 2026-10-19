import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DbEngine } from '@shared/model'
import type { WorkerEvents } from '@shared/workerApi'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { copyTable, type CopySession } from '@application/copy/copyTable'
import { availableTargets, profileFor, type Target } from './targets'

const targets = (await availableTargets()).filter((t) => t.engine !== 'firebird')

/** Wraps a SessionService so renderer code (which talks RPC) can drive it in-process. */
async function liveSession(target: Target, id: string): Promise<{ state: CopySession; svc: SessionService }> {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const svc = new SessionService({
    openDatabase,
    openTunnel: async () => null,
    createWriter: createFileWriter,
    readText: readTextFile,
    emit: <K extends keyof WorkerEvents & string>(name: K, payload: WorkerEvents[K]) => {
      for (const l of listeners.get(name) ?? []) l(payload)
    }
  })
  const info = await svc.connect({ profile: profileFor(target), secrets: { password: target.password } })
  const client = {
    call: (method: string, params: unknown) => Promise.resolve((svc as unknown as Record<string, (p: unknown) => unknown>)[method](params)),
    on: (name: string, l: (p: unknown) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(l)
      listeners.set(name, set)
      return () => set.delete(l)
    }
  }
  const state = { id, info, client } as unknown as CopySession
  return { state, svc }
}

const isMy = (e: DbEngine): boolean => e === 'mysql' || e === 'mariadb'

describe.skipIf(!targets.length)('partitioning, bulk editor and table copy', () => {
  describe.each(targets.map((t) => [t.id, t] as [string, Target]))('%s', (_id, target) => {
    let a: Awaited<ReturnType<typeof liveSession>>
    let b: Awaited<ReturnType<typeof liveSession>>
    const engine = target.engine
    const db = isMy(engine) ? 'testdb' : 'testdb'
    const otherNs = isMy(engine) ? 'testdb_archive' : 'archive'

    beforeAll(async () => {
      a = await liveSession(target, 'a')
      b = await liveSession(target, 'b')
      const setup = isMy(engine)
        ? `DROP DATABASE IF EXISTS ${otherNs}; CREATE DATABASE ${otherNs};
           DROP TABLE IF EXISTS testdb.f_src, testdb.f_copy, testdb.f_stream, testdb.f_part;
           CREATE TABLE testdb.f_src (id INT PRIMARY KEY, name VARCHAR(20), total DECIMAL(8,2), doubled INT AS (id * 2));
           INSERT INTO testdb.f_src (id, name, total) VALUES (1, 'a', 1.5), (2, 'b', 2.5), (3, NULL, NULL);`
        : `DROP SCHEMA IF EXISTS ${otherNs} CASCADE; CREATE SCHEMA ${otherNs};
           DROP TABLE IF EXISTS f_src, f_copy, f_stream, f_part CASCADE;
           CREATE TABLE f_src (id int PRIMARY KEY, name varchar(20), total numeric(8,2), doubled int GENERATED ALWAYS AS (id * 2) STORED);
           INSERT INTO f_src (id, name, total) VALUES (1, 'a', 1.5), (2, 'b', 2.5), (3, NULL, NULL);`
      const r = await a.svc.execute({ queryId: 'setup', sql: setup, maxRows: 10, database: db })
      expect(r.statements.find((s) => s.error)?.error?.message ?? null).toBeNull()
    })

    afterAll(async () => {
      await a?.svc.disconnect()
      await b?.svc.disconnect()
    })

    const ref = (name: string, ns?: string) => ({ database: isMy(engine) ? (ns ?? db) : db, schema: isMy(engine) ? undefined : (ns ?? 'public'), name, kind: 'table' as const })

    it.skipIf(engine !== 'postgres')('switches databases back and forth on the same connections', async () => {
      for (const database of ['postgres', 'testdb', 'postgres', 'testdb']) {
        const r = await a.svc.query({ sql: 'SELECT current_database()', database })
        expect(r.rows[0][0]).toBe(database)
        const objects = await a.svc.listObjects({ database, schema: 'public' })
        expect(objects.some((o) => o.name === 'f_src')).toBe(database === 'testdb')
      }
    })

    it('creates, reads back and extends a partitioned table', async () => {
      const partitioning = isMy(engine)
        ? { method: 'RANGE' as const, expression: 'id', partitions: [{ name: 'p0', bound: 'LESS THAN (100)' }, { name: 'p1', bound: 'LESS THAN (200)' }] }
        : { method: 'RANGE' as const, expression: 'id', partitions: [{ name: 'f_part_p0', bound: 'FROM (0) TO (100)' }, { name: 'f_part_p1', bound: 'FROM (100) TO (200)' }] }
      const structure = {
        ref: ref('f_part'),
        columns: [{ name: 'id', dataType: 'INT', fullType: isMy(engine) ? 'int' : 'integer', nullable: false }],
        indexes: [{ name: isMy(engine) ? 'PRIMARY' : 'f_part_pkey', type: 'PRIMARY' as const, columns: ['id'], constraint: true }],
        foreignKeys: [],
        checks: [],
        options: { partitioning }
      }
      await a.svc.executeStatements({ statements: a.svc.generateTableDDL({ original: null, target: structure }), database: db })
      const read = await a.svc.getTableStructure({ ref: ref('f_part') })
      expect(read.options.partitioning?.method).toBe('RANGE')
      expect(read.options.partitioning?.partitions.map((p) => p.name)).toEqual(partitioning.partitions.map((p) => p.name))
      const extended = structuredClone(read)
      extended.options.partitioning!.partitions.push(isMy(engine) ? { name: 'p2', bound: 'LESS THAN (300)' } : { name: 'f_part_p2', bound: 'FROM (200) TO (300)' })
      await a.svc.executeStatements({ statements: a.svc.generateTableDDL({ original: read, target: extended }), database: db })
      const again = await a.svc.getTableStructure({ ref: ref('f_part') })
      expect(again.options.partitioning?.partitions).toHaveLength(3)
      // Re-reading and diffing an unchanged structure must produce no statements.
      expect(a.svc.generateTableDDL({ original: again, target: again })).toEqual([])
    })

    it('copies a table on the same server (INSERT … SELECT)', async () => {
      const r = await copyTable({ source: a.state, ref: ref('f_src'), target: a.state, targetDatabase: db, targetSchema: isMy(engine) ? undefined : 'public', newName: 'f_copy', withData: true, dropExisting: true })
      expect(r.rows).toBe(3)
      const res = await a.svc.query({ sql: `SELECT id, name, doubled FROM ${isMy(engine) ? 'testdb.' : ''}f_copy ORDER BY id`, database: db })
      expect(res.rows.map((x) => [Number(x[0]), x[1], Number(x[2])])).toEqual([[1, 'a', 2], [2, 'b', 4], [3, null, 6]])
    })

    it('copies a table across connections by streaming', async () => {
      const r = await copyTable({ source: a.state, ref: ref('f_src'), target: b.state, targetDatabase: isMy(engine) ? otherNs : db, targetSchema: isMy(engine) ? undefined : otherNs, newName: 'f_stream', withData: true, dropExisting: true })
      expect(r.rows).toBe(3)
      const res = await b.svc.query({ sql: `SELECT COUNT(*), SUM(total) FROM ${otherNs}.f_stream`, database: db })
      expect(Number(res.rows[0][0])).toBe(3)
      expect(Number(res.rows[0][1])).toBe(4)
    })

    it('moves tables with the bulk editor', async () => {
      const r = await a.svc.bulkAlterTables({ tables: [ref('f_copy')], ops: { moveTo: otherNs, ...(isMy(engine) ? { engine: 'InnoDB' } : {}) } })
      expect(r.results[0].error).toBeUndefined()
      const res = await a.svc.query({ sql: `SELECT COUNT(*) FROM ${otherNs}.f_copy`, database: db })
      expect(Number(res.rows[0][0])).toBe(3)
    })
  })
})
