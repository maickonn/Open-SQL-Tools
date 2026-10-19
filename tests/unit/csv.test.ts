import { describe, expect, it } from 'vitest'
import { parseCsv } from '@application/import/csv'
import { columnLetter } from '@application/export/formatters'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\n"multi\nline",2')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['multi\nline', '2']
    ])
  })
  it('supports other delimiters and a BOM', () => {
    expect(parseCsv('\ufeffa;b\n1;', ';')).toEqual([['a', 'b'], ['1', '']])
  })
})

describe('columnLetter', () => {
  it('maps indexes to spreadsheet columns', () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
  })
})
