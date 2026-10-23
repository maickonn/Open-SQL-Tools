import { describe, expect, it } from 'vitest'
import type { TableStructure } from '@shared/model'
import { MariaDbDialect, MySqlDialect } from '@infrastructure/db/mysql-family/mysqlDialect'
import { PgDialect } from '@infrastructure/db/postgres/pgDialect'
import { FbDialect } from '@infrastructure/db/firebird/fbDialect'
import { lobKind } from '@domain/lob'

const table = (over: Partial<TableStructure> = {}): TableStructure => ({
  ref: { database: 'app', schema: 'public', name: 'items', kind: 'table' },
  columns: [
    { name: 'id', originalName: 'id', dataType: 'INT', fullType: 'int', nullable: false, autoIncrement: true },
    { name: 'name', originalName: 'name', dataType: 'VARCHAR', fullType: 'varchar(100)', nullable: false, defaultValue: "''" }
  ],
  indexes: [{ name: 'PRIMARY', type: 'PRIMARY', columns: ['id'] }],
  foreignKeys: [],
  checks: [],
  options: {},
  ...over
})

describe('MySQL dialect', () => {
  const d = new MySqlDialect(80400)

  it('quotes identifiers and literals with backslash escapes', () => {
    expect(d.quoteIdent('a`b')).toBe('`a``b`')
    expect(d.literal(String.raw`it's \ ok`)).toBe(String.raw`'it''s \\ ok'`)
    expect(d.literal(new Uint8Array([1, 255]))).toBe("X'01ff'")
    expect(d.literal(null)).toBe('NULL')
  })

  it('pages table data and limits edits to one row', () => {
    expect(d.selectTableData({ ref: table().ref, where: 'id > 1', orderBy: [{ column: 'name', desc: true }], offset: 10, limit: 5 })).toBe(
      'SELECT * FROM `app`.`items` WHERE id > 1 ORDER BY `name` DESC LIMIT 5 OFFSET 10'
    )
    expect(d.rowChanges(table().ref, [{ kind: 'update', key: { id: 1 }, values: { name: 'x' } }])).toEqual(["UPDATE `app`.`items` SET `name` = 'x' WHERE `id` = 1 LIMIT 1"])
    expect(d.rowChanges(table().ref, [{ kind: 'delete', key: { id: null } }])).toEqual(['DELETE FROM `app`.`items` WHERE `id` IS NULL LIMIT 1'])
  })

  it('creates tables with inline keys and options', () => {
    const [sql] = d.createTable(table({ options: { engine: 'InnoDB', comment: 'x' } }))
    expect(sql).toContain('`id` int NOT NULL AUTO_INCREMENT')
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).toContain("ENGINE=InnoDB COMMENT='x'")
  })

  it('alters tables: rename, add with position, drop', () => {
    const before = table()
    const after = table({
      columns: [before.columns[0], { ...before.columns[1], name: 'title' }, { name: 'qty', dataType: 'INT', fullType: 'int', nullable: true, defaultValue: '0' }]
    })
    const [sql] = d.alterTable(before, after)
    expect(sql).toContain('CHANGE COLUMN `name` `title` varchar(100) NOT NULL')
    expect(sql).toContain('ADD COLUMN `qty` int NULL DEFAULT 0 AFTER `title`')
    expect(d.alterTable(before, table())).toEqual([])
  })

  it('uses DROP CONSTRAINT for checks on MariaDB', () => {
    const m = new MariaDbDialect(110800)
    const before = table({ checks: [{ name: 'c1', expression: 'id > 0' }] })
    expect(m.alterTable(before, table())[0]).toContain('DROP CONSTRAINT `c1`')
    expect(m.dataTypes).toContain('UUID')
  })
})

describe('PostgreSQL dialect', () => {
  const d = new PgDialect(180000)

  it('quotes only when needed and casts bytea', () => {
    expect(d.quoteIdent('items')).toBe('items')
    expect(d.quoteIdent('Items')).toBe('"Items"')
    expect(d.quoteIdent('user')).toBe('"user"')
    expect(d.literal(new Uint8Array([0xde, 0xad]))).toBe(String.raw`'\xdead'::bytea`)
    expect(d.qualify({ schema: 'public', name: 'f', kind: 'function', args: 'integer' })).toBe('public.f(integer)')
  })

  it('alters columns with separate statements', () => {
    const before = table({ columns: [{ name: 'id', originalName: 'id', dataType: 'INT4', fullType: 'integer', nullable: false, identity: 'by_default' }] })
    const after = table({ columns: [{ ...before.columns[0], name: 'item_id', nullable: true, comment: 'pk' }] })
    expect(d.alterTable(before, after)).toEqual([
      'ALTER TABLE public.items RENAME COLUMN id TO item_id',
      'ALTER TABLE public.items ALTER COLUMN item_id DROP NOT NULL',
      "COMMENT ON COLUMN public.items.item_id IS 'pk'"
    ])
  })

  it('drops triggers with their table', () => {
    expect(d.dropObject({ schema: 'public', name: 'trg', kind: 'trigger', table: 'items' })).toBe('DROP TRIGGER trg ON public.items')
  })
})

describe('Firebird dialect', () => {
  it('uses FIRST/SKIP, ROWS 1 and DELETE for truncate', () => {
    const d = new FbDialect(50000)
    const ref = { name: 'ITEMS', kind: 'table' as const }
    expect(d.selectTableData({ ref, offset: 20, limit: 10 })).toBe('SELECT FIRST 10 SKIP 20 * FROM ITEMS')
    expect(d.rowChanges(ref, [{ kind: 'delete', key: { ID: 1 } }])).toEqual(['DELETE FROM ITEMS WHERE ID = 1 ROWS 1'])
    expect(d.truncateTable(ref)).toBe('DELETE FROM ITEMS')
    expect(d.quoteIdent('Mixed')).toBe('"Mixed"')
    expect(d.literal(true)).toBe('TRUE')
  })

  it('has no booleans before 3.0 and uses system tables for NOT NULL changes', () => {
    const d = new FbDialect(20509)
    expect(d.literal(true)).toBe('1')
    const before = table({ ref: { name: 'ITEMS', kind: 'table' }, columns: [{ name: 'NAME', originalName: 'NAME', dataType: 'VARCHAR', fullType: 'VARCHAR(10)', nullable: true }] })
    const after = table({ ref: { name: 'ITEMS', kind: 'table' }, columns: [{ ...before.columns[0], nullable: false }] })
    expect(d.alterTable(before, after)[0]).toContain('UPDATE RDB$RELATION_FIELDS SET RDB$NULL_FLAG = 1')
  })
})

describe('partitioning and bulk operations', () => {
  const my = new MySqlDialect(80400)
  const pg = new PgDialect(180000)
  const ranged = (bounds: [string, string][]): TableStructure['options'] => ({
    partitioning: { method: 'RANGE', expression: 'YEAR(created)', partitions: bounds.map(([name, bound]) => ({ name, bound })) }
  })

  it('creates MySQL partitioned tables', () => {
    const [sql] = my.createTable(table({ options: ranged([['p2024', 'LESS THAN (2025)'], ['pmax', 'LESS THAN MAXVALUE']]) }))
    expect(sql).toContain('PARTITION BY RANGE (YEAR(created))')
    expect(sql).toContain('PARTITION `p2024` VALUES LESS THAN (2025)')
    expect(sql).toContain('PARTITION `pmax` VALUES LESS THAN MAXVALUE')
    expect(my.createTable(table({ options: { partitioning: { method: 'HASH', expression: 'id', count: 4, partitions: [] } } }))[0]).toContain('PARTITION BY HASH (id) PARTITIONS 4')
  })

  it('alters MySQL partitions minimally', () => {
    const before = table({ options: ranged([['p1', 'LESS THAN (10)'], ['p2', 'LESS THAN (20)']]) })
    expect(my.alterTable(before, table({ options: ranged([['p1', 'LESS THAN (10)'], ['p2', 'LESS THAN (20)'], ['p3', 'LESS THAN (30)']]) }))).toEqual([
      'ALTER TABLE `app`.`items` ADD PARTITION (PARTITION `p3` VALUES LESS THAN (30))'
    ])
    expect(my.alterTable(before, table({ options: ranged([['p2', 'LESS THAN (20)']]) }))).toEqual(['ALTER TABLE `app`.`items` DROP PARTITION `p1`'])
    expect(my.alterTable(before, table())).toEqual(['ALTER TABLE `app`.`items` REMOVE PARTITIONING'])
    expect(my.alterTable(before, table({ options: ranged([['p1', 'LESS THAN (15)'], ['p2', 'LESS THAN (20)']]) }))[0]).toMatch(/^ALTER TABLE `app`.`items` PARTITION BY RANGE/)
  })

  it('creates PostgreSQL partitions as child tables and keeps the key fixed', () => {
    const t1 = table({ options: { partitioning: { method: 'LIST', expression: 'country', partitions: [{ name: 'items_br', bound: "IN ('br')" }, { name: 'items_other', bound: 'DEFAULT' }] } } })
    const sql = pg.createTable(t1)
    expect(sql[0]).toContain('PARTITION BY LIST (country)')
    expect(sql).toContain("CREATE TABLE public.items_br PARTITION OF public.items FOR VALUES IN ('br')")
    expect(sql).toContain('CREATE TABLE public.items_other PARTITION OF public.items DEFAULT')
    const t2 = structuredClone(t1)
    t2.options.partitioning!.partitions[0].bound = "IN ('br', 'pt')"
    expect(pg.alterTable(t1, t2)).toEqual([
      'ALTER TABLE public.items DETACH PARTITION public.items_br',
      "ALTER TABLE public.items ATTACH PARTITION public.items_br FOR VALUES IN ('br', 'pt')"
    ])
    const t3 = structuredClone(t1)
    t3.options.partitioning!.expression = 'region'
    expect(() => pg.alterTable(t1, t3)).toThrow(/partition key/)
  })

  it('generates bulk table statements', () => {
    const ref = { database: 'app', schema: 'public', name: 'items', kind: 'table' as const }
    expect(my.bulkAlter(ref, { engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4', convertData: true, moveTo: 'archive' })).toEqual([
      'ALTER TABLE `app`.`items` ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      'RENAME TABLE `app`.`items` TO `archive`.`items`'
    ])
    expect(pg.bulkAlter(ref, { owner: 'app', moveTo: 'archive' })).toEqual(['ALTER TABLE public.items OWNER TO app', 'ALTER TABLE public.items SET SCHEMA archive'])
    expect(new FbDialect(50000).bulkAlter()).toEqual([])
  })
})

describe('object utilities', () => {
  const fb25 = new FbDialect(20509)
  const fb5 = new FbDialect(50004)
  const pg = new PgDialect(180000)
  const my = new MySqlDialect(90700)
  const maria = new MariaDbDialect(110800)

  it('activates and deactivates triggers and events', () => {
    expect(fb5.setEnabled({ name: 'CLIENTES_AU0', kind: 'trigger' }, false)).toEqual(['ALTER TRIGGER CLIENTES_AU0 INACTIVE'])
    expect(fb5.setEnabled({ name: 'trg', kind: 'trigger' }, true)).toEqual(['ALTER TRIGGER "trg" ACTIVE'])
    expect(pg.setEnabled({ schema: 'public', name: 'audit', kind: 'trigger', table: 'Orders' }, false)).toEqual(['ALTER TABLE public."Orders" DISABLE TRIGGER audit'])
    expect(() => pg.setEnabled({ name: 'audit', kind: 'trigger' }, true)).toThrow()
    expect(my.setEnabled({ database: 'app', name: 'nightly', kind: 'event' }, false)).toEqual(['ALTER EVENT `app`.`nightly` DISABLE'])
    expect(my.setEnabled({ database: 'app', name: 'trg', kind: 'trigger' }, false)).toEqual([])
  })

  it('sets generator / sequence values and rejects anything but integers', () => {
    expect(fb25.setSequenceValue({ name: 'GEN_ID_CLIENTE', kind: 'sequence' }, '54')).toEqual(['SET GENERATOR GEN_ID_CLIENTE TO 54'])
    expect(pg.setSequenceValue({ schema: 'public', name: 'orders_id_seq', kind: 'sequence' }, '-1')).toEqual(["SELECT setval('public.orders_id_seq', -1)"])
    expect(maria.setSequenceValue({ database: 'app', name: 's', kind: 'sequence' }, '7')).toEqual(['SELECT SETVAL(`app`.`s`, 7)'])
    expect(() => fb5.setSequenceValue({ name: 'G', kind: 'sequence' }, '1; DROP TABLE X')).toThrow()
    expect(my.setSequenceValue({ name: 's', kind: 'sequence' }, '1')).toEqual([])
  })

  it('changes exception messages (Firebird only)', () => {
    expect(fb5.setExceptionMessage({ name: 'A001', kind: 'exception' }, "Retorno já importado!")).toEqual(["ALTER EXCEPTION A001 'Retorno já importado!'"])
    expect(fb5.setExceptionMessage({ name: 'A001', kind: 'exception' }, "it's")).toEqual(["ALTER EXCEPTION A001 'it''s'"])
    expect(pg.setExceptionMessage({ name: 'x', kind: 'exception' }, 'm')).toEqual([])
  })

  it('builds templates for new objects', () => {
    expect(fb5.createTemplate('trigger', { table: 'CLIENTES' })).toContain('CREATE OR ALTER TRIGGER CLIENTES_BI0 FOR CLIENTES')
    expect(fb25.createTemplate('sequence', {})).toContain('CREATE GENERATOR')
    expect(fb5.createTemplate('sequence', {})).toContain('CREATE SEQUENCE')
    expect(() => fb25.createTemplate('function', {})).toThrow()
    expect(pg.createTemplate('trigger', { schema: 'sales', table: 'orders' })).toContain('BEFORE INSERT OR UPDATE ON sales.orders')
    expect(my.createTemplate('trigger', { database: 'app', table: 'orders' })).toContain('BEFORE INSERT ON `app`.`orders`')
    expect(maria.createTemplate('sequence', { database: 'app' })).toContain('CREATE SEQUENCE `app`.`new_sequence`')
    expect(() => my.createTemplate('sequence', {})).toThrow()
  })
})

describe('trigger form statements', () => {
  const base = { name: 'ORDERS_BI', table: 'ORDERS', timing: 'BEFORE' as const, events: ['INSERT', 'UPDATE'] as ('INSERT' | 'UPDATE' | 'DELETE')[], position: 0, active: true, editable: true }
  const fbBody = 'AS\nBEGIN\n  IF (NEW.ID IS NULL) THEN NEW.ID = GEN_ID(GEN_ORDERS_ID, 1);\nEND'

  it('Firebird: CREATE OR ALTER, inactive, position, database triggers and renames', () => {
    const fb = new FbDialect(50004)
    expect(fb.triggerStatements(null, { ...base, body: fbBody })).toEqual([
      `CREATE OR ALTER TRIGGER ORDERS_BI FOR ORDERS\nACTIVE BEFORE INSERT OR UPDATE POSITION 0\n${fbBody}`
    ])
    const original = { ...base, body: fbBody }
    expect(fb.triggerStatements(original, { ...original, active: false, position: 3, events: ['DELETE', 'INSERT'], body: 'BEGIN END' })[0]).toBe(
      'CREATE OR ALTER TRIGGER ORDERS_BI FOR ORDERS\nINACTIVE BEFORE INSERT OR DELETE POSITION 3\nAS\nBEGIN END'
    )
    expect(fb.triggerStatements(original, { ...original, name: 'ORDERS_BI2' })).toEqual([
      'DROP TRIGGER ORDERS_BI',
      expect.stringContaining('CREATE OR ALTER TRIGGER ORDERS_BI2 FOR ORDERS')
    ])
    expect(fb.triggerStatements(null, { ...base, table: undefined, events: [], databaseEvent: 'CONNECT', body: 'AS BEGIN END' })[0]).toBe(
      'CREATE OR ALTER TRIGGER ORDERS_BI\nACTIVE ON CONNECT POSITION 0\nAS BEGIN END'
    )
    expect(() => fb.triggerStatements(null, { ...base, events: [], body: fbBody })).toThrow()
    expect(() => fb.triggerStatements(null, { ...base, name: ' ', body: fbBody })).toThrow()
  })

  it('PostgreSQL: function + CREATE OR REPLACE TRIGGER, rename, move and enable state', () => {
    const pg = new PgDialect(180000)
    const original = { ...base, name: 'audit', schema: 'public', table: 'orders', forEach: 'ROW' as const, functionName: 'audit_fn', body: 'BEGIN RETURN NEW; END;' }
    expect(pg.triggerStatements(null, { ...original, when: 'NEW.total > 0' })).toEqual([
      'CREATE OR REPLACE FUNCTION public.audit_fn()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $body$\nBEGIN RETURN NEW; END;\n$body$',
      'CREATE OR REPLACE TRIGGER audit\nBEFORE INSERT OR UPDATE ON public.orders\nFOR EACH ROW\nWHEN (NEW.total > 0)\nEXECUTE FUNCTION public.audit_fn()'
    ])
    const renamed = pg.triggerStatements(original, { ...original, name: 'audit2', active: false, body: "BEGIN RAISE NOTICE '$body$'; RETURN NEW; END;" })
    expect(renamed[0]).toContain('AS $body_$')
    expect(renamed).toContain('ALTER TRIGGER audit ON public.orders RENAME TO audit2')
    expect(renamed[renamed.length - 1]).toBe('ALTER TABLE public.orders DISABLE TRIGGER audit2')
    expect(pg.triggerStatements(original, { ...original, table: 'items' })).toContain('DROP TRIGGER audit ON public.orders')
    expect(pg.triggerStatements({ ...original, active: false }, original)).toContain('ALTER TABLE public.orders ENABLE TRIGGER audit')
  })

  it('MySQL drops and recreates; MariaDB uses CREATE OR REPLACE', () => {
    const t = { ...base, name: 'orders_bi', database: 'app', table: 'orders', events: ['INSERT'] as ('INSERT' | 'UPDATE' | 'DELETE')[], body: 'SET NEW.total = 0' }
    expect(new MySqlDialect(90700).triggerStatements(t, t)).toEqual([
      'DROP TRIGGER IF EXISTS `app`.`orders_bi`',
      'CREATE TRIGGER `app`.`orders_bi`\nBEFORE INSERT ON `app`.`orders`\nFOR EACH ROW\nSET NEW.total = 0'
    ])
    expect(new MariaDbDialect(110800).triggerStatements(t, t)).toEqual(['CREATE OR REPLACE TRIGGER `app`.`orders_bi`\nBEFORE INSERT ON `app`.`orders`\nFOR EACH ROW\nSET NEW.total = 0'])
    expect(() => new MySqlDialect(90700).triggerStatements(null, { ...t, events: ['INSERT', 'UPDATE'] })).toThrow()
  })
})

describe('large objects loaded on demand', () => {
  it('classifies LOB columns per engine', () => {
    expect(lobKind('firebird', { dataType: 'BLOB', fullType: 'BLOB SUB_TYPE TEXT SEGMENT SIZE 16384' })).toBe('text')
    expect(lobKind('firebird', { dataType: 'BLOB', fullType: 'BLOB SUB_TYPE BINARY' })).toBe('binary')
    expect(lobKind('firebird', { dataType: 'VARCHAR', fullType: 'VARCHAR(100)' })).toBeNull()
    expect(lobKind('mysql', { dataType: 'LONGBLOB', fullType: 'longblob' })).toBe('binary')
    expect(lobKind('mariadb', { dataType: 'MEDIUMTEXT', fullType: 'mediumtext' })).toBe('text')
    expect(lobKind('mysql', { dataType: 'TINYTEXT', fullType: 'tinytext' })).toBeNull()
    expect(lobKind('postgres', { dataType: 'BYTEA', fullType: 'bytea' })).toBe('binary')
    expect(lobKind('postgres', { dataType: 'TEXT', fullType: 'text' })).toBeNull()
    expect(lobKind('sqlite', { dataType: 'BLOB', fullType: 'BLOB' })).toBeNull()
  })

  it('selects previews and sizes instead of the values, and single values by key', () => {
    const fb = new FbDialect(20500)
    const ref = { name: 'DOCS', kind: 'table' as const }
    const lazy = [
      { column: 'NOTES', kind: 'text' as const },
      { column: 'PHOTO', kind: 'binary' as const }
    ]
    expect(fb.selectTableData({ ref, offset: 0, limit: 100, columns: ['ID', 'NOTES', 'PHOTO'], lazy })).toBe(
      'SELECT FIRST 100 SKIP 0 ID, CASE WHEN CHAR_LENGTH(NOTES) > 256 THEN CAST(SUBSTRING(NOTES FROM 1 FOR 256) AS VARCHAR(256)) || ASCII_CHAR(1) ELSE CAST(NOTES AS VARCHAR(256)) END AS NOTES, OCTET_LENGTH(PHOTO) AS PHOTO FROM DOCS'
    )
    expect(fb.selectByKey(ref, ['PHOTO'], { ID: 7 })).toBe('SELECT PHOTO FROM DOCS WHERE ID = 7')
    const my = new MySqlDialect(80400)
    expect(my.selectTableData({ ref: table().ref, offset: 0, limit: 5, columns: ['id', 'name'], lazy: [{ column: 'name', kind: 'text' }] })).toBe(
      'SELECT `id`, CASE WHEN CHAR_LENGTH(`name`) > 256 THEN CONCAT(LEFT(`name`, 256), CHAR(1 USING utf8mb4)) ELSE `name` END AS `name` FROM `app`.`items` LIMIT 5 OFFSET 0'
    )
    const pg = new PgDialect(170000)
    expect(pg.selectTableData({ ref: table().ref, offset: 0, limit: 5, columns: ['id', 'name'], lazy: [{ column: 'name', kind: 'binary' }] })).toBe(
      'SELECT id, OCTET_LENGTH(name) AS name FROM public.items LIMIT 5 OFFSET 0'
    )
  })
})
