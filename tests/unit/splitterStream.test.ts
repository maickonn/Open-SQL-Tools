import { describe, expect, it } from 'vitest'
import { SqlScanner, splitSql, type SqlStatement } from '@domain/sql/splitter'
import type { DbEngine } from '@shared/model'

/** Deterministic PRNG so chunk boundaries are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function streamed(script: string, engine: DbEngine, size: (k: number) => number): SqlStatement[] {
  const scanner = new SqlScanner(engine)
  const out: SqlStatement[] = []
  let k = 0
  for (let at = 0; at < script.length; ) {
    const len = Math.max(1, size(k++))
    out.push(...scanner.feed(script.slice(at, at + len)))
    at += len
  }
  out.push(...scanner.end())
  return out
}

const pad = (s: string): string => `${s}\n${'-- padding line to push tokens across the lookahead window\n'.repeat(12)}${s}`

const SCRIPTS: Array<[DbEngine, string]> = [
  ['mysql', 'select 1; select 2;;\n'],
  ['mysql', `select ';', "a;b", \`c;d\` -- x;y\n from t; /* ; */ select 'it''s;'`],
  ['mysql', String.raw`select 'a\';b'; select 2; select 'x\\'; select "q""q"`],
  ['mariadb', 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();'],
  ['mysql', 'DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END;;\nDELIMITER ;\n# hash comment ;\nselect 1'],
  [
    'mysql',
    `CREATE DEFINER=\`root\`@\`%\` PROCEDURE p(IN x INT)
BEGIN
  IF x > 0 THEN SELECT 1; ELSE SELECT 2; END IF;
  WHILE x > 0 DO SET x = x - 1; END WHILE;
  SELECT CASE WHEN x = 0 THEN 'z' ELSE 'n' END;
END;
SELECT 3;`
  ],
  [
    'postgres',
    String.raw`CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; select E'a\';b'; select $$x;y$$; select 'a''b'`
  ],
  ['postgres', 'select 1 /* multi\nline ; comment */; select "we;ird"; select $a$ $b$ ; $a$'],
  ['firebird', 'SET TERM ^ ;\nCREATE PROCEDURE P AS BEGIN EXIT; END^\nSET TERM ; ^\nSELECT 1 FROM RDB$DATABASE;'],
  [
    'firebird',
    `EXECUTE BLOCK AS DECLARE x INT; BEGIN x = 1; IF (x = 1) THEN BEGIN x = 2; END END;
CREATE OR ALTER TRIGGER T1 FOR T ACTIVE BEFORE INSERT AS BEGIN NEW.ID = 1; END;
SELECT 1 FROM RDB$DATABASE`
  ],
  ['sqlite', 'CREATE TABLE [a;b] (x); CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO l VALUES (1); END; select `q;`']
]

describe('SqlScanner', () => {
  for (const [engine, base] of SCRIPTS) {
    for (const script of [base, pad(base), pad(pad(base))]) {
      it(`matches splitSql for ${engine}: ${JSON.stringify(script.slice(0, 40))}… (${script.length} chars)`, () => {
        const expected = splitSql(script, engine)
        expect(streamed(script, engine, () => script.length)).toEqual(expected)
        expect(streamed(script, engine, () => 1)).toEqual(expected)
        for (const seed of [1, 2, 3, 42]) {
          const r = rng(seed)
          expect(streamed(script, engine, () => 1 + Math.floor(r() * 50))).toEqual(expected)
        }
        for (const s of expected) expect(script.slice(s.start, s.end)).toBe(s.sql)
      })
    }
  }

  it('streams a long dump with bounded memory and absolute offsets', () => {
    const row = "INSERT INTO t VALUES (1, 'a;b', 'it''s');\n"
    const script = row.repeat(20000)
    const scanner = new SqlScanner('mysql')
    let count = 0
    let maxBuffered = 0
    let last: SqlStatement | undefined
    for (let at = 0; at < script.length; at += 4096) {
      const got = scanner.feed(script.slice(at, at + 4096))
      count += got.length
      if (got.length) last = got[got.length - 1]
      maxBuffered = Math.max(maxBuffered, scanner.buffered)
    }
    count += scanner.end().length
    expect(count).toBe(20000)
    expect(maxBuffered).toBeLessThan(200_000)
    expect(last && script.slice(last.start, last.end)).toBe(last?.sql)
  })

  it('handles a multi-megabyte string literal in linear time', () => {
    const big = 'x'.repeat(2_000_000)
    const script = `insert into t values ('${big}'); select 1;`
    const started = performance.now()
    const out = streamed(script, 'mysql', () => 65536)
    expect(out.map((s) => s.sql.length)).toEqual([big.length + 25, 8])
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
