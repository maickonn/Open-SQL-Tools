import type { DbEngine } from '@shared/model'
import type { TextWriter } from '@domain/ports/database'

/**
 * Writes a restorable SQL script: statements with the terminator the engine's clients expect,
 * routine bodies wrapped in DELIMITER (MySQL family) or SET TERM (Firebird) blocks.
 */
export class ScriptWriter {
  statements = 0
  /** Firebird: inside a SET TERM ^ block, statements end with ^. */
  private term = ';'

  constructor(
    private readonly out: TextWriter,
    readonly engine: DbEngine
  ) {}

  private get isMy(): boolean {
    return this.engine === 'mysql' || this.engine === 'mariadb'
  }

  raw(text: string): Promise<void> {
    return this.out.write(text)
  }

  comment(text: string): Promise<void> {
    return this.out.write(text.split('\n').map((l) => `-- ${l}`.trimEnd()).join('\n') + '\n')
  }

  section(title: string): Promise<void> {
    return this.out.write(`\n--\n-- ${title}\n--\n\n`)
  }

  /** A plain statement (trailing terminator optional). */
  async statement(sql: string): Promise<void> {
    const text = stripTerminator(sql)
    if (!text) return
    this.statements++
    await this.out.write(`${text}${this.term}\n${this.term === ';' ? '\n' : ''}`)
  }

  /** A statement whose body may contain `;` (procedures, triggers, events, PSQL blocks). */
  async routine(sql: string): Promise<void> {
    const text = stripTerminator(sql)
    if (!text) return
    this.statements++
    if (this.isMy) await this.out.write(`DELIMITER ;;\n${text};;\nDELIMITER ;\n\n`)
    else if (this.engine === 'firebird') {
      if (this.term === '^') await this.out.write(`${text}^\n`)
      else await this.out.write(`SET TERM ^ ;\n${text}^\nSET TERM ; ^\n\n`)
    } else await this.out.write(`${text};\n\n`)
  }

  /** Firebird: switches to the ^ terminator for a run of PSQL blocks. */
  async beginBlocks(): Promise<void> {
    if (this.engine !== 'firebird' || this.term === '^') return
    this.term = '^'
    await this.out.write('SET TERM ^ ;\n')
  }

  async endBlocks(): Promise<void> {
    if (this.term !== '^') return
    this.term = ';'
    await this.out.write('SET TERM ; ^\n\n')
  }
}

/** Removes the trailing `;` (and whitespace) of a statement. */
export function stripTerminator(sql: string): string {
  return sql.replace(/[\s;]+$/, '')
}

/**
 * Firebird DDL from the inspector comes wrapped in `SET TERM ^ ;` … `SET TERM ; ^`: returns the
 * statements inside (a package gives its header and its body).
 */
export function unwrapSetTerm(ddl: string): string[] {
  if (!/^\s*SET\s+TERM\b/im.test(ddl)) return [stripTerminator(ddl)]
  const body = ddl.replace(/^\s*SET\s+TERM\s+\S+\s*\S*\s*$/gim, '')
  return body
    .split(/\^\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean)
}
