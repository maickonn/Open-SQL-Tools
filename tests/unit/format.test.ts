import { describe, expect, it } from 'vitest'
import { formatSql } from '@domain/sql/format'

const fallback = (sql: string): string => `-- fallback\n${sql}`
const fmt = (sql: string, engine: Parameters<typeof formatSql>[1] = 'postgres') => formatSql(sql, engine, fallback)

const STYLE = `WITH active_customers AS (
    SELECT
        customer_id,
        customer_name,
        email
    FROM customers
    WHERE status = 'ACTIVE'
),

customer_orders AS (
    SELECT
        o.customer_id,
        COUNT(*) AS total_orders,
        SUM(o.total_amount) AS total_spent,
        MAX(o.created_at) AS last_order_at
    FROM orders AS o
    INNER JOIN active_customers AS c
        ON c.customer_id = o.customer_id
    WHERE o.created_at >= DATE '2026-01-01'
    GROUP BY
        o.customer_id
)

SELECT
    c.customer_id,
    c.customer_name,
    c.email,
    COALESCE(o.total_orders, 0) AS total_orders,
    COALESCE(o.total_spent, 0) AS total_spent,
    o.last_order_at
FROM active_customers AS c
LEFT JOIN customer_orders AS o
    ON o.customer_id = c.customer_id
ORDER BY
    total_spent DESC,
    c.customer_name ASC;`

describe('formatSql', () => {
  it('reproduces the house style from a one-line query', () => {
    const oneLine = STYLE.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').toLowerCase().replace("'active'", "'ACTIVE'")
    expect(fmt(oneLine)).toBe(STYLE)
  })

  it('is stable on already formatted SQL', () => {
    expect(fmt(STYLE)).toBe(STYLE)
  })

  it('breaks AND/OR conditions but not BETWEEN', () => {
    expect(fmt('select a from t where x between 1 and 2 and y = 3 or z is null')).toBe(
      'SELECT\n    a\nFROM t\nWHERE x BETWEEN 1 AND 2\n    AND y = 3\n    OR z IS NULL'
    )
    expect(fmt('select * from a join b on b.id = a.id and b.k = 1')).toBe('SELECT *\nFROM a\nJOIN b\n    ON b.id = a.id\n        AND b.k = 1')
  })

  it('lays out subqueries, CASE and set operations', () => {
    expect(fmt("select id, case when x > 1 then 'a' else 'b' end as k from t where id in (select id from u) union all select 1, 'c'")).toBe(
      [
        'SELECT',
        '    id,',
        '    CASE',
        "        WHEN x > 1 THEN 'a'",
        "        ELSE 'b'",
        '    END AS k',
        'FROM t',
        'WHERE id IN (',
        '    SELECT',
        '        id',
        '    FROM u',
        ')',
        '',
        'UNION ALL',
        '',
        'SELECT',
        '    1,',
        "    'c'"
      ].join('\n')
    )
  })

  it('formats DML', () => {
    expect(fmt("insert into t (a, b) values (1, 'x'), (2, 'y');")).toBe("INSERT INTO t (a, b)\nVALUES\n    (1, 'x'),\n    (2, 'y');")
    expect(fmt('update t set a = 1, b = b + 1 where id >= 10')).toBe('UPDATE t\nSET\n    a = 1,\n    b = b + 1\nWHERE id >= 10')
    expect(fmt('delete from t where id <> 1')).toBe('DELETE FROM t\nWHERE id <> 1')
  })

  it('keeps identifiers, comments, operators and engine syntax', () => {
    expect(fmt('select first 10 skip 5 "Name", t.status from "My Table" t -- note\nwhere t.x::int > 0', 'firebird')).toBe(
      'SELECT FIRST 10 SKIP 5\n    "Name",\n    t.status\nFROM "My Table" t -- note\nWHERE t.x::INT > 0'
    )
    expect(fmt('select count(distinct a) over (partition by b order by c) from t limit 5 offset 10')).toBe(
      'SELECT\n    COUNT(DISTINCT a) OVER (PARTITION BY b ORDER BY c)\nFROM t\nLIMIT 5\nOFFSET 10'
    )
  })

  it('separates statements and hands DDL to the fallback', () => {
    expect(fmt('select 1; create table t (id int);')).toBe('SELECT\n    1;\n\n-- fallback\ncreate table t (id int);')
  })
})
