import { describe, expect, it } from 'vitest'
import { classifyStatement, isDangerousStatement } from '@domain/sql/classifier'

describe('classifyStatement', () => {
  it.each([
    ['select * from t', 'read'],
    ['  -- c\n SELECT 1', 'read'],
    ['with x as (select 1) select * from x', 'read'],
    ['show tables', 'read'],
    ['explain select 1', 'read'],
    ["select 'delete from x'", 'read'],
    ['select * from t for update', 'write'],
    ['with d as (delete from t returning *) select * from d', 'write'],
    ['explain analyze delete from t', 'write'],
    ['select * into t2 from t', 'write'],
    ['insert into t values (1)', 'write'],
    ['update t set a = 1', 'write'],
    ['call p()', 'write'],
    ['create table t (a int)', 'ddl'],
    ['drop table t', 'ddl'],
    ['begin', 'transaction'],
    ['commit', 'transaction'],
    ['use db', 'session'],
    ['set names utf8mb4', 'session'],
    ['set global max_connections = 10', 'write'],
    ['frobnicate', 'unknown']
  ])('%s → %s', (sql, kind) => {
    expect(classifyStatement(sql)).toBe(kind)
  })
})

describe('isDangerousStatement', () => {
  it.each([
    ['drop table t', true],
    ['truncate table t', true],
    ['delete from t', true],
    ['delete from t where id = 1', false],
    ['update t set a = 1', true],
    ["update t set a = 'where'", true],
    ['update t set a = 1 where id = 2', false],
    ['select * from t', false]
  ])('%s → %s', (sql, expected) => {
    expect(isDangerousStatement(sql)).toBe(expected)
  })
})
