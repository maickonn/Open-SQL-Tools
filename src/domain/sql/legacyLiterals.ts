import type { DbEngine } from '@shared/model'
import { collectSources, type SourceRef } from './intellisense/context'
import { resolveQualifier } from './intellisense/diagnostics'
import { isName, tokenize, type Token } from './intellisense/lexer'
import { encodeText, type TextEncodingId } from '../text/legacyText'

/**
 * Text literals the user types reach Firebird as UTF-8, while CHARACTER SET NONE columns hold their
 * text in whatever encoding wrote it. Literals compared with such a column are expanded to every
 * encoding the column holds (`col = 'ção'` → `col IN ('ção', x'E7E36F')`), and literals stored in
 * one are written in the column's encoding. Nothing else in the statement changes.
 */

/** Statements whose literals are rewritten: queries and DML, never DDL or PSQL bodies. */
const REWRITTEN = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/i

export interface LegacyColumn {
  name: string
  /** CHARACTER SET NONE text. */
  none: boolean
}

/** A table's columns, or undefined when the table is unknown. */
export type ColumnsOf = (table: string) => LegacyColumn[] | undefined

interface Site {
  table: string
  column: string
  /** Literal tokens (comparison operands or IN-list items) and what to do with them. */
  kind: 'in' | 'pattern' | 'assign'
  negated: boolean
  /** Replaced range of the statement and how it was written. */
  start: number
  end: number
  /** For `in` and `pattern`: the column reference as written. */
  ref?: string
  /** For `pattern`: operator words as written (`LIKE`, `NOT CONTAINING`…) and the ESCAPE clause. */
  op?: string
  escape?: string
  literals: Token[]
}

export interface LiteralEncodings {
  /** Encodings a stored value may use (the literal's UTF-8 is always included). */
  match: TextEncodingId[]
  /** Encoding new text is stored in. */
  write: TextEncodingId
}

const upper = (t: Token | undefined): string => (t && t.kind === 'word' ? t.text.toUpperCase() : '')
const nonAscii = (t: Token): boolean => t.kind === 'string' && /[^\x00-\x7f]/.test(t.text)
/** Content of a '…' literal ('' unescaped); undefined for other string forms (introducers, N'…'). */
function literalValue(t: Token): string | undefined {
  if (t.kind !== 'string' || !t.text.startsWith("'") || !t.text.endsWith("'") || t.open) return undefined
  return t.text.slice(1, -1).replace(/''/g, "'")
}

/** Tables the statements read or write, for loading their columns before rewriting. */
export function legacyLiteralTables(sql: string, engine: DbEngine): string[] {
  if (!REWRITTEN.test(sql) || !/'[^']*[^\x00-\x7f]/.test(sql)) return []
  const tokens = tokenize(sql, engine).filter((t) => t.kind !== 'comment')
  // `INSERT INTO t (cols)` reads like a function call to the source collector.
  return [...new Set(collectSources(tokens).filter((s) => s.kind === 'table' || s.kind === 'function').map((s) => s.name))]
}

/** A column reference ending right before `i` (`col`, `alias.col`, `"Col"`): its tokens and start. */
function columnBefore(tokens: Token[], i: number): { qualifier?: string; name: string; first: number } | null {
  const name = tokens[i - 1]
  if (!isName(name) || (name.kind === 'word' && /^(AND|OR|NOT|WHERE|ON|SET|WHEN|THEN|ELSE|HAVING)$/i.test(name.text))) return null
  if (tokens[i - 2]?.text === '.' && isName(tokens[i - 3])) return { qualifier: tokens[i - 3].value, name: name.value!, first: i - 3 }
  return { name: name.value!, first: i - 1 }
}

/** A column reference starting at `i`: its tokens and the index after it. */
function columnAt(tokens: Token[], i: number): { qualifier?: string; name: string; next: number } | null {
  if (!isName(tokens[i])) return null
  if (tokens[i + 1]?.text === '.' && isName(tokens[i + 2])) return { qualifier: tokens[i].value, name: tokens[i + 2].value!, next: i + 3 }
  return { name: tokens[i].value!, next: i + 1 }
}

/** Finds rewritable literals in one statement. */
function findSites(sql: string, engine: DbEngine, columnsOf: ColumnsOf): Site[] {
  if (!REWRITTEN.test(sql)) return []
  const tokens = tokenize(sql, engine).filter((t) => t.kind !== 'comment')
  const sources = collectSources(tokens)
  const tables = sources.filter((s) => s.kind === 'table')

  const resolve = (qualifier: string | undefined, name: string): { table: string; column: string } | null => {
    const candidates: SourceRef[] = qualifier ? [resolveQualifier(sources, qualifier)].filter((s): s is SourceRef => !!s) : tables
    const matches = candidates.flatMap((s) => {
      if (s.kind !== 'table') return []
      const col = columnsOf(s.name)?.find((c) => c.name.toUpperCase() === name.toUpperCase())
      return col ? [{ table: s.name, column: col }] : []
    })
    // An unqualified name must belong to exactly one table.
    if (matches.length !== 1 || !matches[0].column.none) return null
    return { table: matches[0].table, column: matches[0].column.name }
  }

  const sites: Site[] = []
  const text = (from: number, to: number): string => sql.slice(tokens[from].start, tokens[to].end)
  let inSet = false
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.text === '(') depth++
    else if (t.text === ')') depth--
    const word = upper(t)
    if (word === 'SET' && depth === 0) inSet = true
    else if ((word === 'WHERE' || word === 'RETURNING') && depth === 0) inSet = false

    // col = 'x' / col <> 'x' / col != 'x' (or an assignment in UPDATE … SET).
    const eq = t.text === '='
    const ne = (t.text === '<' && tokens[i + 1]?.text === '>') || (t.text === '!' && tokens[i + 1]?.text === '=')
    if (eq || ne) {
      const lit = tokens[i + (ne ? 2 : 1)]
      const col = columnBefore(tokens, i)
      if (col && lit && nonAscii(lit) && literalValue(lit) !== undefined && tokens[i - 1].text !== '<' && tokens[i - 1].text !== '>' && tokens[i - 1].text !== '!') {
        const target = resolve(col.qualifier, col.name)
        if (target) {
          const assign = eq && inSet && depth === 0
          sites.push(
            assign
              ? { ...target, kind: 'assign', negated: false, start: lit.start, end: lit.end, literals: [lit] }
              : { ...target, kind: 'in', negated: ne, start: tokens[col.first].start, end: lit.end, ref: text(col.first, i - 1), literals: [lit] }
          )
        }
      }
      // 'x' = col
      const before = tokens[i - 1]
      if (eq && before && nonAscii(before) && literalValue(before) !== undefined && !(inSet && depth === 0)) {
        const after = columnAt(tokens, i + 1)
        const target = after && resolve(after.qualifier, after.name)
        if (after && target) sites.push({ ...target, kind: 'in', negated: false, start: before.start, end: tokens[after.next - 1].end, ref: text(i + 1, after.next - 1), literals: [before] })
      }
      continue
    }

    // col [NOT] IN ('a', 'b')
    if (word === 'IN' && tokens[i + 1]?.text === '(') {
      const negated = upper(tokens[i - 1]) === 'NOT'
      const col = columnBefore(tokens, negated ? i - 1 : i)
      const close = tokens.findIndex((x, k) => k > i + 1 && x.text === ')')
      const items = close > 0 ? tokens.slice(i + 2, close).filter((x) => x.text !== ',') : []
      const literalList = items.length > 0 && items.every((x) => x.kind === 'string' && literalValue(x) !== undefined) && close === i + 2 + items.length * 2 - 1
      if (col && literalList && items.some(nonAscii)) {
        const target = resolve(col.qualifier, col.name)
        if (target) sites.push({ ...target, kind: 'in', negated, start: tokens[col.first].start, end: tokens[close].end, ref: text(col.first, (negated ? i - 2 : i - 1)), literals: items })
      }
      continue
    }

    // col [NOT] LIKE 'p' [ESCAPE 'e'] / [NOT] CONTAINING 'p' / [NOT] STARTING [WITH] 'p'
    if (word === 'LIKE' || word === 'CONTAINING' || word === 'STARTING') {
      const negated = upper(tokens[i - 1]) === 'NOT'
      let j = i + 1
      if (word === 'STARTING' && upper(tokens[j]) === 'WITH') j++
      const lit = tokens[j]
      const col = columnBefore(tokens, negated ? i - 1 : i)
      if (col && lit && nonAscii(lit) && literalValue(lit) !== undefined) {
        const target = resolve(col.qualifier, col.name)
        if (target) {
          let end = lit.end
          let escape: string | undefined
          if (word === 'LIKE' && upper(tokens[j + 1]) === 'ESCAPE' && tokens[j + 2]?.kind === 'string') {
            escape = text(j + 1, j + 2)
            end = tokens[j + 2].end
          }
          sites.push({ ...target, kind: 'pattern', negated, start: tokens[col.first].start, end, ref: text(col.first, (negated ? i - 2 : i - 1)), op: text(negated ? i - 1 : i, j - 1), escape, literals: [lit] })
        }
      }
      continue
    }
  }

  // INSERT [OR UPDATE] INTO t (c1, c2) VALUES ('a', 'b') and UPDATE OR INSERT INTO …
  const into = tokens.findIndex((x) => upper(x) === 'INTO')
  if (into >= 0 && /^\s*(INSERT|UPDATE\s+OR\s+INSERT|MERGE)\b/i.test(sql) && isName(tokens[into + 1])) {
    let k = into + 2
    let table = tokens[into + 1].value!
    if (tokens[k]?.text === '.' && isName(tokens[k + 1])) {
      table = tokens[k + 1].value!
      k += 2
    }
    if (table && tokens[k]?.text === '(') {
      const closeCols = tokens.findIndex((x, n) => n > k && x.text === ')')
      const names = tokens.slice(k + 1, closeCols).filter(isName).map((x) => x.value!)
      if (upper(tokens[closeCols + 1]) === 'VALUES' && tokens[closeCols + 2]?.text === '(') {
        // Values split at top-level commas; only single literals are rewritten.
        const groups: Token[][] = [[]]
        let d = 0
        let n = closeCols + 3
        for (; n < tokens.length; n++) {
          const x = tokens[n]
          if (x.text === '(') d++
          if (x.text === ')') {
            if (d === 0) break
            d--
          }
          if (x.text === ',' && d === 0) groups.push([])
          else groups[groups.length - 1].push(x)
        }
        groups.forEach((g, idx) => {
          const lit = g[0]
          if (g.length !== 1 || !nonAscii(lit) || literalValue(lit) === undefined || !names[idx]) return
          const col = columnsOf(table)?.find((c) => c.name.toUpperCase() === names[idx].toUpperCase())
          if (col?.none) sites.push({ table, column: col.name, kind: 'assign', negated: false, start: lit.start, end: lit.end, literals: [lit] })
        })
      }
    }
  }
  return sites.sort((a, b) => a.start - b.start)
}

/** Columns whose encodings the rewrite needs. */
export function legacyLiteralColumns(sql: string, engine: DbEngine, columnsOf: ColumnsOf): { table: string; column: string }[] {
  const seen = new Map<string, { table: string; column: string }>()
  for (const s of findSites(sql, engine, columnsOf)) seen.set(`${s.table}.${s.column}`, { table: s.table, column: s.column })
  return [...seen.values()]
}

/**
 * Rewrites the literals of one statement. `hex` renders bytes as the dialect's binary literal.
 * Throws when typed text can't be stored in its column's encoding.
 */
export function rewriteLegacyLiterals(
  sql: string,
  engine: DbEngine,
  columnsOf: ColumnsOf,
  encodings: (table: string, column: string) => LiteralEncodings,
  hex: (bytes: Uint8Array) => string
): string {
  const sites = findSites(sql, engine, columnsOf)
  if (!sites.length) return sql
  let out = ''
  let at = 0
  for (const site of sites) {
    if (site.start < at) continue // overlapping matches: keep the first
    const enc = encodings(site.table, site.column)
    /** The literal plus its forms in the column's other encodings. */
    const variants = (lit: Token): string[] => {
      const value = literalValue(lit)!
      const forms = [lit.text]
      // ASCII text has the same bytes in every encoding.
      if (!/[^\x00-\x7f]/.test(value)) return forms
      for (const e of enc.match) {
        if (e === 'utf8') continue
        const bytes = encodeText(value, e)
        const form = bytes && hex(bytes)
        if (form && !forms.includes(form)) forms.push(form)
      }
      return forms
    }
    let replacement: string
    if (site.kind === 'assign') {
      const value = literalValue(site.literals[0])!
      if (enc.write === 'utf8') continue
      const bytes = encodeText(value, enc.write)
      if (!bytes) throw new Error(`${site.table}.${site.column} stores its text as ${enc.write}, which can't represent some characters of '${value}'.`)
      replacement = hex(bytes)
    } else if (site.kind === 'in') {
      const forms = site.literals.flatMap(variants)
      replacement = `${site.ref} ${site.negated ? 'NOT IN' : 'IN'} (${forms.join(', ')})`
    } else {
      const forms = variants(site.literals[0])
      const escape = site.escape ? ` ${site.escape}` : ''
      replacement = `(${forms.map((f) => `${site.ref} ${site.op} ${f}${escape}`).join(site.negated ? ' AND ' : ' OR ')})`
    }
    out += sql.slice(at, site.start) + replacement
    at = site.end
  }
  return out + sql.slice(at)
}
