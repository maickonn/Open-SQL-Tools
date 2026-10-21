import type { DbEngine } from '@shared/model'
import { splitSql } from '../splitter'
import { collectSources, type SourceRef } from './context'
import { isName, tokenize } from './lexer'

/**
 * What the editor knows about the database. `table` returns the table (columns when loaded),
 * `null` when the loaded catalog has no such table, and `undefined` when it cannot tell yet.
 */
export interface CatalogLookup {
  table(schema: string | undefined, name: string): { columns?: string[] } | null | undefined
}

export interface Diagnostic {
  code: 'unknownTable' | 'unknownColumn'
  start: number
  end: number
  name: string
  table?: string
}

/** Statements whose table and column references are checked (DDL and routine bodies are not). */
const CHECKED = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/i

const same = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()

/** The source a qualifier (alias or table name) refers to. */
export function resolveQualifier(sources: SourceRef[], qualifier: string, schema?: string): SourceRef | undefined {
  return (
    sources.find((s) => s.alias && same(s.alias, qualifier)) ??
    sources.find((s) => !s.alias && same(s.name, qualifier) && (!schema || (s.schema && same(s.schema, schema)))) ??
    sources.find((s) => same(s.name, qualifier) && (!schema || (s.schema && same(s.schema, schema))))
  )
}

/**
 * Flags only what is certain: tables missing from the loaded catalog, and `alias.column`
 * references to columns the aliased table doesn't have.
 */
export function diagnose(script: string, engine: DbEngine, catalog: CatalogLookup): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const stmt of splitSql(script, engine)) {
    if (!CHECKED.test(stmt.sql)) continue
    const tokens = tokenize(stmt.sql, engine).filter((t) => t.kind !== 'comment')
    const sources = collectSources(tokens, stmt.start)
    const sourceStarts = new Set(sources.map((s) => s.start))

    for (const s of sources) {
      if (s.kind === 'table' && catalog.table(s.schema, s.name) === null) out.push({ code: 'unknownTable', start: s.start, end: s.end, name: s.name })
    }

    for (let i = 0; i + 2 < tokens.length; i++) {
      const q = tokens[i]
      const col = tokens[i + 2]
      if (!isName(q) || tokens[i + 1].text !== '.' || !isName(col)) continue
      // schema.table in FROM, function calls, three-part names and alias.* are not column references.
      if (sourceStarts.has(stmt.start + col.start) || tokens[i + 3]?.text === '(' || tokens[i + 3]?.text === '.' || tokens[i - 1]?.text === '.') continue
      const source = resolveQualifier(sources, q.value ?? q.text)
      if (source?.kind !== 'table') continue
      const columns = catalog.table(source.schema, source.name)?.columns
      const name = col.value ?? col.text
      if (columns && !columns.some((c) => same(c, name))) {
        out.push({ code: 'unknownColumn', start: stmt.start + col.start, end: stmt.start + col.end, name, table: source.name })
      }
      i += 2
    }
  }
  return out
}
