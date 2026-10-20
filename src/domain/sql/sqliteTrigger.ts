import type { TriggerEvent, TriggerTiming } from '@shared/model'

export interface ParsedSqliteTrigger {
  name: string
  table: string
  timing: TriggerTiming
  event: TriggerEvent
  /** `UPDATE OF a, b` column list, when present. */
  updateOf?: string
  /** WHEN condition without the keyword. */
  when?: string
  /** The `BEGIN … END` block. */
  body: string
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|\[[^\]]*\]|` + '`(?:[^`]|``)*`' + String.raw`|[\w$]+)`

const HEAD = new RegExp(
  String.raw`^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?(${IDENT})\s+` +
    String.raw`(BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s+(?:${IDENT}\s*\.\s*)?(${IDENT})` +
    String.raw`(?:\s+FOR\s+EACH\s+ROW)?`,
  'i'
)

/** Removes SQLite identifier quoting ("x", [x], `x`). */
export function unquoteSqliteIdent(id: string): string {
  const t = id.trim()
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"')
  if (t.startsWith('`') && t.endsWith('`')) return t.slice(1, -1).replace(/``/g, '`')
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1)
  return t
}

/**
 * Parses the CREATE TRIGGER statement SQLite keeps in sqlite_schema.sql. Returns null when the
 * text does not look like a trigger SQLite would accept (the form then shows it read-only).
 */
export function parseSqliteTrigger(sql: string): ParsedSqliteTrigger | null {
  const m = HEAD.exec(sql)
  if (!m) return null
  const rest = sql.slice(m[0].length)
  const begin = findKeyword(rest, 'BEGIN')
  if (begin < 0) return null
  const whenPart = rest.slice(0, begin).trim()
  const when = /^WHEN\b/i.test(whenPart) ? whenPart.replace(/^WHEN\s+/i, '').trim() : undefined
  if (whenPart && !when) return null
  const timing = (m[2] ?? 'BEFORE').toUpperCase().replace(/\s+/g, ' ') as TriggerTiming
  return {
    name: unquoteSqliteIdent(m[1]),
    table: unquoteSqliteIdent(m[5]),
    timing,
    event: m[3].toUpperCase() as TriggerEvent,
    updateOf: m[4]?.trim() || undefined,
    when,
    body: rest.slice(begin).trim().replace(/;\s*$/, '')
  }
}

/** Offset of a keyword outside strings, quoted identifiers and comments; -1 when absent. */
function findKeyword(s: string, word: string): number {
  const re = new RegExp(String.raw`^${word}\b`, 'i')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const close = s.indexOf(c, i + 1)
      if (close < 0) return -1
      i = close
    } else if (c === '[') {
      const close = s.indexOf(']', i + 1)
      if (close < 0) return -1
      i = close
    } else if (c === '-' && s[i + 1] === '-') {
      const eol = s.indexOf('\n', i)
      if (eol < 0) return -1
      i = eol
    } else if (c === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2)
      if (close < 0) return -1
      i = close + 1
    } else if (!/[\w$]/.test(s[i - 1] ?? '') && re.test(s.slice(i, i + word.length + 1))) {
      return i
    }
  }
  return -1
}
