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

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c)

/**
 * Splits a script into statements. Aware of strings, quoted identifiers, comments,
 * PostgreSQL dollar quoting, MySQL/MariaDB `DELIMITER`, Firebird `SET TERM`, SQLite `[identifiers]`,
 * and BEGIN…END bodies of routines and triggers created without changing the delimiter.
 */
export function splitSql(script: string, engine: DbEngine): SqlStatement[] {
  const out: SqlStatement[] = []
  const isMy = engine === 'mysql' || engine === 'mariadb'
  const isPg = engine === 'postgres'
  const isFb = engine === 'firebird'
  const isLite = engine === 'sqlite'
  const n = script.length

  let delimiter = ';'
  let i = 0
  let stmtStart = 0
  // Per-statement state
  let sawWord = false
  let routineMode = false
  let bodyStarted = false
  let externalRoutine = false
  let depth = 0
  let lastWord = ''

  const push = (endExclusive: number, nextStart: number): void => {
    const raw = script.slice(stmtStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const sql = raw.trim()
    if (sql && stripLeadingComments(sql) !== '') {
      out.push({ sql, start: stmtStart + lead, end: stmtStart + lead + sql.length })
    }
    stmtStart = nextStart
    sawWord = false
    routineMode = false
    bodyStarted = false
    externalRoutine = false
    depth = 0
    lastWord = ''
  }

  while (i < n) {
    const c = script[i]
    const next = script[i + 1]

    // Client-side delimiter commands are only recognized at the start of a statement.
    if (!sawWord && (isMy || isFb) && (c === 'D' || c === 'd' || c === 'S' || c === 's')) {
      const rest = script.slice(i, i + 200)
      if (isMy) {
        const m = /^DELIMITER[ \t]+(\S+)[^\n]*(?:\n|$)/i.exec(rest)
        if (m) {
          delimiter = m[1]
          i += m[0].length
          stmtStart = i
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
          delimiter = token
          stmtStart = i
          continue
        }
      }
    }

    // Line comments
    if ((c === '-' && next === '-') || (isMy && c === '#')) {
      const eol = script.indexOf('\n', i)
      i = eol === -1 ? n : eol + 1
      continue
    }
    // Block comments (MySQL /*! … */ executable comments stay part of the statement text)
    if (c === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      continue
    }
    // String literals ("…" is a string in MySQL unless ANSI_QUOTES is on)
    if (c === "'" || (c === '"' && isMy)) {
      i = skipQuoted(script, i, c, isMy || (isPg && isEString(script, i)))
      continue
    }
    // Quoted identifiers
    if (c === '"' || (c === '`' && (isMy || isLite))) {
      i = skipQuoted(script, i, c, false)
      continue
    }
    if (c === '[' && isLite) {
      const close = script.indexOf(']', i + 1)
      i = close === -1 ? n : close + 1
      continue
    }
    // PostgreSQL dollar quoting
    if (isPg && c === '$' && !isWordChar(script[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64))
      if (m) {
        const close = script.indexOf(m[0], i + m[0].length)
        i = close === -1 ? n : close + m[0].length
        continue
      }
    }

    // Keywords (used to track routine bodies)
    if (isWordChar(c) && !isWordChar(script[i - 1]) && !(delimiter !== ';' && script.startsWith(delimiter, i))) {
      let j = i
      // A custom delimiter such as `$$` may be glued to a word (`END$$`).
      while (j < n && isWordChar(script[j]) && !(delimiter !== ';' && script.startsWith(delimiter, j))) j++
      const word = script.slice(i, j).toUpperCase()
      if (!sawWord) {
        sawWord = true
        routineMode = ROUTINE_HEAD.test(collapseComments(script.slice(i, i + 400)))
      }
      if (routineMode) {
        if (word === 'BEGIN') {
          depth++
          bodyStarted = true
        } else if (word === 'EXTERNAL') externalRoutine = true
        else if (word === 'CASE' && lastWord !== 'END') depth++
        else if (word === 'END' && !CLOSERS_NOT_COUNTED.has(peekWord(script, j))) depth = Math.max(0, depth - 1)
      }
      lastWord = word
      i = j
      continue
    }

    // Firebird PSQL declares variables (`DECLARE x INT;`) before the body BEGIN.
    const inPsqlHeader = isFb && routineMode && !bodyStarted && !externalRoutine
    if (script.startsWith(delimiter, i) && (delimiter !== ';' || !routineMode || (depth === 0 && !inPsqlHeader))) {
      push(i, i + delimiter.length)
      i += delimiter.length
      continue
    }
    i++
  }
  if (stmtStart < n) push(n, n)
  return out
}

function peekWord(s: string, from: number): string {
  let k = from
  while (k < s.length && /\s/.test(s[k])) k++
  let e = k
  while (e < s.length && isWordChar(s[e])) e++
  return s.slice(k, e).toUpperCase()
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

function skipQuoted(s: string, i: number, quote: string, backslashEscapes: boolean): number {
  let j = i + 1
  const n = s.length
  while (j < n) {
    const ch = s[j]
    if (backslashEscapes && ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) {
      if (s[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return n
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
