import { describe, expect, it } from 'vitest'
import { legacyLiteralColumns, legacyLiteralTables, rewriteLegacyLiterals, type ColumnsOf, type LiteralEncodings } from '@domain/sql/legacyLiterals'

const columns: ColumnsOf = (table) =>
  ({
    TIPOS: [
      { name: 'ID', none: false },
      { name: 'TIPO', none: true },
      { name: 'NOME', none: true },
      { name: 'OBS', none: false }
    ],
    CLIENTES: [
      { name: 'ID', none: false },
      { name: 'NOME', none: true }
    ]
  })[table.toUpperCase()]

const cp1252: LiteralEncodings = { match: ['utf8', 'windows-1252'], write: 'windows-1252' }
const hex = (b: Uint8Array): string => `x'${Buffer.from(b).toString('hex').toUpperCase()}'`
const rewrite = (sql: string, enc: LiteralEncodings = cp1252): string => rewriteLegacyLiterals(sql, 'firebird', columns, () => enc, hex)
/** 'ção' in Windows-1252. */
const CAO = "x'E7E36F'"

describe('NONE text literals', () => {
  it('matches comparisons in every encoding the column holds', () => {
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO = 'ção'")).toBe(`SELECT * FROM TIPOS WHERE TIPO IN ('ção', ${CAO})`)
    expect(rewrite("SELECT * FROM TIPOS t WHERE t.TIPO <> 'ção' AND ID = 1")).toBe(`SELECT * FROM TIPOS t WHERE t.TIPO NOT IN ('ção', ${CAO}) AND ID = 1`)
    expect(rewrite("select * from tipos where 'ção' = tipo")).toBe(`select * from tipos where tipo IN ('ção', ${CAO})`)
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO NOT IN ('ção', 'abc')")).toBe(`SELECT * FROM TIPOS WHERE TIPO NOT IN ('ção', ${CAO}, 'abc')`)
  })

  it('expands patterns, keeping ESCAPE and negation', () => {
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO LIKE '%ção%'")).toBe(`SELECT * FROM TIPOS WHERE (TIPO LIKE '%ção%' OR TIPO LIKE x'25E7E36F25')`)
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO NOT CONTAINING 'ção'")).toBe(`SELECT * FROM TIPOS WHERE (TIPO NOT CONTAINING 'ção' AND TIPO NOT CONTAINING ${CAO})`)
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO STARTING WITH 'ção'")).toBe(`SELECT * FROM TIPOS WHERE (TIPO STARTING WITH 'ção' OR TIPO STARTING WITH ${CAO})`)
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO LIKE 'ção!%' ESCAPE '!'")).toBe(`SELECT * FROM TIPOS WHERE (TIPO LIKE 'ção!%' ESCAPE '!' OR TIPO LIKE x'E7E36F2125' ESCAPE '!')`)
  })

  it('writes assignments in the column encoding', () => {
    expect(rewrite("UPDATE TIPOS SET TIPO = 'ção', OBS = 'ção' WHERE NOME = 'ção'")).toBe(`UPDATE TIPOS SET TIPO = ${CAO}, OBS = 'ção' WHERE NOME IN ('ção', ${CAO})`)
    expect(rewrite("INSERT INTO TIPOS (ID, TIPO, OBS) VALUES (1, 'ção', 'ção')")).toBe(`INSERT INTO TIPOS (ID, TIPO, OBS) VALUES (1, ${CAO}, 'ção')`)
    expect(rewrite("UPDATE TIPOS SET TIPO = 'ção'", { match: ['utf8'], write: 'utf8' })).toBe("UPDATE TIPOS SET TIPO = 'ção'")
    expect(() => rewrite("UPDATE TIPOS SET TIPO = 'Привет'")).toThrow(/windows-1252/)
  })

  it('resolves aliases and leaves ambiguous, declared-charset and unrelated text alone', () => {
    expect(rewrite("SELECT * FROM TIPOS t JOIN CLIENTES c ON c.ID = t.ID WHERE c.NOME = 'ção'")).toBe(`SELECT * FROM TIPOS t JOIN CLIENTES c ON c.ID = t.ID WHERE c.NOME IN ('ção', ${CAO})`)
    // NOME is in both tables: an unqualified reference is ambiguous.
    const ambiguous = "SELECT * FROM TIPOS t JOIN CLIENTES c ON c.ID = t.ID WHERE NOME = 'ção'"
    expect(rewrite(ambiguous)).toBe(ambiguous)
    const declared = "SELECT * FROM TIPOS WHERE OBS = 'ção'"
    expect(rewrite(declared)).toBe(declared)
    const ascii = "SELECT * FROM TIPOS WHERE TIPO = 'abc' -- ção"
    expect(rewrite(ascii)).toBe(ascii)
    const quotedInString = "SELECT 'it''s ção' FROM TIPOS"
    expect(rewrite(quotedInString)).toBe(quotedInString)
    const ddl = "CREATE PROCEDURE P AS BEGIN UPDATE TIPOS SET TIPO = 'ção'; END"
    expect(rewrite(ddl)).toBe(ddl)
  })

  it('unescapes quotes and lists the tables and columns to look up', () => {
    expect(rewrite("SELECT * FROM TIPOS WHERE TIPO = 'd''ção'")).toBe(`SELECT * FROM TIPOS WHERE TIPO IN ('d''ção', x'6427E7E36F')`)
    expect(legacyLiteralTables("SELECT * FROM TIPOS t JOIN CLIENTES c ON 1 = 1 WHERE t.TIPO = 'ção'", 'firebird')).toEqual(['TIPOS', 'CLIENTES'])
    expect(legacyLiteralTables("SELECT * FROM TIPOS WHERE TIPO = 'abc'", 'firebird')).toEqual([])
    expect(legacyLiteralColumns("SELECT * FROM TIPOS WHERE TIPO = 'ção' OR NOME LIKE 'ç%'", 'firebird', columns)).toEqual([
      { table: 'TIPOS', column: 'TIPO' },
      { table: 'TIPOS', column: 'NOME' }
    ])
  })
})
