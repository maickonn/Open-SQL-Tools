import type { DbEngine } from '@shared/model'
import { splitSql } from '../splitter'
import { isName, tokenize, type Token } from './lexer'

/** A row source of the statement: a table or view, a CTE or a derived table. */
export interface SourceRef {
  /** `function`: a table function or selectable procedure (`FROM generate_series(…)`). */
  kind: 'table' | 'cte' | 'subquery' | 'function'
  schema?: string
  name: string
  alias?: string
  /** Output columns of a CTE or derived table (from its column list or select list). */
  columns?: string[]
  /** Offsets of the name in the script. */
  start: number
  end: number
}

export type CursorContext =
  /** Inside a string or comment. */
  | { kind: 'none' }
  /** A table or view name is expected (after FROM, JOIN, INTO, UPDATE…, or after `schema.`). */
  | { kind: 'table'; schema?: string }
  /** A column (or expression) is expected; `qualifier` is the alias/table typed before the dot. */
  | { kind: 'column'; qualifier?: string; schema?: string; sources: SourceRef[] }
  /** After a complete table reference or at the start of a statement: keywords fit. */
  | { kind: 'keyword' }

export interface FunctionCall {
  name: string
  qualifier?: string
  /** Zero-based index of the argument being typed. */
  argIndex: number
}

export interface StatementAnalysis {
  cursor: CursorContext
  /** Every row source of the statement around the cursor. */
  sources: SourceRef[]
  /** Innermost function call whose argument list holds the cursor. */
  call?: FunctionCall
  /** The partial word under the cursor (already typed part). */
  prefix: string
}

/** Words that end a table reference (so they are never taken as its alias). */
const NOT_ALIAS = new Set(
  (
    'WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING GROUP ORDER HAVING LIMIT OFFSET FETCH FIRST SKIP ROWS UNION INTERSECT EXCEPT MINUS ' +
    'SET VALUES SELECT FROM AS WINDOW RETURNING FOR WITH LATERAL STRAIGHT_JOIN PARTITION PLAN INTO DEFAULT TABLESAMPLE USE FORCE IGNORE KEY INDEX ' +
    'WHEN THEN ELSE END AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE ROW DO UPDATE DELETE INSERT MERGE MATCHED OUTPUT CONFLICT ROWS_EXAMINED'
  ).split(' ')
)

/** Keywords after which a table name is expected. */
const TABLE_AFTER = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'DESCRIBE', 'DESC', 'TRUNCATE', 'STRAIGHT_JOIN'])

/** Keywords that start a column/expression clause. */
const COLUMN_CLAUSES = new Set(['SELECT', 'WHERE', 'ON', 'BY', 'HAVING', 'SET', 'RETURNING', 'WHEN', 'THEN', 'ELSE', 'AND', 'OR', 'NOT', 'DISTINCT', 'VALUES', 'USING', 'CASE', 'IN', 'BETWEEN', 'LIKE', 'IS', 'LIMIT', 'OFFSET', 'DO'])

/** Words followed by "(" that are not function calls. */
const NOT_CALL = new Set(['IN', 'VALUES', 'EXISTS', 'AS', 'FROM', 'JOIN', 'ON', 'WHERE', 'AND', 'OR', 'NOT', 'SELECT', 'OVER', 'USING', 'INTO', 'TABLE', 'ANY', 'ALL', 'SOME', 'WITH', 'RECURSIVE', 'UNION', 'LATERAL', 'BY'])

const upper = (t: Token | undefined): string => (t?.kind === 'word' ? t.text.toUpperCase() : '')
const nameOf = (t: Token): string => t.value ?? t.text

/** The statement around `offset`, extended to the cursor (trailing text the splitter trimmed). */
function statementSpan(script: string, engine: DbEngine, offset: number): { start: number; text: string } {
  let found: { start: number; end: number } | undefined
  for (const s of splitSql(script, engine)) {
    if (s.start > offset) break
    found = s
  }
  // The cursor sits after a delimiter: a new statement starts there.
  if (!found || /;/.test(script.slice(found.end, offset))) {
    const from = found ? script.lastIndexOf(';', offset - 1) + 1 : 0
    return { start: from, text: script.slice(from, offset) }
  }
  return { start: found.start, text: script.slice(found.start, Math.max(found.end, offset)) }
}

/** Splits a select list (tokens between SELECT and FROM at one depth) into output column names. */
function selectListNames(tokens: Token[]): string[] {
  const names: string[] = []
  let item: Token[] = []
  let depth = 0
  const flush = (): void => {
    if (!item.length) return
    const last = item[item.length - 1]
    if (isName(last) && (item.length === 1 || item[item.length - 2]?.text === '.' || upper(item[item.length - 2]) === 'AS' || isName(item[item.length - 2]) || item[item.length - 2]?.text === ')')) {
      if (last.text !== '*') names.push(nameOf(last))
    }
    item = []
  }
  for (const t of tokens) {
    if (t.text === '(') depth++
    else if (t.text === ')') depth--
    if (depth === 0 && t.text === ',') flush()
    else if (t.kind !== 'comment') item.push(t)
  }
  flush()
  return names
}

/** Output column names of the query starting at `from` (a SELECT, possibly after WITH). */
function queryColumns(tokens: Token[], from: number, to: number): string[] {
  let depth = 0
  let select = -1
  for (let i = from; i < to; i++) {
    const t = tokens[i]
    if (t.text === '(') depth++
    else if (t.text === ')') depth--
    else if (depth === 0 && upper(t) === 'SELECT') select = i + 1
    else if (depth === 0 && select >= 0 && (upper(t) === 'FROM' || upper(t) === 'INTO')) return selectListNames(tokens.slice(select, i))
  }
  return select >= 0 ? selectListNames(tokens.slice(select, to)) : []
}

/** Index of the token closing the parenthesis opened at `open` (or tokens.length). */
function closing(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++
    else if (tokens[i].text === ')' && --depth === 0) return i
  }
  return tokens.length
}

/** Reads an optional alias (with or without AS) at `i`. */
function readAlias(tokens: Token[], i: number): { alias?: string; next: number } {
  let j = i
  if (upper(tokens[j]) === 'AS') j++
  const t = tokens[j]
  if (isName(t) && !(t.kind === 'word' && NOT_ALIAS.has(t.text.toUpperCase()))) return { alias: nameOf(t), next: j + 1 }
  return { next: i }
}

/** Collects CTEs and every table reference of the statement (all nesting levels). */
export function collectSources(tokens: Token[], base = 0, outerCtes?: Map<string, string[]>): SourceRef[] {
  const sources: SourceRef[] = []
  // CTEs of enclosing queries stay visible inside derived tables.
  const ctes = new Map<string, string[]>(outerCtes)

  // WITH name [(cols)] AS ( query ), …
  for (let i = 0; i < tokens.length; i++) {
    if (upper(tokens[i]) !== 'WITH') continue
    let j = i + 1
    if (upper(tokens[j]) === 'RECURSIVE') j++
    while (isName(tokens[j])) {
      const nameTok = tokens[j]
      j++
      let columns: string[] | undefined
      if (tokens[j]?.text === '(') {
        const close = closing(tokens, j)
        columns = tokens.slice(j + 1, close).filter(isName).map(nameOf)
        j = close + 1
      }
      if (upper(tokens[j]) !== 'AS') break
      j++
      if (upper(tokens[j]) === 'NOT') j++
      if (upper(tokens[j]) === 'MATERIALIZED') j++
      if (tokens[j]?.text !== '(') break
      const close = closing(tokens, j)
      columns ??= queryColumns(tokens, j + 1, close)
      ctes.set(nameOf(nameTok).toUpperCase(), columns)
      sources.push({ kind: 'cte', name: nameOf(nameTok), columns, start: base + nameTok.start, end: base + nameTok.end })
      j = close + 1
      if (tokens[j]?.text !== ',') break
      j++
    }
  }

  const readTable = (i: number): number => {
    const t = tokens[i]
    if (t?.text === '(') {
      // Derived table: ( SELECT … ) [AS] alias
      const close = closing(tokens, i)
      const { alias, next } = readAlias(tokens, close + 1)
      if (alias && upper(tokens[i + 1]) !== 'VALUES') {
        const a = tokens[next - 1]
        sources.push({ kind: 'subquery', name: alias, alias, columns: queryColumns(tokens, i + 1, close), start: base + a.start, end: base + a.end })
      }
      // Tables read inside the derived table.
      sources.push(...collectSources(tokens.slice(i + 1, close), base, ctes))
      return next
    }
    if (!isName(t) || (t.kind === 'word' && (NOT_ALIAS.has(t.text.toUpperCase()) || t.text.toUpperCase() === 'ONLY'))) return i + 1
    let j = i
    const parts: Token[] = [tokens[j]]
    while (tokens[j + 1]?.text === '.' && isName(tokens[j + 2])) {
      parts.push(tokens[j + 2])
      j += 2
    }
    const nameTok = parts[parts.length - 1]
    const schemaTok = parts.length > 1 ? parts[parts.length - 2] : undefined
    j++
    // Table functions (`FROM generate_series(…)`) and their argument lists are skipped.
    const isFunction = tokens[j]?.text === '('
    if (isFunction) j = closing(tokens, j) + 1
    const { alias, next } = readAlias(tokens, j)
    const cte = !schemaTok && ctes.get(nameOf(nameTok).toUpperCase())
    sources.push({
      kind: cte ? 'cte' : isFunction ? 'function' : 'table',
      schema: schemaTok ? nameOf(schemaTok) : undefined,
      name: nameOf(nameTok),
      alias,
      columns: cte || undefined,
      start: base + nameTok.start,
      end: base + nameTok.end
    })
    return next
  }

  for (let i = 0; i < tokens.length; i++) {
    const kw = upper(tokens[i])
    if (kw === 'FROM' || kw === 'JOIN' || kw === 'STRAIGHT_JOIN') {
      // DELETE FROM t / SELECT … FROM a, b JOIN c
      let j = readTable(i + 1)
      while (kw === 'FROM' && tokens[j]?.text === ',') j = readTable(j + 1)
      i = j - 1
    } else if (kw === 'UPDATE' && upper(tokens[i - 1]) !== 'FOR' && upper(tokens[i - 1]) !== 'ON' && upper(tokens[i - 1]) !== 'DO') {
      i = readTable(i + 1) - 1
    } else if (kw === 'INTO' && upper(tokens[i - 1]) !== 'SELECT') {
      // INSERT INTO t, MERGE INTO t (not SELECT … INTO :variables)
      const prev = tokens.slice(0, i).reverse().find((t) => t.kind === 'word')
      if (prev && /^(INSERT|REPLACE|MERGE|IGNORE|UPSERT)$/i.test(prev.text)) i = readTable(i + 1) - 1
    }
  }
  return sources
}

/**
 * Works out what fits at `offset` of the script: the row sources of the statement around it,
 * whether a table, a column or a keyword is expected, and the function call being typed.
 * Tolerates unfinished SQL.
 */
export function analyzeStatement(script: string, offset: number, engine: DbEngine): StatementAnalysis {
  const { start: base, text } = statementSpan(script, engine, offset)
  const rel = offset - base
  const tokens = tokenize(text, engine)

  // Inside a string or comment (an unclosed one reaches the cursor).
  const inside = tokens.find((t) => (t.kind === 'string' || t.kind === 'comment') && t.start < rel && (rel < t.end || (t.open && rel === t.end)))
  if (inside) return { cursor: { kind: 'none' }, sources: [], prefix: '' }

  // The partial name being typed is not part of the context.
  const typing = tokens.find((t) => (t.kind === 'word' || t.kind === 'quoted') && t.start < rel && rel <= t.end)
  const prefix = typing ? text.slice(typing.start, rel).replace(/^["`[]/, '') : ''
  const before = tokens.filter((t) => t.end <= (typing ? typing.start : rel) && t.kind !== 'comment')
  const sources = collectSources(tokens.filter((t) => t.kind !== 'comment'), base)

  // Function call around the cursor: innermost "name(" whose parenthesis is still open.
  let call: FunctionCall | undefined
  const opens: number[] = []
  for (let i = 0; i < before.length; i++) {
    if (before[i].text === '(') opens.push(i)
    else if (before[i].text === ')') opens.pop()
  }
  for (let k = opens.length - 1; k >= 0 && !call; k--) {
    const fn = before[opens[k] - 1]
    if (!isName(fn) || (fn.kind === 'word' && NOT_CALL.has(fn.text.toUpperCase()))) {
      if (upper(before[opens[k] + 1]) === 'SELECT') break
      continue
    }
    let depth = 0
    let argIndex = 0
    for (let i = opens[k] + 1; i < before.length; i++) {
      if (before[i].text === '(') depth++
      else if (before[i].text === ')') depth--
      else if (depth === 0 && before[i].text === ',') argIndex++
    }
    const q = before[opens[k] - 2]?.text === '.' && isName(before[opens[k] - 3]) ? nameOf(before[opens[k] - 3]) : undefined
    call = { name: nameOf(fn), qualifier: q, argIndex }
  }

  // `x.` or `x.y.` right before the cursor.
  const last = before[before.length - 1]
  if (last?.text === '.' && isName(before[before.length - 2])) {
    const q = nameOf(before[before.length - 2])
    const outer = before[before.length - 3]?.text === '.' && isName(before[before.length - 4]) ? nameOf(before[before.length - 4]) : undefined
    const clause = clauseBefore(before, before.length - 2)
    if (clause === 'table' && !outer) return { cursor: { kind: 'table', schema: q }, sources, call, prefix }
    return { cursor: { kind: 'column', qualifier: q, schema: outer, sources }, sources, call, prefix }
  }

  const clause = clauseBefore(before, before.length)
  if (clause === 'table') return { cursor: { kind: 'table' }, sources, call, prefix }
  if (clause === 'column' || call) return { cursor: { kind: 'column', sources }, sources, call, prefix }
  return { cursor: { kind: 'keyword' }, sources, call, prefix }
}

/**
 * What the clause at token index `at` expects, looking back at the same parenthesis depth:
 * "table" right after FROM/JOIN/INTO…, "column" in expression clauses, "keyword" otherwise.
 */
function clauseBefore(tokens: Token[], at: number): 'table' | 'column' | 'keyword' {
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.text === ')') {
      depth++
      continue
    }
    if (t.text === '(') {
      // Inside a parenthesis with no clause keyword yet: function arguments, an INSERT column
      // list or VALUES — all expressions or columns.
      if (depth === 0) return 'column'
      depth--
      continue
    }
    if (depth > 0) continue
    const kw = upper(t)
    if (TABLE_AFTER.has(kw)) {
      // Right after the keyword (or after a comma in the FROM list) a table is expected;
      // after a complete table reference, keywords (WHERE, JOIN, alias…) are.
      const between = tokens.slice(i + 1, at)
      if (!between.length) return kw === 'INTO' && upper(tokens[i - 1]) === 'SELECT' ? 'column' : 'table'
      if (kw === 'FROM' && between[between.length - 1].text === ',') return 'table'
      if (kw === 'UPDATE' && between.some((b) => upper(b) === 'SET')) return 'column'
      return 'keyword'
    }
    if (COLUMN_CLAUSES.has(kw) || t.text === ',' || t.text === '=' || t.text === '<' || t.text === '>' || t.text === '+' || t.text === '-' || t.text === '*' || t.text === '/' || t.text === '||') {
      // A comma inside a FROM list keeps scanning back to FROM.
      if (t.text === ',') {
        for (let j = i - 1; j >= 0; j--) {
          const u = upper(tokens[j])
          if (tokens[j].text === ')' || tokens[j].text === '(') break
          if (u === 'FROM') return 'table'
          if (COLUMN_CLAUSES.has(u) || TABLE_AFTER.has(u)) break
        }
      }
      return 'column'
    }
    if (kw === 'WITH' || kw === 'CREATE' || kw === 'ALTER' || kw === 'DROP') return 'keyword'
  }
  return 'keyword'
}
