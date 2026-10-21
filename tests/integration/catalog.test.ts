import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DbEngine } from '@shared/model'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { availableTargets, profileFor, type Target } from './targets'

// Batch catalog used by the editor's IntelliSense: one query per schema, same data as getTableStructure.
//   npm run test:db -- mysql97 mariadb118 postgres18 firebird25 firebird5
const targets = await availableTargets()

const isMy = (e: DbEngine): boolean => e === 'mysql' || e === 'mariadb'

function fixture(engine: DbEngine): { setup: string[]; cleanup: string[]; routine?: { name: string; params: string[] } } {
  switch (engine) {
    case 'firebird':
      return {
        setup: [
          'CREATE TABLE CAT_T (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(40), PRICE NUMERIC(10,2) NOT NULL)',
          'CREATE PROCEDURE CAT_P (P_ID INTEGER, P_NAME VARCHAR(10)) RETURNS (TOTAL INTEGER) AS BEGIN TOTAL = P_ID; SUSPEND; END'
        ],
        cleanup: ['DROP PROCEDURE CAT_P', 'DROP TABLE CAT_T'],
        routine: { name: 'CAT_P', params: ['P_ID', 'P_NAME', 'TOTAL'] }
      }
    case 'postgres':
      return {
        setup: [
          'CREATE TABLE cat_t (id integer PRIMARY KEY, name varchar(40), price numeric(10,2) NOT NULL)',
          'CREATE FUNCTION cat_f(p_id integer, p_name text) RETURNS integer LANGUAGE sql AS $$ SELECT p_id $$'
        ],
        cleanup: ['DROP FUNCTION IF EXISTS cat_f(integer, text)', 'DROP TABLE IF EXISTS cat_t'],
        routine: { name: 'cat_f', params: ['p_id', 'p_name'] }
      }
    case 'mysql':
    case 'mariadb':
      return {
        setup: [
          'CREATE TABLE cat_t (id INT NOT NULL PRIMARY KEY, name VARCHAR(40), price DECIMAL(10,2) NOT NULL)',
          'CREATE PROCEDURE cat_p(IN p_id INT, OUT p_name VARCHAR(10)) SELECT p_id INTO p_name'
        ],
        cleanup: ['DROP PROCEDURE IF EXISTS cat_p', 'DROP TABLE IF EXISTS cat_t'],
        routine: { name: 'cat_p', params: ['p_id', 'p_name'] }
      }
    case 'sqlite':
      return { setup: ['CREATE TABLE cat_t (id INTEGER PRIMARY KEY, name VARCHAR(40), price NUMERIC(10,2) NOT NULL)'], cleanup: ['DROP TABLE IF EXISTS cat_t'] }
  }
}

describe.skipIf(!targets.length)('batch catalog', () => {
  describe.each(targets.map((t) => [t.id, t] as [string, Target]))('%s', (_id, target) => {
    const svc = new SessionService({ openDatabase, openTunnel: async () => null, createWriter: createFileWriter, readText: readTextFile, emit: () => undefined })
    const engine = target.engine
    const fx = fixture(engine)
    const database = isMy(engine) ? 'testdb' : undefined
    const schema = engine === 'postgres' ? 'public' : undefined
    const run = async (sql: string): Promise<void> => {
      await svc.execute({ queryId: 'cat', sql, maxRows: 10, database })
    }

    beforeAll(async () => {
      await svc.connect({ profile: profileFor(target), secrets: { password: target.password } })
      for (const sql of fx.cleanup) await run(sql).catch(() => undefined)
      for (const sql of fx.setup) {
        const r = await svc.execute({ queryId: 'cat', sql, maxRows: 10, database })
        expect(r.statements.find((s) => s.error)?.error?.message ?? null).toBeNull()
      }
    })

    afterAll(async () => {
      for (const sql of fx.cleanup) await run(sql).catch(() => undefined)
      await svc.disconnect()
    })

    it('lists every column of the schema like getTableStructure', async () => {
      const table = engine === 'firebird' ? 'CAT_T' : 'cat_t'
      const columns = (await svc.listColumns({ database, schema })).filter((c) => c.table === table)
      const structure = await svc.getTableStructure({ ref: { database, schema, name: table, kind: 'table' } })
      expect(columns.map((c) => c.name)).toEqual(structure.columns.map((c) => c.name))
      expect(columns.map((c) => c.primaryKey)).toEqual([true, false, false])
      expect(columns.map((c) => c.nullable)).toEqual(engine === 'sqlite' ? [true, true, false] : [false, true, false])
      expect(columns[2].type.toUpperCase()).toMatch(/NUMERIC|DECIMAL/)
    })

    it.skipIf(!fx.routine)('lists routines with their parameters', async () => {
      const routine = (await svc.listRoutines({ database, schema })).find((r) => r.name === fx.routine!.name)
      expect(routine?.params.map((p) => p.name)).toEqual(fx.routine!.params)
      if (engine === 'postgres') expect(routine?.returns).toBe('integer')
    })
  })
})
