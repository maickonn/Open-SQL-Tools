import type { DbEngine } from '@shared/model'

/** Starter SQL for new views and routines, per engine. */
export function viewTemplate(engine: DbEngine, qualifier: string): string {
  const name = engine === 'firebird' ? 'NEW_VIEW' : `${qualifier}new_view`
  return `CREATE VIEW ${name} AS\nSELECT 1 AS id${engine === 'firebird' ? ' FROM RDB$DATABASE' : ''};\n`
}

export function routineTemplate(engine: DbEngine, qualifier: string): string {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return `DELIMITER $$\nCREATE PROCEDURE ${qualifier}new_procedure(IN p_id INT)\nBEGIN\n  SELECT p_id;\nEND$$\nDELIMITER ;\n`
    case 'postgres':
      return `CREATE OR REPLACE FUNCTION ${qualifier}new_function(p_id integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN p_id;\nEND;\n$$;\n`
    case 'firebird':
      return `SET TERM ^ ;\nCREATE OR ALTER PROCEDURE NEW_PROCEDURE (P_ID INTEGER)\nRETURNS (RESULT INTEGER)\nAS\nBEGIN\n  RESULT = P_ID;\n  SUSPEND;\nEND^\nSET TERM ; ^\n`
  }
}
