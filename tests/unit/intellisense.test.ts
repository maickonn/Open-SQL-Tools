import { describe, expect, it } from 'vitest'
import { analyzeStatement, diagnose, functionsFor, keywordsFor, tokenize, type CatalogLookup } from '@domain/sql/intellisense'

/** Analyzes `sql` with the cursor at the `|` marker. */
const at = (sql: string, engine: Parameters<typeof analyzeStatement>[2] = 'postgres') => analyzeStatement(sql.replace('|', ''), sql.indexOf('|'), engine)

describe('tokenize', () => {
  it('reads strings, comments and quoted names per dialect', () => {
    const kinds = (sql: string, engine: Parameters<typeof tokenize>[1]) => tokenize(sql, engine).map((t) => `${t.kind}:${t.value ?? t.text}`)
    expect(kinds(`SELECT "a b", 'x''y' -- c`, 'postgres')).toEqual(['word:SELECT', 'quoted:a b', 'punct:,', "string:'x''y'", 'comment:-- c'])
    expect(kinds("SELECT `t`.c, \"s\" # c", 'mysql')).toEqual(['word:SELECT', 'quoted:t', 'punct:.', 'word:c', 'punct:,', 'string:"s"', 'comment:# c'])
    expect(kinds('SELECT [my col] FROM t', 'sqlite')).toContain('quoted:my col')
    expect(kinds('SELECT $$a;b$$, $1, x::int', 'postgres')).toEqual(['word:SELECT', 'string:$$a;b$$', 'punct:,', 'param:$1', 'punct:,', 'word:x', 'punct:::', 'word:int'])
    expect(tokenize("SELECT 'open", 'postgres').at(-1)).toMatchObject({ kind: 'string', open: true })
  })
})

describe('analyzeStatement', () => {
  it('expects tables after FROM, JOIN, INTO and UPDATE', () => {
    expect(at('SELECT * FROM |').cursor).toEqual({ kind: 'table' })
    expect(at('SELECT * FROM a JOIN |').cursor).toEqual({ kind: 'table' })
    expect(at('SELECT * FROM a, |').cursor).toEqual({ kind: 'table' })
    expect(at('INSERT INTO |').cursor).toEqual({ kind: 'table' })
    expect(at('UPDATE |').cursor).toEqual({ kind: 'table' })
    expect(at('SELECT * FROM public.|').cursor).toEqual({ kind: 'table', schema: 'public' })
    expect(at('SELECT * FROM us|').prefix).toBe('us')
  })

  it('expects keywords after a complete table reference', () => {
    expect(at('SELECT * FROM users u |').cursor).toEqual({ kind: 'keyword' })
    expect(at('|').cursor).toEqual({ kind: 'keyword' })
  })

  it('expects columns in expression clauses with the statement sources', () => {
    const a = at('SELECT | FROM users u JOIN orders o ON o.user_id = u.id')
    expect(a.cursor.kind).toBe('column')
    expect(a.sources.map((s) => [s.name, s.alias])).toEqual([
      ['users', 'u'],
      ['orders', 'o']
    ])
    expect(at('SELECT * FROM users WHERE |').cursor.kind).toBe('column')
    expect(at('SELECT * FROM t ORDER BY |').cursor.kind).toBe('column')
    expect(at('UPDATE users SET |').cursor.kind).toBe('column')
    expect(at('INSERT INTO users (|').cursor.kind).toBe('column')
  })

  it('resolves the qualifier before the dot (the old regex took FROM as an alias)', () => {
    expect(at('SELECT u.| FROM users u').cursor).toMatchObject({ kind: 'column', qualifier: 'u' })
    expect(at('SELECT * FROM users WHERE users.|').cursor).toMatchObject({ kind: 'column', qualifier: 'users' })
    expect(at('SELECT s.t.| FROM s.t').cursor).toMatchObject({ kind: 'column', qualifier: 't', schema: 's' })
  })

  it('reads schema-qualified tables, quoted names, CTEs and derived tables', () => {
    const a = at('WITH recent (id, total) AS (SELECT 1, 2) SELECT | FROM sales.orders AS o, recent r, (SELECT a, b AS bb FROM x) d')
    expect(a.sources.map((s) => ({ kind: s.kind, schema: s.schema, name: s.name, alias: s.alias, columns: s.columns }))).toEqual([
      { kind: 'cte', schema: undefined, name: 'recent', alias: undefined, columns: ['id', 'total'] },
      { kind: 'table', schema: 'sales', name: 'orders', alias: 'o', columns: undefined },
      { kind: 'cte', schema: undefined, name: 'recent', alias: 'r', columns: ['id', 'total'] },
      { kind: 'subquery', schema: undefined, name: 'd', alias: 'd', columns: ['a', 'bb'] },
      { kind: 'table', schema: undefined, name: 'x', alias: undefined, columns: undefined }
    ])
    expect(at('SELECT | FROM "Order Items" oi', 'postgres').sources[0]).toMatchObject({ name: 'Order Items', alias: 'oi' })
  })

  it('isolates the statement under the cursor', () => {
    const sql = 'SELECT * FROM a x;\nSELECT x.| FROM b x'
    expect(at(sql).sources.map((s) => s.name)).toEqual(['b'])
    expect(at('SELECT 1;\n|').cursor).toEqual({ kind: 'keyword' })
  })

  it('stays quiet inside strings and comments', () => {
    expect(at("SELECT 'FROM |'").cursor).toEqual({ kind: 'none' })
    expect(at('SELECT 1 -- FROM |').cursor).toEqual({ kind: 'none' })
  })

  it('finds the function call and argument under the cursor', () => {
    expect(at('SELECT coalesce(a, |').call).toEqual({ name: 'coalesce', qualifier: undefined, argIndex: 1 })
    expect(at('SELECT round(sum(x), |) FROM t').call).toMatchObject({ name: 'round', argIndex: 1 })
    expect(at('SELECT * FROM t WHERE id IN (|').call).toBeUndefined()
    expect(at('SELECT public.fn(1, 2, |').call).toEqual({ name: 'fn', qualifier: 'public', argIndex: 2 })
  })

  it('handles the Firebird and MySQL dialects', () => {
    expect(at('SELECT FIRST 10 * FROM CLIENTES C WHERE C.|', 'firebird').cursor).toMatchObject({ kind: 'column', qualifier: 'C' })
    expect(at('SELECT * FROM `db`.`t` WHERE |', 'mysql').sources[0]).toMatchObject({ schema: 'db', name: 't' })
  })
})

describe('diagnose', () => {
  const catalog: CatalogLookup = {
    table: (_schema, name) => (name.toUpperCase() === 'USERS' ? { columns: ['id', 'name'] } : name.toUpperCase() === 'PENDING' ? undefined : null)
  }

  it('flags unknown tables and alias columns', () => {
    const sql = 'SELECT u.id, u.nope FROM users u JOIN missing m ON m.x = u.id'
    const d = diagnose(sql, 'postgres', catalog)
    expect(d.map((x) => [x.code, x.name, sql.slice(x.start, x.end)])).toEqual([
      ['unknownTable', 'missing', 'missing'],
      ['unknownColumn', 'nope', 'nope']
    ])
  })

  it('does not guess', () => {
    expect(diagnose('SELECT p.anything FROM pending p', 'postgres', catalog)).toEqual([])
    expect(diagnose('WITH c AS (SELECT 1 AS a) SELECT c.a FROM c', 'postgres', catalog)).toEqual([])
    expect(diagnose('CREATE VIEW v AS SELECT * FROM missing', 'postgres', catalog)).toEqual([])
    expect(diagnose('SELECT g.x FROM generate_series(1, 3) g', 'postgres', catalog)).toEqual([])
    expect(diagnose('WITH c AS (SELECT 1 AS a) SELECT * FROM (SELECT * FROM c) d', 'postgres', catalog)).toEqual([])
    expect(diagnose('SELECT u.* , public.fn(u.id) FROM users u', 'postgres', catalog)).toEqual([])
  })
})

describe('dialect catalogs', () => {
  it('has per-engine keywords and functions with signatures', () => {
    expect(keywordsFor('firebird')).toContain('RECREATE')
    expect(keywordsFor('mysql')).not.toContain('RECREATE')
    expect(functionsFor('firebird').get('IIF')?.params).toEqual(['condition', 'then', 'else'])
    expect(functionsFor('postgres').get('COALESCE')?.params).toEqual(['value', '...'])
    expect(functionsFor('mariadb').get('DATE_FORMAT')).toBeDefined()
  })
})
