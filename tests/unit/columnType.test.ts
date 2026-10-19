import { describe, expect, it } from 'vitest'
import { joinType, splitType } from '@domain/sql/columnType'

describe('splitType', () => {
  it.each([
    ['INTEGER', { base: 'INTEGER', args: '', suffix: '' }],
    ['VARCHAR(50)', { base: 'VARCHAR', args: '50', suffix: '' }],
    ['decimal(10, 2) unsigned', { base: 'decimal', args: '10, 2', suffix: 'unsigned' }],
    ['int unsigned zerofill', { base: 'int', args: '', suffix: 'unsigned zerofill' }],
    ['double precision', { base: 'double precision', args: '', suffix: '' }],
    ['character varying(255)', { base: 'character varying', args: '255', suffix: '' }],
    ['timestamp(3) with time zone', { base: 'timestamp', args: '3', suffix: 'with time zone' }],
    ['timestamp without time zone', { base: 'timestamp without time zone', args: '', suffix: '' }],
    ['integer[]', { base: 'integer[]', args: '', suffix: '' }],
    ["enum('a','b')", { base: 'enum', args: "'a','b'", suffix: '' }]
  ])('%s', (input, expected) => {
    expect(splitType(input)).toEqual(expected)
    expect(joinType(expected.base, expected.args, expected.suffix).replace(/\s+/g, '')).toBe(input.replace(/\s+/g, ''))
  })
})
