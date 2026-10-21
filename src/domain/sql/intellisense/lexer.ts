import type { DbEngine } from '@shared/model'

export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'comment' | 'param' | 'punct'

export interface Token {
  kind: TokenKind
  /** Source text, quotes included. */
  text: string
  start: number
  /** Exclusive. */
  end: number
  /** Identifier without quotes (words and quoted identifiers). */
  value?: string
  /** A string, comment or quoted identifier that reaches the end of the text unclosed. */
  open?: boolean
}

const WORD_START = /[\p{L}_]/u
const WORD_CHAR = /[\p{L}\p{N}_$]/u

/**
 * Tokenizes SQL for editor features: strings, comments and quoted identifiers per dialect
 * (MySQL backticks and backslash escapes, PostgreSQL E'' and dollar quoting, SQLite [names]).
 * Never throws: unclosed constructs run to the end of the text (the user is typing).
 */
export function tokenize(sql: string, engine: DbEngine): Token[] {
  const isMy = engine === 'mysql' || engine === 'mariadb'
  const isPg = engine === 'postgres'
  const isLite = engine === 'sqlite'
  const out: Token[] = []
  const n = sql.length
  let i = 0

  const push = (kind: TokenKind, start: number, end: number, extra: Partial<Token> = {}): void => {
    out.push({ kind, text: sql.slice(start, end), start, end, ...extra })
  }
  /** Index after the closing quote, or -1 when unclosed. */
  const closeQuote = (from: number, quote: string, backslash: boolean): number => {
    let j = from + 1
    while (j < n) {
      const ch = sql[j]
      if (backslash && ch === '\\') {
        j += 2
        continue
      }
      if (ch === quote) {
        if (sql[j + 1] === quote) {
          j += 2
          continue
        }
        return j + 1
      }
      j++
    }
    return -1
  }

  while (i < n) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const start = i
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && isMy)) {
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? n : eol
      push('comment', start, i, { open: eol === -1 })
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      push('comment', start, i, { open: close === -1 })
      continue
    }
    if (ch === "'" || (ch === '"' && isMy)) {
      const backslash = isMy || (isPg && (sql[i - 1] === 'E' || sql[i - 1] === 'e'))
      const end = closeQuote(i, ch, backslash)
      i = end === -1 ? n : end
      push('string', start, i, { open: end === -1 })
      continue
    }
    if (isPg && ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        push('string', start, i, { open: close === -1 })
        continue
      }
    }
    if (ch === '"' || (ch === '`' && (isMy || isLite)) || (ch === '[' && isLite)) {
      const quote = ch === '[' ? ']' : ch
      const end = ch === '[' ? (sql.indexOf(']', i + 1) === -1 ? -1 : sql.indexOf(']', i + 1) + 1) : closeQuote(i, quote, false)
      i = end === -1 ? n : end
      const inner = sql.slice(start + 1, end === -1 ? n : i - 1)
      push('quoted', start, i, { value: ch === '[' ? inner : inner.split(quote + quote).join(quote), open: end === -1 })
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      i++
      while (i < n && /[0-9a-zA-Z_.]/.test(sql[i])) i++
      push('number', start, i)
      continue
    }
    if (WORD_START.test(ch)) {
      i++
      while (i < n && WORD_CHAR.test(sql[i])) i++
      push('word', start, i, { value: sql.slice(start, i) })
      continue
    }
    if (ch === '?' || ((ch === ':' || ch === '@' || ch === '$') && WORD_CHAR.test(sql[i + 1] ?? '') && sql[i - 1] !== ':')) {
      i++
      while (i < n && WORD_CHAR.test(sql[i])) i++
      push('param', start, i)
      continue
    }
    if (ch === ':' && sql[i + 1] === ':') {
      i += 2
      push('punct', start, i)
      continue
    }
    i++
    push('punct', start, i)
  }
  return out
}

/** Identifier tokens: plain words and quoted names. */
export const isName = (t: Token | undefined): t is Token => !!t && (t.kind === 'word' || t.kind === 'quoted')
