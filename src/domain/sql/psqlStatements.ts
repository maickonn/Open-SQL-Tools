import type { RoutineOperation } from '@shared/model'

/**
 * Finds the DML statements inside a Firebird PSQL body (trigger, procedure, function) and
 * rewrites each one so it can be prepared on its own: NEW./OLD. columns, :variables and
 * declared variables / parameters become `?`, and PSQL-only INTO clauses are removed.
 */

interface Token {
  kind: 'word' | 'ident' | 'string' | 'number' | 'param' | 'punct'
  text: string
  /** Upper-cased text for words. */
  upper: string
  start: number
  end: number
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? n : close + 2
      continue
    }
    const start = i
    if (c === "'" || c === '"') {
      i++
      while (i < n) {
        if (src[i] === c) {
          if (src[i + 1] === c) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      const text = src.slice(start, i)
      out.push({ kind: c === "'" ? 'string' : 'ident', text, upper: text, start, end: i })
      continue
    }
    if (c === ':' && /[A-Za-z_"]/.test(src[i + 1] ?? '')) {
      i++
      if (src[i] === '"') {
        i++
        while (i < n && src[i] !== '"') i++
        i++
      } else while (i < n && /[\w$]/.test(src[i])) i++
      const text = src.slice(start, i)
      out.push({ kind: 'param', text, upper: text.toUpperCase(), start, end: i })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[\w$]/.test(src[i])) i++
      const text = src.slice(start, i)
      out.push({ kind: 'word', text, upper: text.toUpperCase(), start, end: i })
      continue
    }
    if (/\d/.test(c)) {
      while (i < n && /[\d.]/.test(src[i])) i++
      out.push({ kind: 'number', text: src.slice(start, i), upper: '', start, end: i })
      continue
    }
    i++
    out.push({ kind: 'punct', text: c, upper: c, start, end: i })
  }
  return out
}

const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH'])
/** Tokens after which a DML keyword starts a PSQL statement (rather than a trigger event or a subquery). */
const STATEMENT_BOUNDARY = new Set([';', 'BEGIN', 'THEN', 'ELSE', 'DO', 'AS', 'FOR', 'END'])

const identName = (t: Token): string => (t.kind === 'ident' ? t.text.slice(1, -1).replace(/""/g, '"') : t.text)

/** Names of declared variables and routine parameters (they are referenced without a colon in PSQL). */
function localNames(tokens: Token[]): Set<string> {
  const names = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.upper === 'DECLARE') {
      let j = i + 1
      if (tokens[j]?.upper === 'VARIABLE') j++
      if (tokens[j] && (tokens[j].kind === 'word' || tokens[j].kind === 'ident')) names.add(identName(tokens[j]).toUpperCase())
    }
    // Declarations precede the main block.
    if (t.upper === 'BEGIN') break
  }
  // Parameter lists in the header: "PROCEDURE p (a INTEGER, b VARCHAR(10)) RETURNS (c INTEGER)".
  const headerEnd = tokens.findIndex((t) => t.upper === 'AS')
  const header = headerEnd < 0 ? [] : tokens.slice(0, headerEnd)
  let depth = 0
  for (let i = 0; i < header.length; i++) {
    const t = header[i]
    if (t.text === '(') {
      depth++
      if (depth === 1) {
        const next = header[i + 1]
        if (next && (next.kind === 'word' || next.kind === 'ident')) names.add(identName(next).toUpperCase())
      }
    } else if (t.text === ')') depth--
    else if (t.text === ',' && depth === 1) {
      const next = header[i + 1]
      if (next && (next.kind === 'word' || next.kind === 'ident')) names.add(identName(next).toUpperCase())
    }
  }
  return names
}

function operationOf(tokens: Token[]): RoutineOperation['operation'] {
  const first = tokens[0].upper
  if (first === 'UPDATE' && tokens[1]?.upper === 'OR' && tokens[2]?.upper === 'INSERT') return 'upsert'
  if (first === 'WITH') return 'select'
  return first.toLowerCase() as RoutineOperation['operation']
}

/** First table the statement reads or writes. */
function targetTable(tokens: Token[], op: RoutineOperation['operation']): string | undefined {
  const after = (keyword: string): string | undefined => {
    const i = tokens.findIndex((t) => t.upper === keyword)
    const next = i >= 0 ? tokens[i + 1] : undefined
    return next && (next.kind === 'word' || next.kind === 'ident') ? identName(next) : undefined
  }
  switch (op) {
    case 'select':
      return after('FROM')
    case 'insert':
    case 'merge':
    case 'upsert':
      return after('INTO')
    case 'update':
      return tokens[1] && (tokens[1].kind === 'word' || tokens[1].kind === 'ident') ? identName(tokens[1]) : undefined
    case 'delete':
      return after('FROM')
  }
}

/** Rewrites one statement into SQL that can be prepared outside the routine. */
function preparable(src: string, tokens: Token[], locals: Set<string>, op: RoutineOperation['operation']): string {
  const drop = new Set<number>()
  const replace = new Map<number, string>()
  let depth = 0
  let afterReturning = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.text === '(') depth++
    else if (t.text === ')') depth--
    if (depth === 0 && t.upper === 'RETURNING') afterReturning = true
    // PSQL "INTO :a, :b" target lists (SELECT … INTO, RETURNING … INTO).
    if (depth === 0 && t.upper === 'INTO' && (op === 'select' || afterReturning)) {
      drop.add(i)
      let j = i + 1
      while (j < tokens.length) {
        const v = tokens[j]
        if (v.kind === 'param' || v.kind === 'word' || v.kind === 'ident' || (v.text === '.' && j > i + 1)) {
          if (v.kind === 'word' && /^(FROM|WHERE|GROUP|ORDER|ROWS|UNION|PLAN|DO|WITH)$/.test(v.upper)) break
          drop.add(j++)
          continue
        }
        if (v.text === ',') {
          drop.add(j++)
          continue
        }
        break
      }
      i = j - 1
      continue
    }
    if (t.kind === 'param') replace.set(i, '?')
    else if ((t.upper === 'NEW' || t.upper === 'OLD') && tokens[i + 1]?.text === '.' && tokens[i + 2]) {
      replace.set(i, '?')
      drop.add(i + 1)
      drop.add(i + 2)
      i += 2
    } else if ((t.kind === 'word' || t.kind === 'ident') && locals.has(identName(t).toUpperCase()) && tokens[i - 1]?.text !== '.' && tokens[i + 1]?.text !== '.') {
      replace.set(i, '?')
    }
  }
  let out = ''
  let pos = tokens[0].start
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (drop.has(i)) {
      out += src.slice(pos, t.start)
      pos = t.end
      continue
    }
    const r = replace.get(i)
    if (r !== undefined) {
      out += src.slice(pos, t.start) + r
      pos = t.end
    }
  }
  out += src.slice(pos, tokens[tokens.length - 1].end)
  return out.replace(/[ \t]+,/g, ',').replace(/[ \t]{2,}/g, ' ').trim()
}

export interface ExtractedStatement extends Omit<RoutineOperation, 'plan' | 'error'> {
  /** Statement rewritten for a standalone prepare. */
  sql: string
}

export function extractDmlStatements(source: string): ExtractedStatement[] {
  const tokens = tokenize(source)
  const locals = localNames(tokens)
  const body = tokens.findIndex((t) => t.upper === 'AS')
  const out: ExtractedStatement[] = []
  for (let i = Math.max(0, body); i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'word' || !DML.has(t.upper)) continue
    const prev = tokens[i - 1]
    if (prev && !STATEMENT_BOUNDARY.has(prev.upper)) continue
    if (prev?.upper === 'FOR' && t.upper !== 'SELECT' && t.upper !== 'WITH') continue
    // The statement ends at ";" (or "DO" for FOR SELECT loops) outside parentheses.
    const forLoop = prev?.upper === 'FOR'
    let depth = 0
    let j = i
    for (; j < tokens.length; j++) {
      const u = tokens[j]
      if (u.text === '(') depth++
      else if (u.text === ')') depth--
      else if (depth === 0 && (u.text === ';' || (forLoop && u.upper === 'DO'))) break
    }
    const stmt = tokens.slice(i, j)
    if (stmt.length < 2) continue
    const op = operationOf(stmt)
    out.push({
      operation: op,
      table: targetTable(stmt, op),
      statement: source.slice(stmt[0].start, stmt[stmt.length - 1].end).trim(),
      sql: preparable(source, stmt, locals, op)
    })
    i = j
  }
  return out
}
