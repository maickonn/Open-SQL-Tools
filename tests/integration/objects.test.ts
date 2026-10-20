import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DbEngine, DbObjectRef } from '@shared/model'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { creatableKinds, triggerCapabilities } from '@domain/objectCapabilities'
import { availableTargets, profileFor, type Target } from './targets'

// Trigger / routine / generator / exception utilities against real servers:
//   npm run test:db -- firebird25 firebird5 postgres18 mysql97 mariadb118
const targets = await availableTargets()

interface Fixture {
  database?: string
  schema?: string
  setup: string
  cleanup: string
  table: string
  trigger: DbObjectRef
  /** Absent for engines without stored routines (SQLite). */
  routine?: DbObjectRef
  sequence?: string
  event?: string
  /** Template objects created by the "New …" menu items, dropped afterwards. */
  templateCleanup: string
}

const FB_SETUP = (v3: boolean): string => `
CREATE TABLE OBJ_T (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(20));
CREATE TABLE OBJ_LOG (ID INTEGER, MSG VARCHAR(50));
CREATE GENERATOR OBJ_GEN;
CREATE EXCEPTION OBJ_ERR 'boom';
SET TERM ^ ;
CREATE TRIGGER OBJ_T_AUDIT FOR OBJ_T ACTIVE AFTER INSERT POSITION 0 AS
BEGIN
  IF (NEW.NAME = 'x') THEN EXCEPTION OBJ_ERR;
  INSERT INTO OBJ_LOG (ID, MSG) VALUES (NEW.ID, NEW.NAME);
END^
CREATE PROCEDURE OBJ_P (P_ID INTEGER) RETURNS (N VARCHAR(20)) AS
BEGIN
  FOR SELECT NAME FROM OBJ_T WHERE ID = :P_ID INTO :N DO SUSPEND;
END^
SET TERM ; ^
${v3 ? '' : ''}`

const FB_CLEANUP = `DROP TRIGGER OBJ_T_AUDIT; DROP PROCEDURE OBJ_P; DROP TABLE OBJ_LOG; DROP TABLE OBJ_T; DROP EXCEPTION OBJ_ERR; DROP GENERATOR OBJ_GEN;`

function fixtureFor(target: Target): Fixture {
  const engine: DbEngine = target.engine
  switch (engine) {
    case 'firebird':
      return {
        setup: FB_SETUP(target.id !== 'firebird25'),
        cleanup: FB_CLEANUP,
        table: 'OBJ_T',
        trigger: { name: 'OBJ_T_AUDIT', kind: 'trigger', table: 'OBJ_T' },
        routine: { name: 'OBJ_P', kind: 'procedure' },
        sequence: 'OBJ_GEN',
        templateCleanup:
          'DROP TRIGGER OBJ_T_BI0; DROP VIEW NEW_VIEW; DROP PROCEDURE NEW_PROCEDURE; DROP FUNCTION NEW_FUNCTION; DROP SEQUENCE NEW_SEQUENCE; DROP GENERATOR NEW_GENERATOR; DROP EXCEPTION NEW_EXCEPTION; DROP DOMAIN NEW_DOMAIN;'
      }
    case 'postgres':
      return {
        database: 'testdb',
        schema: 'public',
        setup: `CREATE TABLE obj_t (id int PRIMARY KEY, name varchar(20));
          CREATE TABLE obj_log (id int, msg varchar(50));
          CREATE SEQUENCE obj_gen;
          CREATE VIEW obj_v AS SELECT id, name FROM obj_t;
          CREATE FUNCTION obj_trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO obj_log VALUES (NEW.id, NEW.name); RETURN NEW; END; $$;
          CREATE TRIGGER obj_t_audit AFTER INSERT ON obj_t FOR EACH ROW EXECUTE FUNCTION obj_trg_fn();
          CREATE FUNCTION obj_p(p_id integer) RETURNS SETOF varchar LANGUAGE sql AS $$ SELECT name FROM obj_t WHERE id = p_id $$;`,
        cleanup: 'DROP VIEW IF EXISTS obj_v; DROP TABLE IF EXISTS obj_log, obj_t CASCADE; DROP SEQUENCE IF EXISTS obj_gen; DROP FUNCTION IF EXISTS obj_trg_fn() CASCADE; DROP FUNCTION IF EXISTS obj_p(integer); DROP FUNCTION IF EXISTS obj_t_form_fn() CASCADE;',
        table: 'obj_t',
        trigger: { database: 'testdb', schema: 'public', name: 'obj_t_audit', kind: 'trigger', table: 'obj_t' },
        routine: { database: 'testdb', schema: 'public', name: 'obj_p', kind: 'function', args: 'p_id integer' },
        sequence: 'obj_gen',
        templateCleanup:
          'DROP VIEW IF EXISTS new_view; DROP MATERIALIZED VIEW IF EXISTS new_materialized_view; DROP FUNCTION IF EXISTS new_function(integer); DROP PROCEDURE IF EXISTS new_procedure(integer); DROP TRIGGER IF EXISTS obj_t_biu ON obj_t; DROP FUNCTION IF EXISTS obj_t_trigger_fn(); DROP SEQUENCE IF EXISTS new_sequence; DROP DOMAIN IF EXISTS new_domain; DROP TYPE IF EXISTS new_type;'
      }
    case 'mysql':
    case 'mariadb':
      return {
        database: 'testdb',
        setup: `CREATE TABLE obj_t (id INT PRIMARY KEY, name VARCHAR(20));
          CREATE TABLE obj_log (id INT, msg VARCHAR(50));
          CREATE TRIGGER obj_t_audit AFTER INSERT ON obj_t FOR EACH ROW INSERT INTO obj_log VALUES (NEW.id, NEW.name);
          CREATE PROCEDURE obj_p(IN p_id INT) SELECT name FROM obj_t WHERE id = p_id;
          CREATE EVENT obj_e ON SCHEDULE EVERY 1 DAY DO DELETE FROM obj_log WHERE id < 0;
          ${engine === 'mariadb' ? 'CREATE SEQUENCE obj_gen;' : ''}`,
        cleanup: `DROP EVENT IF EXISTS obj_e; DROP PROCEDURE IF EXISTS obj_p; DROP TABLE IF EXISTS obj_log, obj_t;${engine === 'mariadb' ? ' DROP SEQUENCE IF EXISTS obj_gen;' : ''}`,
        table: 'obj_t',
        trigger: { database: 'testdb', name: 'obj_t_audit', kind: 'trigger', table: 'obj_t' },
        routine: { database: 'testdb', name: 'obj_p', kind: 'procedure' },
        sequence: engine === 'mariadb' ? 'obj_gen' : undefined,
        event: 'obj_e',
        templateCleanup:
          'DROP VIEW IF EXISTS new_view; DROP PROCEDURE IF EXISTS new_procedure; DROP FUNCTION IF EXISTS new_function; DROP TRIGGER IF EXISTS obj_t_bi; DROP EVENT IF EXISTS new_event; ' +
          (engine === 'mariadb' ? 'DROP SEQUENCE IF EXISTS new_sequence;' : '')
      }
    case 'sqlite':
      return {
        setup: `CREATE TABLE obj_t (id INTEGER PRIMARY KEY, name VARCHAR(20));
          CREATE TABLE obj_log (id INTEGER, msg VARCHAR(50));
          CREATE VIEW obj_v AS SELECT id, name FROM obj_t;
          CREATE TRIGGER obj_t_audit AFTER INSERT ON obj_t BEGIN INSERT INTO obj_log (id, msg) VALUES (NEW.id, NEW.name); END;`,
        cleanup: 'DROP VIEW IF EXISTS obj_v; DROP TABLE IF EXISTS obj_log; DROP TABLE IF EXISTS obj_t;',
        table: 'obj_t',
        trigger: { name: 'obj_t_audit', kind: 'trigger', table: 'obj_t' },
        templateCleanup: 'DROP VIEW IF EXISTS new_view; DROP TRIGGER IF EXISTS obj_t_ai;'
      }
  }
}

describe.skipIf(!targets.length)('object utilities', () => {
  describe.each(targets.map((t) => [t.id, t] as [string, Target]))('%s', (_id, target) => {
    const fx = fixtureFor(target)
    const svc = new SessionService({ openDatabase, openTunnel: async () => null, createWriter: createFileWriter, readText: readTextFile, emit: () => undefined })
    const run = async (sql: string, stopOnError = true): Promise<void> => {
      const r = await svc.execute({ queryId: 'obj', sql, maxRows: 100, database: fx.database, stopOnError })
      if (stopOnError) expect(r.statements.find((s) => s.error)?.error?.message ?? null).toBeNull()
    }
    const objects = () => svc.listObjects({ database: fx.database, schema: fx.schema })

    beforeAll(async () => {
      await svc.connect({ profile: profileFor(target), secrets: { password: target.password } })
      await run(fx.templateCleanup, false)
      await run(fx.cleanup, false)
      await run(fx.setup)
    })

    afterAll(async () => {
      await run(fx.templateCleanup, false).catch(() => undefined)
      await run(fx.cleanup, false).catch(() => undefined)
      await svc.disconnect()
    })

    it.skipIf(!triggerCapabilities(target.engine).active)('deactivates and reactivates a trigger', async () => {
      const state = async () => (await objects()).find((o) => o.kind === 'trigger' && o.name === fx.trigger.name)
      expect((await state())?.inactive).toBeUndefined()
      await svc.setEnabled({ refs: [fx.trigger], enabled: false })
      expect((await state())?.inactive).toBe(true)
      await svc.setEnabled({ refs: [fx.trigger], enabled: true })
      expect((await state())?.inactive).toBeUndefined()
    })

    it.skipIf(target.engine !== 'firebird')('reads the catalog while another attachment has an uncommitted trigger change', async () => {
      // Another tool compiled a trigger and has not committed yet: catalog reads must not wait for it.
      const other = new SessionService({ openDatabase, openTunnel: async () => null, createWriter: createFileWriter, readText: readTextFile, emit: () => undefined })
      await other.connect({ profile: profileFor(target), secrets: { password: target.password } })
      try {
        await other.setAutocommit({ enabled: false })
        const pending = await other.execute({ queryId: 'pending', sql: `ALTER TRIGGER ${fx.trigger.name} INACTIVE`, maxRows: 10 })
        expect(pending.statements[0].error?.message).toBeUndefined()
        const listed = await Promise.race([objects(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('catalog read waited for the other attachment')), 5000))])
        expect(listed.find((o) => o.name === fx.trigger.name)?.inactive).toBeUndefined()

        // Saving the same trigger from the form fails after the lock timeout instead of hanging.
        const def = await svc.getTrigger({ ref: fx.trigger })
        const t0 = Date.now()
        const saving = svc.saveTrigger({ original: def, target: { ...def, position: (def.position ?? 0) + 1 } })
        const outcome = await Promise.race([saving.then(() => 'saved', (e: Error) => e.message), new Promise<string>((r) => setTimeout(() => r('hung'), 25_000))])
        expect(outcome).not.toBe('hung')
        expect(outcome).not.toBe('saved')
        expect(Date.now() - t0).toBeLessThan(20_000)
      } finally {
        await other.rollback().catch(() => undefined)
        await other.disconnect()
      }
    })

    it.skipIf(!fx.event)('disables and enables an event', async () => {
      const ref: DbObjectRef = { database: fx.database, name: fx.event!, kind: 'event' }
      const state = async () => (await objects()).find((o) => o.kind === 'event' && o.name === fx.event)
      await svc.setEnabled({ refs: [ref], enabled: false })
      expect((await state())?.inactive).toBe(true)
      await svc.setEnabled({ refs: [ref], enabled: true })
      expect((await state())?.inactive).toBeUndefined()
      await expect(svc.setEnabled({ refs: [fx.trigger], enabled: false })).rejects.toThrow()
    })

    it.skipIf(!fx.sequence)('sets a generator / sequence value', async () => {
      const ref: DbObjectRef = { database: fx.database, schema: fx.schema, name: fx.sequence!, kind: 'sequence' }
      await svc.setSequenceValue({ ref, value: '41' })
      const seq = (await svc.listSequences({ database: fx.database, schema: fx.schema })).find((s) => s.name === fx.sequence)
      expect(seq?.value).toBe('41')
      await expect(svc.setSequenceValue({ ref, value: '1; DROP TABLE x' })).rejects.toThrow()
    })

    it.skipIf(target.engine !== 'firebird')('edits an exception message', async () => {
      await svc.setExceptionMessage({ ref: { name: 'OBJ_ERR', kind: 'exception' }, message: "it's changed" })
      const ex = (await svc.listExceptions()).find((e) => e.name === 'OBJ_ERR')
      expect(ex?.message).toBe("it's changed")
      expect(ex?.number).toBeGreaterThan(0)
    })

    it('reports dependencies in both directions', async () => {
      const tableDeps = await svc.getDependencies({ ref: { database: fx.database, schema: fx.schema, name: fx.table, kind: 'table' } })
      expect(tableDeps.some((d) => d.direction === 'usedBy' && d.kind === 'trigger' && d.name === fx.trigger.name)).toBe(true)
      if (target.engine === 'firebird') {
        const triggerDeps = await svc.getDependencies({ ref: fx.trigger })
        const uses = triggerDeps.filter((d) => d.direction === 'uses').map((d) => `${d.kind}:${d.name}`)
        expect(uses).toEqual(expect.arrayContaining(['table:OBJ_T', 'table:OBJ_LOG', 'exception:OBJ_ERR']))
        expect(tableDeps.some((d) => d.direction === 'usedBy' && d.kind === 'procedure' && d.name === 'OBJ_P')).toBe(true)
      }
      if (target.engine === 'sqlite') {
        expect(tableDeps.some((d) => d.direction === 'usedBy' && d.kind === 'view' && d.name === 'obj_v')).toBe(true)
        const viewDeps = await svc.getDependencies({ ref: { name: 'obj_v', kind: 'view' } })
        expect(viewDeps.some((d) => d.direction === 'uses' && d.kind === 'table' && d.name === 'obj_t')).toBe(true)
      }
      if (target.engine === 'postgres') {
        expect(tableDeps.some((d) => d.direction === 'usedBy' && d.kind === 'view' && d.name === 'obj_v')).toBe(true)
        const triggerDeps = await svc.getDependencies({ ref: fx.trigger })
        expect(triggerDeps.some((d) => d.direction === 'uses' && d.kind === 'function' && d.name === 'obj_trg_fn')).toBe(true)
      }
    })

    it.skipIf(!fx.routine)('builds a runnable call for a routine', async () => {
      const sql = await svc.getRoutineCall({ ref: fx.routine! })
      expect(sql).toMatch(/NULL \/\*/)
      const r = await svc.execute({ queryId: 'call', sql, maxRows: 10, database: fx.database })
      expect(r.statements[0].error?.message).toBeUndefined()
    })

    it.skipIf(target.engine !== 'firebird')('lists routine and trigger operations with plans', async () => {
      const proc = await svc.getRoutineOperations({ ref: fx.routine! })
      expect(proc).toHaveLength(1)
      expect(proc[0]).toMatchObject({ operation: 'select', table: 'OBJ_T' })
      expect(proc[0].error).toBeUndefined()
      expect(proc[0].plan).toMatch(/PLAN.*OBJ_T/)
      const trg = await svc.getRoutineOperations({ ref: fx.trigger })
      expect(trg.map((o) => `${o.operation}:${o.table}`)).toEqual(['insert:OBJ_LOG'])
      expect(trg[0].error).toBeUndefined()
    })

    it('edits, creates and renames triggers through the trigger form model', async () => {
      const fb = target.engine === 'firebird'
      const my = target.engine === 'mysql' || target.engine === 'mariadb'
      // MySQL family and SQLite: one event per trigger and no inactive state.
      const single = !triggerCapabilities(target.engine).multipleEvents
      const original = await svc.getTrigger({ ref: fx.trigger })
      expect(original).toMatchObject({ table: fx.table, timing: 'AFTER', events: ['INSERT'], active: true, editable: true })

      const changed = {
        ...original,
        timing: 'BEFORE' as const,
        events: single ? (['UPDATE'] as const).slice() : (['INSERT', 'UPDATE'] as const).slice(),
        position: fb ? 5 : original.position,
        active: single,
        body: fb ? original.body.replace(/BEGIN/i, 'BEGIN\n  /* edited */') : my ? original.body : original.body.replace(/BEGIN/i, 'BEGIN /* edited */')
      }
      await svc.saveTrigger({ original, target: changed })
      const reread = await svc.getTrigger({ ref: fx.trigger })
      expect(reread).toMatchObject({ timing: 'BEFORE', events: changed.events, active: changed.active })
      if (fb) expect(reread.position).toBe(5)
      if (!my) expect(reread.body).toMatch(/edited/)

      // New trigger from the form, then renamed.
      const name = fb ? 'OBJ_T_FORM' : 'obj_t_form'
      const created = { name, database: fx.database, schema: fx.schema, table: fx.table, timing: 'BEFORE' as const, events: ['DELETE' as const], position: 1, active: true, body: svc.triggerBodyTemplate(), editable: true }
      const { ref } = await svc.saveTrigger({ original: null, target: created })
      expect(ref.name).toBe(name)
      const renamed = { ...(await svc.getTrigger({ ref })), name: `${name}2` }
      await svc.saveTrigger({ original: { ...created }, target: renamed })
      const triggers = (await objects()).filter((o) => o.kind === 'trigger').map((o) => o.name)
      expect(triggers).toContain(`${name}2`)
      expect(triggers).not.toContain(name)
      await svc.objectAction({ ref: { ...ref, name: `${name}2` }, action: 'drop' })

      if (fb) {
        const dbTrigger = { name: 'OBJ_ON_CONNECT', timing: 'BEFORE' as const, events: [], databaseEvent: 'CONNECT' as const, position: 0, active: false, body: 'AS\nBEGIN\nEND', editable: true }
        await svc.saveTrigger({ original: null, target: dbTrigger })
        expect(await svc.getTrigger({ ref: { name: 'OBJ_ON_CONNECT', kind: 'trigger' } })).toMatchObject({ databaseEvent: 'CONNECT', active: false, table: undefined })
        await svc.objectAction({ ref: { name: 'OBJ_ON_CONNECT', kind: 'trigger' }, action: 'drop' })
      }
    })

    it('creates every kind of object from its template', async () => {
      const failures: string[] = []
      const kinds = creatableKinds(target.engine).filter((k) => k !== 'table' && !(k === 'function' && target.id === 'firebird25'))
      for (const kind of kinds) {
        const sql = svc.createTemplate({ kind, database: fx.database, schema: fx.schema, table: fx.table })
        const r = await svc.execute({ queryId: `tpl-${kind}`, sql, maxRows: 10, database: fx.database })
        const err = r.statements.find((s) => s.error)?.error?.message
        if (err) failures.push(`${kind}: ${err}`)
      }
      expect(failures).toEqual([])
    })
  })
})
