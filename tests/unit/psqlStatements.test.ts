import { describe, expect, it } from 'vitest'
import { extractDmlStatements } from '@domain/sql/psqlStatements'

const TRIGGER = `SET TERM ^ ;
CREATE OR ALTER TRIGGER CLIENTES_AU0 FOR CLIENTES ACTIVE AFTER UPDATE POSITION 0
AS
begin
  IF (UPDATING) THEN
  BEGIN
    if (OLD.NOME_EXIBICAO <> NEW.NOME_EXIBICAO) THEN
      EXCEPTION EDICAO_NAO_PERMITIDA 'Não é permitido; alterar!';
  END

  IF (NOT NEW.PARCEIRO = OLD.PARCEIRO) THEN
  UPDATE LICENCAS
  SET PARCEIRO = NEW.parceiro
  WHERE CLIENTE = NEW.nome_exibicao;

  -- UPDATE COMMENTED SET X = 1;
  /* DELETE FROM NOPE; */
  INSERT INTO LOGS (TABLE_NAME, LOG) VALUES ('CLIENTES', 'Valor; de ' || OLD.NOME_EXIBICAO);
end^
SET TERM ; ^`

const PROCEDURE = `CREATE OR ALTER PROCEDURE CONVERTE (PLACA_IN VARCHAR(7), MODO_IN INTEGER)
RETURNS (PLACA_OUT VARCHAR(7))
AS
DECLARE VARIABLE vtotal INTEGER;
BEGIN
  SELECT COUNT(*) FROM FROTA WHERE PLACA = :placa_in AND MODO = modo_in INTO :vtotal;
  FOR SELECT P.PLACA FROM FROTA P WHERE P.ATIVO = 1 AND P.TOTAL > vtotal INTO :placa_out DO
  BEGIN
    UPDATE OR INSERT INTO HIST (PLACA) VALUES (:placa_out) MATCHING (PLACA);
    SUSPEND;
  END
  DELETE FROM TMP WHERE ID IN (SELECT ID FROM OLD_TMP);
  INSERT INTO AUDIT (ID) VALUES (GEN_ID(GEN_AUDIT, 1)) RETURNING ID INTO :vtotal;
END`

describe('extractDmlStatements', () => {
  it('finds trigger statements, skipping the header events, comments and strings', () => {
    const ops = extractDmlStatements(TRIGGER)
    expect(ops.map((o) => [o.operation, o.table])).toEqual([
      ['update', 'LICENCAS'],
      ['insert', 'LOGS']
    ])
    expect(ops[0].statement).toBe('UPDATE LICENCAS\n  SET PARCEIRO = NEW.parceiro\n  WHERE CLIENTE = NEW.nome_exibicao')
    expect(ops[0].sql).toBe('UPDATE LICENCAS\n SET PARCEIRO = ?\n WHERE CLIENTE = ?')
    expect(ops[1].sql).toBe("INSERT INTO LOGS (TABLE_NAME, LOG) VALUES ('CLIENTES', 'Valor; de ' || ?)")
  })

  it('rewrites procedure statements: INTO lists, params, declared variables, FOR SELECT, upserts', () => {
    const ops = extractDmlStatements(PROCEDURE)
    expect(ops.map((o) => [o.operation, o.table])).toEqual([
      ['select', 'FROTA'],
      ['select', 'FROTA'],
      ['upsert', 'HIST'],
      ['delete', 'TMP'],
      ['insert', 'AUDIT']
    ])
    expect(ops[0].sql).toBe('SELECT COUNT(*) FROM FROTA WHERE PLACA = ? AND MODO = ?')
    expect(ops[1].sql).toBe('SELECT P.PLACA FROM FROTA P WHERE P.ATIVO = 1 AND P.TOTAL > ?')
    expect(ops[2].sql).toBe('UPDATE OR INSERT INTO HIST (PLACA) VALUES (?) MATCHING (PLACA)')
    expect(ops[3].sql).toBe('DELETE FROM TMP WHERE ID IN (SELECT ID FROM OLD_TMP)')
    expect(ops[4].sql).toBe('INSERT INTO AUDIT (ID) VALUES (GEN_ID(GEN_AUDIT, 1)) RETURNING ID')
  })
})
