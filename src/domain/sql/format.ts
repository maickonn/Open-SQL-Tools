import type { DbEngine } from '@shared/model'
import { splitSql } from './splitter'
import { functionsFor, tokenize, type Token } from './intellisense'

const INDENT = '    '

/** Clauses that start a line at the query's level. `list`: one item per line below the keyword. */
const CLAUSES: { words: string[]; kind: 'list' | 'inline' | 'join' | 'values' | 'setop' }[] = [
  { words: ['SELECT'], kind: 'list' },
  { words: ['FROM'], kind: 'inline' },
  { words: ['WHERE'], kind: 'inline' },
  { words: ['GROUP', 'BY'], kind: 'list' },
  { words: ['HAVING'], kind: 'inline' },
  { words: ['ORDER', 'BY'], kind: 'list' },
  { words: ['WINDOW'], kind: 'inline' },
  { words: ['LIMIT'], kind: 'inline' },
  { words: ['OFFSET'], kind: 'inline' },
  { words: ['FETCH'], kind: 'inline' },
  { words: ['UNION', 'ALL'], kind: 'setop' },
  { words: ['UNION'], kind: 'setop' },
  { words: ['INTERSECT'], kind: 'setop' },
  { words: ['EXCEPT'], kind: 'setop' },
  { words: ['MINUS'], kind: 'setop' },
  { words: ['INSERT', 'INTO'], kind: 'inline' },
  { words: ['REPLACE', 'INTO'], kind: 'inline' },
  { words: ['VALUES'], kind: 'values' },
  { words: ['UPDATE'], kind: 'inline' },
  { words: ['SET'], kind: 'list' },
  { words: ['DELETE', 'FROM'], kind: 'inline' },
  { words: ['DELETE'], kind: 'inline' },
  { words: ['ON', 'CONFLICT'], kind: 'inline' },
  { words: ['ON', 'DUPLICATE', 'KEY', 'UPDATE'], kind: 'list' },
  { words: ['RETURNING'], kind: 'list' },
  { words: ['FOR', 'UPDATE'], kind: 'inline' },
  { words: ['NATURAL', 'JOIN'], kind: 'join' },
  { words: ['CROSS', 'JOIN'], kind: 'join' },
  { words: ['INNER', 'JOIN'], kind: 'join' },
  { words: ['LEFT', 'OUTER', 'JOIN'], kind: 'join' },
  { words: ['RIGHT', 'OUTER', 'JOIN'], kind: 'join' },
  { words: ['FULL', 'OUTER', 'JOIN'], kind: 'join' },
  { words: ['LEFT', 'JOIN'], kind: 'join' },
  { words: ['RIGHT', 'JOIN'], kind: 'join' },
  { words: ['FULL', 'JOIN'], kind: 'join' },
  { words: ['JOIN'], kind: 'join' },
  { words: ['CROSS', 'APPLY'], kind: 'join' },
  { words: ['OUTER', 'APPLY'], kind: 'join' }
]

/** Words written in upper case (reserved words that are never bare identifiers). */
const KEYWORDS = new Set(
  (
    'SELECT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE SIMILAR AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL USING ' +
    'GROUP BY ORDER HAVING LIMIT OFFSET UNION INTERSECT EXCEPT MINUS ALL ANY SOME DISTINCT INSERT INTO VALUES UPDATE SET DELETE CASE WHEN ' +
    'THEN ELSE END WITH RECURSIVE ASC DESC NULLS RETURNING FETCH NEXT ONLY OVER PARTITION WINDOW TRUE FALSE CONFLICT DO NOTHING DUPLICATE ' +
    'KEY REPLACE MATERIALIZED LATERAL ESCAPE COLLATE SKIP FIRST TOP ROWS ROW CONTAINING STARTING FILTER WITHIN RANGE PRECEDING FOLLOWING ' +
    'UNBOUNDED CURRENT APPLY'
  ).split(' ')
)

/** Words followed by "(" that keep a space before it (they are not function calls). */
const SPACED_PAREN = new Set(['IN', 'VALUES', 'AS', 'OVER', 'AND', 'OR', 'NOT', 'EXISTS', 'ON', 'USING', 'FROM', 'JOIN', 'INTO', 'SELECT', 'WHERE', 'BY', 'ALL', 'ANY', 'SOME', 'THEN', 'ELSE', 'WHEN', 'CONFLICT', 'LATERAL', 'FILTER', 'WITHIN', 'SET', 'RETURNING', 'HAVING', 'WITH', 'IS', 'LIKE', 'MATERIALIZED', 'APPLY'])

/** Types written in upper case after CAST(… AS and before typed literals (DATE '2026-01-01'). */
const TYPES = /^(DATE|TIME|TIMESTAMP|INTERVAL|INTEGER|INT|BIGINT|SMALLINT|NUMERIC|DECIMAL|VARCHAR|CHAR|CHARACTER|TEXT|BOOLEAN|FLOAT|DOUBLE|REAL|BLOB|UUID|JSON|JSONB|SIGNED|UNSIGNED|BINARY|VARYING|PRECISION)$/i

const up = (t: Token | undefined): string => (t?.kind === 'word' ? t.text.toUpperCase() : '')

/** Builds the output line by line; `level` is the indentation of the current line. */
class Out {
  lines: { level: number; text: string }[] = []
  private cur: { level: number; text: string } | null = null
  /** A line comment ended the line: the next token starts a new one. */
  breakPending = false

  get level(): number {
    return this.cur?.level ?? 0
  }
  get empty(): boolean {
    return !this.cur || this.cur.text === ''
  }

  line(level: number): void {
    if (this.cur && this.cur.text === '') this.cur.level = level
    else {
      this.cur = { level, text: '' }
      this.lines.push(this.cur)
    }
    this.breakPending = false
  }
  blank(): void {
    if (this.cur && this.cur.text !== '') this.lines.push({ level: 0, text: '' })
    this.cur = null
  }
  write(text: string, space: boolean): void {
    if (this.breakPending || !this.cur) this.line(this.cur?.level ?? 0)
    this.cur!.text += this.cur!.text && space ? ` ${text}` : text
  }
  toString(): string {
    return this.lines.map((l) => (l.text ? INDENT.repeat(l.level) + l.text : '')).join('\n')
  }
}

class Formatter {
  private out = new Out()
  private builtins: Map<string, unknown>

  constructor(
    private readonly tokens: Token[],
    engine: DbEngine
  ) {
    this.builtins = functionsFor(engine)
  }

  run(): string {
    this.query(0, 0, false)
    return this.out.toString()
  }

  private clauseAt(i: number): (typeof CLAUSES)[number] | undefined {
    return CLAUSES.find((c) => c.words.every((w, k) => up(this.tokens[i + k]) === w))
  }

  private text(i: number): string {
    const t = this.tokens[i]
    const prev = this.tokens[i - 1]
    const next = this.tokens[i + 1]
    if (t.kind !== 'word' || prev?.text === '.' || next?.text === '.') return t.text
    const u = t.text.toUpperCase()
    if (next?.text === '(' && this.builtins.has(u)) return u
    if (KEYWORDS.has(u)) return u
    if (TYPES.test(u) && (next?.kind === 'string' || up(prev) === 'AS' || prev?.text === '::')) return u
    return t.text
  }

  /** Whether a space separates token i from the previous output. */
  private spaced(i: number): boolean {
    const t = this.tokens[i]
    const prev = this.tokens[i - 1]
    if (!prev) return true
    if ([',', ')', '.', ';', '::', '['].includes(t.text) || ['(', '.', '::', '['].includes(prev.text)) return false
    if (t.text === '(') {
      // INSERT INTO t (a, b): the column list is not a call.
      const name = (k: number): boolean => this.tokens[k]?.kind === 'word' || this.tokens[k]?.kind === 'quoted'
      let j = i - 1
      if (name(j)) {
        j--
        while (this.tokens[j]?.text === '.' && name(j - 1)) j -= 2
        if (up(this.tokens[j]) === 'INTO') return true
      }
      return !((prev.kind === 'word' || prev.kind === 'quoted') && !SPACED_PAREN.has(up(prev)))
    }
    // Multi-character operators (>=, <>, ||) were split by the lexer: keep them together.
    if (t.kind === 'punct' && prev.kind === 'punct' && prev.end === t.start) return false
    return true
  }

  private emit(i: number): void {
    const t = this.tokens[i]
    this.out.write(this.text(i), this.spaced(i))
    if (t.kind === 'comment' && t.text.startsWith('--')) this.out.breakPending = true
    if (t.kind === 'comment' && t.text.startsWith('#')) this.out.breakPending = true
  }

  /** Index of the token closing the parenthesis opened at `open`. */
  private closing(open: number): number {
    let depth = 0
    for (let i = open; i < this.tokens.length; i++) {
      if (this.tokens[i].text === '(') depth++
      else if (this.tokens[i].text === ')' && --depth === 0) return i
    }
    return this.tokens.length
  }

  private isSubquery(open: number): boolean {
    const next = this.tokens.slice(open + 1).find((t) => t.kind !== 'comment')
    return up(next) === 'SELECT' || up(next) === 'WITH'
  }

  /** A parenthesized subquery: its body one level deeper, the closing parenthesis back on the opener's level. */
  private subquery(open: number): number {
    const base = this.out.level
    this.emit(open)
    const close = this.closing(open)
    this.query(open + 1, base + 1, true)
    this.out.line(base)
    if (close < this.tokens.length) this.emit(close)
    return close + 1
  }

  /** Inline tokens inside a non-query parenthesis (function arguments, IN lists…), up to its closing one. */
  private inline(open: number): number {
    this.emit(open)
    let i = open + 1
    while (i < this.tokens.length && this.tokens[i].text !== ')') {
      if (this.tokens[i].text === '(') i = this.isSubquery(i) ? this.subquery(i) : this.inline(i)
      else this.emit(i++)
    }
    if (i < this.tokens.length) this.emit(i++)
    return i
  }

  /** WITH name AS ( … ), name AS ( … ) — one blank line between definitions and before the main query. */
  private withClause(i: number, level: number): number {
    this.out.line(level)
    this.emit(i++)
    if (up(this.tokens[i]) === 'RECURSIVE') this.emit(i++)
    for (;;) {
      while (i < this.tokens.length && this.tokens[i].text !== '(' ) this.emit(i++)
      if (i >= this.tokens.length) return i
      // A column list before AS: inline.
      if (up(this.tokens[i + 1]) !== 'SELECT' && up(this.tokens[i + 1]) !== 'WITH' && up(this.tokens[i + 1]) !== 'VALUES') {
        i = this.inline(i)
        continue
      }
      i = this.subquery(i)
      if (this.tokens[i]?.text === ',') {
        this.emit(i++)
        this.out.blank()
        this.out.line(level)
        continue
      }
      this.out.blank()
      return i
    }
  }

  /**
   * Formats a query (or DML statement) starting at `i` with its clauses at `level`, up to the
   * parenthesis closing it when `nested`. Returns the index of that parenthesis (or the end).
   */
  private query(i: number, level: number, nested: boolean): number {
    let clause: (typeof CLAUSES)[number]['kind'] | 'with' | undefined
    let clauseWord = ''
    let inJoinCondition = false
    let betweenPending = false
    const caseLevels: number[] = []

    while (i < this.tokens.length) {
      const t = this.tokens[i]
      if (nested && t.text === ')') return i
      const u = up(t)

      if (u === 'WITH' && (clause === undefined || clause === 'setop' || clauseWord === 'INSERT')) {
        i = this.withClause(i, level)
        clause = 'with'
        continue
      }

      const c = caseLevels.length === 0 ? this.clauseAt(i) : undefined
      // ON/USING of a join start their own indented line.
      if ((u === 'ON' || u === 'USING') && clause === 'join' && !c) {
        this.out.line(level + 1)
        this.emit(i++)
        inJoinCondition = u === 'ON'
        continue
      }
      // DELETE/UPDATE/INSERT inside ON CONFLICT … DO / MERGE stay inline.
      if (c && !(c.words[0] === 'UPDATE' && ['DO', 'FOR', 'ON'].includes(up(this.tokens[i - 1])))) {
        if (c.kind === 'setop') this.out.blank()
        this.out.line(level)
        for (const _ of c.words) this.emit(i++)
        clause = c.kind
        clauseWord = c.words.join(' ')
        inJoinCondition = false
        betweenPending = false
        if (c.kind === 'setop') {
          this.out.blank()
          clause = undefined
          continue
        }
        if (c.kind === 'list' || c.kind === 'values') {
          // SELECT modifiers stay on the keyword line.
          while (['DISTINCT', 'ALL', 'TOP', 'FIRST', 'SKIP', 'SQL_CALC_FOUND_ROWS', 'STRAIGHT_JOIN', 'HIGH_PRIORITY'].includes(up(this.tokens[i]))) {
            const mod = up(this.tokens[i])
            this.emit(i++)
            if (mod === 'DISTINCT' && up(this.tokens[i]) === 'ON' && this.tokens[i + 1]?.text === '(') {
              this.emit(i++)
              i = this.inline(i)
            } else if ((mod === 'TOP' || mod === 'FIRST' || mod === 'SKIP') && this.tokens[i]) {
              i = this.tokens[i].text === '(' ? this.inline(i) : (this.emit(i), i + 1)
            }
          }
          // A lone * stays on the SELECT line.
          const rest = this.tokens[i + 1]
          if (this.tokens[i]?.text === '*' && (!rest || this.clauseAt(i + 1) || rest.text === ')')) {
            this.emit(i++)
            continue
          }
          this.out.line(level + 1)
        }
        continue
      }

      if (t.text === '(') {
        i = this.isSubquery(i) ? this.subquery(i) : this.inline(i)
        continue
      }

      if (t.text === ',' && caseLevels.length === 0) {
        this.emit(i++)
        if (clause === 'list' || clause === 'values') this.out.line(level + 1)
        continue
      }

      if (u === 'BETWEEN') betweenPending = true
      if ((u === 'AND' || u === 'OR') && caseLevels.length === 0) {
        if (u === 'AND' && betweenPending) betweenPending = false
        else if (clauseWord === 'WHERE' || clauseWord === 'HAVING' || inJoinCondition) {
          this.out.line(inJoinCondition ? level + 2 : level + 1)
          this.emit(i++)
          continue
        }
      }

      // CASE at query level: WHEN/ELSE on their own lines, END back on the CASE line's level.
      if (u === 'CASE') {
        caseLevels.push(this.out.level)
        this.emit(i++)
        continue
      }
      if ((u === 'WHEN' || u === 'ELSE') && caseLevels.length) {
        this.out.line(caseLevels[caseLevels.length - 1] + 1)
        this.emit(i++)
        continue
      }
      if (u === 'END' && caseLevels.length) {
        this.out.line(caseLevels.pop()!)
        this.emit(i++)
        continue
      }

      this.emit(i++)
    }
    return i
  }
}

/** Statements the formatter lays out itself; anything else goes to the fallback. */
const DML = /^\s*(SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE|VALUES|\()/i

/**
 * Formats SQL in the house style: upper-case keywords, 4-space indentation, one select/group/order
 * item per line, FROM/WHERE content on the keyword line, joins at clause level with ON below,
 * WHEN/ELSE of CASE on their own lines and a blank line between CTEs. Statements other than queries
 * and DML (DDL, routine bodies) and scripts that change the delimiter go through `fallback`.
 */
export function formatSql(script: string, engine: DbEngine, fallback: (sql: string) => string): string {
  if (/^\s*(DELIMITER|SET\s+TERM)\b/im.test(script)) return fallback(script)
  const statements = splitSql(script, engine)
  if (!statements.length) return script
  return statements
    .map((s) => {
      const tokens = tokenize(s.sql, engine)
      const formatted = DML.test(s.sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, '')) ? new Formatter(tokens, engine).run() : fallback(s.sql)
      const terminated = /^\s*;/.test(script.slice(s.end))
      return formatted.trimEnd() + (terminated ? ';' : '')
    })
    .join('\n\n')
}
