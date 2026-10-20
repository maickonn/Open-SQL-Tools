import { unquoteSqliteIdent } from './sqliteTrigger'

/** What PRAGMA table_xinfo does not report, read from the CREATE TABLE text in sqlite_schema. */
export interface SqliteTableDetails {
  /** Column name → details from its definition. */
  columns: Map<string, { autoIncrement: boolean; generated?: { expression: string; stored: boolean }; collation?: string }>
  checks: { name: string; expression: string }[]
  /** Constraint names of UNIQUE / FOREIGN KEY table constraints, in order of appearance. */
  uniqueNames: (string | undefined)[]
  foreignKeyNames: (string | undefined)[]
  withoutRowid: boolean
  strict: boolean
}

/** Splits text on top-level commas (outside parentheses, strings and quoted identifiers). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const close = s.indexOf(c, i + 1)
      i = close < 0 ? s.length : close
    } else if (c === '[') {
      const close = s.indexOf(']', i + 1)
      i = close < 0 ? s.length : close
    } else if (c === '-' && s[i + 1] === '-') {
      const eol = s.indexOf('\n', i)
      i = eol < 0 ? s.length : eol
    } else if (c === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2)
      i = close < 0 ? s.length : close + 1
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = s.slice(start).trim()
  if (last) out.push(last)
  return out
}

/** Text of the balanced parenthesized group starting at `open` (exclusive), and its end offset. */
function balanced(s: string, open: number): { inner: string; end: number } | null {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const close = s.indexOf(c, i + 1)
      if (close < 0) return null
      i = close
    } else if (c === '[') {
      const close = s.indexOf(']', i + 1)
      if (close < 0) return null
      i = close
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 }
  }
  return null
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|\[[^\]]*\]|` + '`(?:[^`]|``)*`' + String.raw`|[\w$]+)`
const CONSTRAINT_HEAD = new RegExp(String.raw`^(?:CONSTRAINT\s+(${IDENT})\s+)?(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b`, 'i')

export function parseSqliteTable(sql: string): SqliteTableDetails {
  const details: SqliteTableDetails = { columns: new Map(), checks: [], uniqueNames: [], foreignKeyNames: [], withoutRowid: false, strict: false }
  const open = sql.indexOf('(')
  const group = open < 0 ? null : balanced(sql, open)
  if (!group) return details
  const tail = sql.slice(group.end)
  details.withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(tail)
  details.strict = /\bSTRICT\b/i.test(tail)

  for (const element of splitTopLevel(group.inner)) {
    const constraint = CONSTRAINT_HEAD.exec(element)
    if (constraint) {
      const name = constraint[1] ? unquoteSqliteIdent(constraint[1]) : undefined
      const kind = constraint[2].toUpperCase().replace(/\s+/g, ' ')
      if (kind === 'CHECK') {
        const p = element.indexOf('(', constraint[0].length)
        const inner = p < 0 ? null : balanced(element, p)
        if (inner) details.checks.push({ name: name ?? '', expression: inner.inner.trim() })
      } else if (kind === 'UNIQUE') details.uniqueNames.push(name)
      else if (kind === 'FOREIGN KEY') details.foreignKeyNames.push(name)
      continue
    }
    const head = new RegExp(String.raw`^(${IDENT})`).exec(element)
    if (!head) continue
    const column = unquoteSqliteIdent(head[1])
    const rest = element.slice(head[0].length)
    const info: { autoIncrement: boolean; generated?: { expression: string; stored: boolean }; collation?: string } = {
      autoIncrement: /\bAUTOINCREMENT\b/i.test(rest)
    }
    const gen = /\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/i.exec(rest)
    if (gen) {
      const inner = balanced(rest, gen.index + gen[0].length - 1)
      if (inner) info.generated = { expression: inner.inner.trim(), stored: /^\s*STORED\b/i.test(rest.slice(inner.end)) }
    }
    const collate = new RegExp(String.raw`\bCOLLATE\s+(${IDENT})`, 'i').exec(rest)
    if (collate) info.collation = unquoteSqliteIdent(collate[1])
    // Column-level CHECK constraints become table checks.
    const checkRe = new RegExp(String.raw`(?:CONSTRAINT\s+(${IDENT})\s+)?CHECK\s*\(`, 'gi')
    for (let m = checkRe.exec(rest); m; m = checkRe.exec(rest)) {
      const inner = balanced(rest, m.index + m[0].length - 1)
      if (inner) details.checks.push({ name: m[1] ? unquoteSqliteIdent(m[1]) : '', expression: inner.inner.trim() })
    }
    details.columns.set(column, info)
  }
  return details
}
