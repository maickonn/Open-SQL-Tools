import { describe, expect, it } from 'vitest'
import { splitSql, statementAtOffset } from '@domain/sql/splitter'

const sqls = (script: string, engine: Parameters<typeof splitSql>[1]): string[] => splitSql(script, engine).map((s) => s.sql)

describe('splitSql', () => {
  it('splits simple statements and ignores empty ones', () => {
    expect(sqls('select 1; select 2;;\n', 'mysql')).toEqual(['select 1', 'select 2'])
  })

  it('keeps delimiters inside strings, identifiers and comments', () => {
    const script = `select ';', "a;b", \`c;d\` -- x;y\n from t; /* ; */ select 'it''s;'`
    expect(sqls(script, 'mysql')).toEqual([`select ';', "a;b", \`c;d\` -- x;y\n from t`, `/* ; */ select 'it''s;'`])
  })

  it('handles MySQL backslash escapes', () => {
    expect(sqls(String.raw`select 'a\';b'; select 2`, 'mysql')).toEqual([String.raw`select 'a\';b'`, 'select 2'])
  })

  it('supports MySQL DELIMITER', () => {
    const script = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();'
    expect(sqls(script, 'mariadb')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()'])
  })

  it('detects MySQL routine bodies without DELIMITER', () => {
    const script = `CREATE DEFINER=\`root\`@\`%\` PROCEDURE p(IN x INT)
BEGIN
  IF x > 0 THEN SELECT 1; ELSE SELECT 2; END IF;
  WHILE x > 0 DO SET x = x - 1; END WHILE;
  SELECT CASE WHEN x = 0 THEN 'z' ELSE 'n' END;
END;
SELECT 3;`
    const out = sqls(script, 'mysql')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/^CREATE DEFINER[\s\S]*END$/)
    expect(out[1]).toBe('SELECT 3')
  })

  it('supports PostgreSQL dollar quoting and E strings', () => {
    const script = String.raw`CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; select E'a\';b'; select $$x;y$$`
    expect(sqls(script, 'postgres')).toEqual([
      `CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql`,
      String.raw`select E'a\';b'`,
      'select $$x;y$$'
    ])
  })

  it('supports Firebird SET TERM', () => {
    const script = 'SET TERM ^ ;\nCREATE PROCEDURE P AS BEGIN EXIT; END^\nSET TERM ; ^\nSELECT 1 FROM RDB$DATABASE;'
    expect(sqls(script, 'firebird')).toEqual(['CREATE PROCEDURE P AS BEGIN EXIT; END', 'SELECT 1 FROM RDB$DATABASE'])
  })

  it('detects Firebird PSQL blocks without SET TERM', () => {
    const script = `EXECUTE BLOCK AS DECLARE x INT; BEGIN x = 1; IF (x = 1) THEN BEGIN x = 2; END END;
CREATE OR ALTER TRIGGER T1 FOR T ACTIVE BEFORE INSERT AS BEGIN NEW.ID = 1; END;
SELECT 1 FROM RDB$DATABASE`
    expect(sqls(script, 'firebird')).toHaveLength(3)
  })

  it('reports offsets and finds the statement at the cursor', () => {
    const script = 'select 1;\nselect 2;\nselect 3'
    const all = splitSql(script, 'postgres')
    expect(script.slice(all[1].start, all[1].end)).toBe('select 2')
    expect(statementAtOffset(script, 'postgres', 12)?.sql).toBe('select 2')
    expect(statementAtOffset(script, 'postgres', script.length)?.sql).toBe('select 3')
  })
})
