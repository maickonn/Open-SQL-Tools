import { describe, expect, it } from 'vitest'
import type { TableStructure, TriggerDef } from '@shared/model'
import { splitSql } from '@domain/sql/splitter'
import { classifyStatement } from '@domain/sql/classifier'
import { parseSqliteTrigger, unquoteSqliteIdent } from '@domain/sql/sqliteTrigger'
import { parseSqliteTable } from '@domain/sql/sqliteTable'
import { capabilitiesFor, encodeVersion } from '@domain/serverVersion'
import { canRename, canToggle, creatableKinds, triggerCapabilities } from '@domain/objectCapabilities'
import { hasTransactionalDdl, isFileBased, isSingleDatabase } from '@domain/engineTraits'
import { SqliteDialect } from '@infrastructure/db/sqlite/sqliteDialect'
import { sqliteCategory } from '@infrastructure/db/sqlite/sqliteConnection'

const d = new SqliteDialect(encodeVersion(3, 53, 1))

const table = (over: Partial<TableStructure> = {}): TableStructure => ({
  ref: { name: 'items', kind: 'table' },
  columns: [
    { name: 'id', originalName: 'id', dataType: 'INTEGER', fullType: 'INTEGER', nullable: true, autoIncrement: true },
    { name: 'name', originalName: 'name', dataType: 'TEXT', fullType: 'TEXT', nullable: false, defaultValue: "'x'" }
  ],
  indexes: [{ name: 'PRIMARY', type: 'PRIMARY', columns: ['id'], constraint: true }],
  foreignKeys: [],
  checks: [],
  options: {},
  ...over
})

describe('SQLite splitting and classification', () => {
  it('keeps trigger bodies together and understands bracket identifiers', () => {
    const script = `CREATE TABLE [a;b] (x);
CREATE TEMP TRIGGER t AFTER INSERT ON "a;b" BEGIN
  UPDATE x SET v = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END;
  INSERT INTO log VALUES ('a;b');
END;
SELECT \`c;d\` FROM t;`
    expect(splitSql(script, 'sqlite').map((s) => s.sql.split('\n')[0])).toEqual(['CREATE TABLE [a;b] (x)', 'CREATE TEMP TRIGGER t AFTER INSERT ON "a;b" BEGIN', 'SELECT `c;d` FROM t'])
  })

  it('treats a plain BEGIN as a transaction statement', () => {
    expect(splitSql('BEGIN; INSERT INTO t VALUES (1); COMMIT;', 'sqlite').map((s) => s.sql)).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)', 'COMMIT'])
  })

  it('classifies PRAGMA, ATTACH and maintenance statements', () => {
    expect(classifyStatement('PRAGMA table_info(t)')).toBe('read')
    expect(classifyStatement('PRAGMA journal_mode')).toBe('read')
    expect(classifyStatement('PRAGMA main.integrity_check')).toBe('read')
    expect(classifyStatement('PRAGMA foreign_keys = OFF')).toBe('session')
    expect(classifyStatement('PRAGMA user_version = 3')).toBe('write')
    expect(classifyStatement('PRAGMA optimize')).toBe('write')
    expect(classifyStatement("ATTACH DATABASE 'x.db' AS x")).toBe('session')
    expect(classifyStatement('VACUUM')).toBe('write')
  })
})

describe('SQLite catalog parsing', () => {
  it('parses triggers stored in sqlite_schema', () => {
    expect(parseSqliteTrigger('CREATE TRIGGER "t-1" BEFORE UPDATE OF a, b ON [items] FOR EACH ROW WHEN NEW.a > 0 BEGIN SELECT 1; END')).toEqual({
      name: 't-1',
      table: 'items',
      timing: 'BEFORE',
      event: 'UPDATE',
      updateOf: 'a, b',
      when: 'NEW.a > 0',
      body: 'BEGIN SELECT 1; END'
    })
    expect(parseSqliteTrigger('CREATE TRIGGER IF NOT EXISTS main.v_ins INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (NEW.x); END')).toMatchObject({ timing: 'INSTEAD OF', event: 'INSERT', table: 'v' })
    // Timing defaults to BEFORE when omitted.
    expect(parseSqliteTrigger("CREATE TRIGGER x DELETE ON t BEGIN SELECT 'BEGIN'; END")).toMatchObject({ timing: 'BEFORE', event: 'DELETE', body: "BEGIN SELECT 'BEGIN'; END" })
    expect(parseSqliteTrigger('CREATE VIEW v AS SELECT 1')).toBeNull()
    expect(unquoteSqliteIdent('`a``b`')).toBe('a`b')
  })

  it('reads what the table pragmas leave out', () => {
    const details = parseSqliteTable(`CREATE TABLE "t" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT COLLATE NOCASE CHECK (length(name) > 0),
      total REAL GENERATED ALWAYS AS (price * qty) STORED,
      half AS (total / 2),
      CONSTRAINT positive CHECK (total >= 0),
      FOREIGN KEY (id) REFERENCES other (id)
    ) WITHOUT ROWID, STRICT`)
    expect(details.columns.get('id')?.autoIncrement).toBe(true)
    expect(details.columns.get('name')?.collation).toBe('NOCASE')
    expect(details.columns.get('total')?.generated).toEqual({ expression: 'price * qty', stored: true })
    expect(details.columns.get('half')?.generated).toEqual({ expression: 'total / 2', stored: false })
    expect(details.checks).toEqual([
      { name: '', expression: 'length(name) > 0' },
      { name: 'positive', expression: 'total >= 0' }
    ])
    expect(details.withoutRowid).toBe(true)
    expect(details.strict).toBe(true)
  })
})

describe('SQLite capabilities', () => {
  it('follows the SQLite version and engine traits', () => {
    expect(capabilitiesFor('sqlite', encodeVersion(3, 24))).not.toContain('windowFunctions')
    expect(capabilitiesFor('sqlite', encodeVersion(3, 35))).toEqual(expect.arrayContaining(['windowFunctions', 'generatedColumns', 'returning', 'partialIndexes']))
    expect(canRename('sqlite', 'table')).toBe(true)
    expect(canRename('sqlite', 'view')).toBe(false)
    expect(canToggle('sqlite', 'trigger')).toBe(false)
    expect(creatableKinds('sqlite')).toEqual(['table', 'view', 'trigger'])
    expect(triggerCapabilities('sqlite')).toMatchObject({ multipleEvents: false, when: true, active: false, position: 'none' })
    expect(isSingleDatabase('sqlite') && isFileBased('sqlite') && hasTransactionalDdl('sqlite')).toBe(true)
    expect(isFileBased('firebird')).toBe(false)
  })

  it('maps declared types to grid categories by affinity', () => {
    expect(sqliteCategory('BIGINT')).toBe('integer')
    expect(sqliteCategory('VARCHAR(10)')).toBe('string')
    expect(sqliteCategory('TEXT')).toBe('text')
    expect(sqliteCategory('DOUBLE PRECISION')).toBe('float')
    expect(sqliteCategory('DECIMAL(10,2)')).toBe('decimal')
    expect(sqliteCategory('DATETIME')).toBe('datetime')
    expect(sqliteCategory(null, 1.5)).toBe('float')
    expect(sqliteCategory(null, new Uint8Array())).toBe('binary')
  })
})

describe('SQLite dialect', () => {
  it('creates tables with inline AUTOINCREMENT keys and table options', () => {
    const [create] = d.createTable(table({ checks: [{ name: 'check_1', expression: 'length(name) > 0' }], sqliteOptions: { strict: true } }))
    expect(create).toBe(`CREATE TABLE "items" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL DEFAULT 'x',
  CHECK (length(name) > 0)
) STRICT`)
    expect(d.literal(new Uint8Array([0xca, 0xfe]))).toBe("X'cafe'")
    expect(d.selectTableData({ ref: { name: 'items', kind: 'table' }, offset: 10, limit: 5 })).toBe('SELECT * FROM "items" LIMIT 5 OFFSET 10')
  })

  it('wraps non-literal defaults in parentheses', () => {
    const t = table()
    t.columns.push({ name: 'at', dataType: 'TEXT', fullType: 'TEXT', nullable: true, defaultValue: "datetime('now')" })
    expect(d.createTable(t)[0]).toContain(`"at" TEXT DEFAULT (datetime('now'))`)
  })

  it('alters in place when SQLite supports the change', () => {
    const original = table()
    const target = structuredClone(original)
    target.columns[1] = { ...target.columns[1], name: 'title' }
    target.columns.push({ name: 'qty', dataType: 'INTEGER', fullType: 'INTEGER', nullable: true })
    target.ref = { ...target.ref, name: 'things' }
    expect(d.alterTable(original, target)).toEqual([
      'ALTER TABLE "items" RENAME COLUMN "name" TO "title"',
      'ALTER TABLE "items" ADD COLUMN "qty" INTEGER',
      'ALTER TABLE "items" RENAME TO "things"'
    ])
  })

  it('rebuilds the table for changes ALTER TABLE cannot make', () => {
    const original = table({
      dependents: [
        { kind: 'trigger', name: 'items_ai', sql: 'CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN SELECT 1; END' },
        { kind: 'view', name: 'item_names', sql: 'CREATE VIEW item_names AS SELECT name FROM items' }
      ],
      indexes: [
        { name: 'PRIMARY', type: 'PRIMARY', columns: ['id'], constraint: true },
        { name: 'items_name', type: 'INDEX', columns: ['name'] }
      ]
    })
    const target = structuredClone(original)
    target.columns[1] = { ...target.columns[1], nullable: true }
    const out = d.alterTable(original, target)
    expect(out[0]).toBe('PRAGMA foreign_keys = OFF')
    expect(out[1]).toBe('DROP VIEW "item_names"')
    expect(out[2]).toMatch(/^CREATE TABLE "_ost_new_items" \(/)
    expect(out.slice(3, 9)).toEqual([
      'INSERT INTO "_ost_new_items" ("id", "name")\nSELECT "id", "name" FROM "items"',
      'DROP TABLE "items"',
      'ALTER TABLE "_ost_new_items" RENAME TO "items"',
      'CREATE INDEX "items_name" ON "items" ("name")',
      'CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN SELECT 1; END',
      'CREATE VIEW item_names AS SELECT name FROM items'
    ])
    expect(out.at(-2)).toBe('DROP TABLE temp."_ost_fk_check"')
    expect(out.at(-1)).toBe('PRAGMA foreign_keys = ON')
  })

  it('maps maintenance actions and refuses what SQLite lacks', () => {
    const ref = { name: 'items', kind: 'table' as const }
    expect(d.maintenance(ref, 'vacuum')).toEqual(['VACUUM'])
    expect(d.maintenance(ref, 'check')).toEqual(['PRAGMA integrity_check("items")'])
    expect(d.maintenance(ref, 'repair')).toEqual(['REINDEX "items"'])
    expect(d.truncateTable(ref)).toBe('DELETE FROM "items"')
    expect(() => d.renameObject({ name: 'v', kind: 'view' }, 'w')).toThrow()
    expect(() => d.userStatements()).toThrow()
  })

  it('writes trigger statements from the form', () => {
    const target: TriggerDef = { name: 'items_bu', table: 'items', timing: 'BEFORE', events: ['UPDATE'], active: true, when: 'NEW.name <> OLD.name', body: 'SELECT 1;', editable: true }
    expect(d.triggerStatements(null, target)).toEqual(['CREATE TRIGGER "items_bu"\nBEFORE UPDATE ON "items"\nFOR EACH ROW\nWHEN NEW.name <> OLD.name\nBEGIN\nSELECT 1;\nEND'])
    const [drop] = d.triggerStatements({ ...target, name: 'old_name' }, target)
    expect(drop).toBe('DROP TRIGGER "old_name"')
    expect(() => d.triggerStatements(null, { ...target, events: ['INSERT', 'UPDATE'] })).toThrow(/exactly one event/)
  })
})
