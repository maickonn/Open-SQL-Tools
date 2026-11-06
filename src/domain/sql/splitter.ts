import type { DbEngine } from '@shared/model'

export interface SqlStatement {
  /** Statement text without the trailing delimiter. */
  sql: string
  /** Start offset in the original script. */
  start: number
  /** End offset (exclusive) in the original script, without the delimiter. */
  end: number
}

/** Heads of statements whose body may contain `;` inside BEGIN…END blocks. */
const ROUTINE_HEAD =
  /^(?:(?:CREATE|ALTER|RECREATE)\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:TEMP(?:ORARY)?\s+)?(?:DEFINER\s*=\s*(?:`[^`]*`|'[^']*'|[^\s@]+)(?:@(?:`[^`]*`|'[^']*'|\S+))?\s+)?(?:AGGREGATE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT|PACKAGE(?:\s+BODY)?)\b|EXECUTE\s+BLOCK\b)/i

/** `END <word>` forms that close constructs we do not count as nesting. */
const CLOSERS_NOT_COUNTED = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'])

/** Characters the scanner wants past a token start, while input is still arriving, before reading it. */
const LOOKAHEAD = 400

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c)

/**
 * Incremental statement splitter: feed a script in chunks (e.g. while reading a large dump) and get
 * the statements completed so far, with offsets into the whole stream. Aware of strings, quoted
 * identifiers, comments, PostgreSQL dollar quoting, MySQL/MariaDB `DELIMITER`, Firebird `SET TERM`,
 * SQLite `[identifiers]`, and BEGIN…END bodies of routines and triggers created without changing
 * the delimiter. Memory is bounded by the longest statement.
 */
export class SqlScanner {
  private readonly isMy: boolean
  private readonly isPg: boolean
  private readonly isFb: boolean
  private readonly isLite: boolean
  private buf = ''
  /** Stream offset of `buf[0]`. */
  private base = 0
  private i = 0
  /** Where the scan of the unfinished token at `i` resumes (-1: from the token start). */
  private hint = -1
  private stmtStart = 0
  private delimiter = ';'
  // Per-statement state
  private sawWord = false
  private routineMode = false
  private bodyStarted = false
  private externalRoutine = false
  private depth = 0
  private lastWord = ''
  private out: SqlStatement[] = []

  constructor(engine: DbEngine) {
    this.isMy = engine === 'mysql' || engine === 'mariadb'
    this.isPg = engine === 'postgres'
    this.isFb = engine === 'firebird'
    this.isLite = engine === 'sqlite'
  }

  /** Appends text and returns the statements it completed. */
  feed(chunk: string): SqlStatement[] {
    this.buf += chunk
    this.scan(false)
    this.compact()
    return this.take()
  }

  /** Ends the input (optionally with a last chunk) and returns the remaining statements. */
  end(chunk = ''): SqlStatement[] {
    this.buf += chunk
    this.scan(true)
    if (this.stmtStart < this.buf.length) this.push(this.buf.length, this.buf.length)
    return this.take()
  }

  /** Characters currently held: the unfinished statement plus lookahead. */
  get buffered(): number {
    return this.buf.length
  }

  private take(): SqlStatement[] {
    const out = this.out
    this.out = []
    return out
  }

  private compact(): void {
    // Two characters before the statement start stay: E-string and word-boundary checks look back.
    const keep = this.stmtStart - 2
    if (keep < 65536 || keep < this.buf.length / 2) return
    this.buf = this.buf.slice(keep)
    this.base += keep
    this.i -= keep
    this.stmtStart -= keep
    if (this.hint >= 0) this.hint -= keep
  }

  private push(endExclusive: number, nextStart: number): void {
    const raw = this.buf.slice(this.stmtStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const sql = raw.trim()
    if (sql && stripLeadingComments(sql) !== '') {
      const start = this.base + this.stmtStart + lead
      this.out.push({ sql, start, end: start + sql.length })
    }
    this.stmtStart = nextStart
    this.sawWord = false
    this.routineMode = false
    this.bodyStarted = false
    this.externalRoutine = false
    this.depth = 0
    this.lastWord = ''
  }

  /** Scans from `i`; unless `final`, stops at the start of a token that may continue in the next chunk. */
  private scan(final: boolean): void {
    const { isMy, isPg, isFb, isLite } = this
    const script = this.buf
    const n = script.length
    let i = this.i

    while (i < n) {
      if (!final && n - i < LOOKAHEAD) break
      const c = script[i]
      const next = script[i + 1]
      const delimiter = this.delimiter
      const from = this.hint

      // Client-side delimiter commands are only recognized at the start of a statement.
      if (!this.sawWord && (isMy || isFb) && (c === 'D' || c === 'd' || c === 'S' || c === 's')) {
        const rest = script.slice(i, i + 200)
        if (isMy) {
          const m = /^DELIMITER[ \t]+(\S+)[^\n]*(?:\n|$)/i.exec(rest)
          if (m) {
            this.delimiter = m[1]
            i += m[0].length
            this.stmtStart = i
            continue
          }
        }
        if (isFb) {
          const m = /^SET\s+TERM\s+(\S+)/i.exec(rest)
          if (m) {
            let token = m[1]
            i += m[0].length
            if (token.length > delimiter.length && token.endsWith(delimiter)) {
              token = token.slice(0, -delimiter.length)
            } else {
              while (i < n && /\s/.test(script[i])) i++
              if (script.startsWith(delimiter, i)) i += delimiter.length
            }
            this.delimiter = token
            this.stmtStart = i
            continue
          }
        }
      }

      // Line comments
      if ((c === '-' && next === '-') || (isMy && c === '#')) {
        const eol = script.indexOf('\n', from >= 0 ? from : i)
        if (eol === -1 && !final) {
          this.hint = n
          break
        }
        i = eol === -1 ? n : eol + 1
        this.hint = -1
        continue
      }
      // Block comments (MySQL /*! … */ executable comments stay part of the statement text)
      if (c === '/' && next === '*') {
        const close = script.indexOf('*/', from >= 0 ? from : i + 2)
        if (close === -1 && !final) {
          this.hint = Math.max(i + 2, n - 1)
          break
        }
        i = close === -1 ? n : close + 2
        this.hint = -1
        continue
      }
      // String literals ("…" is a string in MySQL unless ANSI_QUOTES is on) and quoted identifiers
      const isString = c === "'" || (c === '"' && isMy)
      if (isString || c === '"' || (c === '`' && (isMy || isLite))) {
        const escapes = isString && (isMy || (isPg && isEString(script, i)))
        const r = skipQuoted(script, c, escapes, from >= 0 ? from : i + 1, final)
        if (r < 0) {
          this.hint = -r - 1
          break
        }
        i = r
        this.hint = -1
        continue
      }
      if (c === '[' && isLite) {
        const close = script.indexOf(']', from >= 0 ? from : i + 1)
        if (close === -1 && !final) {
          this.hint = n
          break
        }
        i = close === -1 ? n : close + 1
        this.hint = -1
        continue
      }
      // PostgreSQL dollar quoting
      if (isPg && c === '$' && !isWordChar(script[i - 1])) {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64))
        if (m) {
          const close = script.indexOf(m[0], from >= 0 ? from : i + m[0].length)
          if (close === -1 && !final) {
            this.hint = Math.max(i + m[0].length, n - m[0].length + 1)
            break
          }
          i = close === -1 ? n : close + m[0].length
          this.hint = -1
          continue
        }
      }

      // Keywords (used to track routine bodies)
      if (isWordChar(c) && !isWordChar(script[i - 1]) && !(delimiter !== ';' && script.startsWith(delimiter, i))) {
        let j = i
        // A custom delimiter such as `$$` may be glued to a word (`END$$`).
        while (j < n && isWordChar(script[j]) && !(delimiter !== ';' && script.startsWith(delimiter, j))) j++
        if (j === n && !final) break
        const word = script.slice(i, j).toUpperCase()
        let closer = ''
        if (word === 'END') {
          const peek = peekWord(script, j)
          if (peek.reachedEnd && !final) break
          closer = peek.word
        }
        if (!this.sawWord) {
          this.sawWord = true
          this.routineMode = ROUTINE_HEAD.test(collapseComments(script.slice(i, i + 400)))
        }
        if (this.routineMode) {
          if (word === 'BEGIN') {
            this.depth++
            this.bodyStarted = true
          } else if (word === 'EXTERNAL') this.externalRoutine = true
          else if (word === 'CASE' && this.lastWord !== 'END') this.depth++
          else if (word === 'END' && !CLOSERS_NOT_COUNTED.has(closer)) this.depth = Math.max(0, this.depth - 1)
        }
        this.lastWord = word
        i = j
        continue
      }

      // Firebird PSQL declares variables (`DECLARE x INT;`) before the body BEGIN.
      const inPsqlHeader = isFb && this.routineMode && !this.bodyStarted && !this.externalRoutine
      if (script.startsWith(delimiter, i) && (delimiter !== ';' || !this.routineMode || (this.depth === 0 && !inPsqlHeader))) {
        this.push(i, i + delimiter.length)
        i += delimiter.length
        continue
      }
      i++
    }
    this.i = i
  }
}

/** Splits a whole script into statements (see {@link SqlScanner}). */
export function splitSql(script: string, engine: DbEngine): SqlStatement[] {
  return new SqlScanner(engine).end(script)
}

function peekWord(s: string, from: number): { word: string; reachedEnd: boolean } {
  let k = from
  while (k < s.length && /\s/.test(s[k])) k++
  let e = k
  while (e < s.length && isWordChar(s[e])) e++
  return { word: s.slice(k, e).toUpperCase(), reachedEnd: e === s.length }
}

/** Replaces comments with a single space so head regexes can match across them. */
function collapseComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

export function stripLeadingComments(s: string): string {
  let t = s.trimStart()
  for (;;) {
    if (t.startsWith('--') || t.startsWith('#')) {
      const eol = t.indexOf('\n')
      t = eol === -1 ? '' : t.slice(eol + 1).trimStart()
    } else if (t.startsWith('/*') && !t.startsWith('/*!')) {
      const close = t.indexOf('*/')
      t = close === -1 ? '' : t.slice(close + 2).trimStart()
    } else return t
  }
}

function isEString(s: string, i: number): boolean {
  const p = s[i - 1]
  return (p === 'E' || p === 'e') && !isWordChar(s[i - 2])
}

/**
 * Scans a quoted token from `from` (just after the opening quote, or a resume point) and returns
 * the offset after the closing quote. When the input is not final and the token is still open,
 * returns `-(resume + 1)` instead, where `resume` is where the scan continues with more input.
 */
function skipQuoted(s: string, quote: string, backslashEscapes: boolean, from: number, final: boolean): number {
  let j = from
  const n = s.length
  while (j < n) {
    const ch = s[j]
    if (backslashEscapes && ch === '\\') {
      if (j + 1 >= n && !final) return -(j + 1)
      j += 2
      continue
    }
    if (ch === quote) {
      // A doubled quote may straddle the chunk boundary.
      if (j + 1 >= n && !final) return -(j + 1)
      if (s[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return final ? n : -(n + 1)
}

/** Returns the statement containing the cursor offset (for "execute current statement"). */
export function statementAtOffset(script: string, engine: DbEngine, offset: number): SqlStatement | undefined {
  let previous: SqlStatement | undefined
  for (const s of splitSql(script, engine)) {
    if (offset >= s.start && offset <= s.end + 1) return s
    if (s.start > offset) return previous ?? s
    previous = s
  }
  return previous
}
