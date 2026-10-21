import type { CatalogColumn, CatalogRoutine, DbEngine, DbObjectInfo } from '@shared/model'
import type { CatalogLookup, SourceRef } from '@domain/sql/intellisense'
import { isSingleDatabase } from '@domain/engineTraits'
import type { SessionClient } from '../gateways/sessionClient'

/** Catalog of one database/schema, loaded with one batch call each (columns, routines). */
interface Scope {
  /** Columns by upper-cased table name, in table order. */
  tables?: Map<string, { name: string; columns: CatalogColumn[] }>
  routines?: Map<string, CatalogRoutine>
  loading?: Promise<void>
}

const scopes = new Map<string, Scope>()
const schemaLists = new Map<string, Promise<string[]>>()

/** Drops what the editor knows about a session (after DDL, a tree refresh or on close). */
export function invalidateCatalog(sessionId: string): void {
  for (const key of [...scopes.keys(), ...schemaLists.keys()]) {
    if (key.startsWith(`${sessionId}|`)) {
      scopes.delete(key)
      schemaLists.delete(key)
    }
  }
}

export interface SqlCatalog extends CatalogLookup {
  engine: DbEngine
  /** Schema of unqualified names (PostgreSQL `public`), undefined elsewhere. */
  defaultSchema?: string
  quote(name: string): string
  /** Loads the catalog of the default scope and of the given qualifiers (schemas or MySQL databases). */
  ensure(qualifiers?: (string | undefined)[]): Promise<void>
  /** Tables and views of a scope, once loaded. */
  tables(qualifier?: string): { name: string; kind?: string; columns: CatalogColumn[] }[]
  /** Schemas (PostgreSQL) or databases (MySQL/MariaDB) a name can be qualified with. */
  qualifiers(): Promise<string[]>
  columnsOf(source: SourceRef): CatalogColumn[] | undefined
  routine(name: string, qualifier?: string): CatalogRoutine | undefined
  routines(qualifier?: string): CatalogRoutine[]
}

/** System relations that never appear in the user catalog but are valid in queries. */
const SYSTEM_NAME: Partial<Record<DbEngine, RegExp>> = {
  firebird: /^(RDB|MON|SEC)\$/i,
  sqlite: /^(sqlite_|pragma_)/i
}

export function quoteFor(engine: DbEngine, name: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`'
  if (engine === 'postgres') return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
  // SQLite identifiers are case-insensitive: only unusual names need quotes.
  if (engine === 'sqlite') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
  return /^[A-Z][A-Z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/**
 * The SQL editor's view of a session's catalog for the tab's database. Data loads once per
 * scope and stays in memory until `invalidateCatalog`; `objects` (the tree's cache) only adds kinds.
 */
export function catalogFor(sessionId: string, client: SessionClient, engine: DbEngine, database: string | undefined, objects: DbObjectInfo[]): SqlCatalog {
  const isMy = engine === 'mysql' || engine === 'mariadb'
  const isPg = engine === 'postgres'
  const db = isSingleDatabase(engine) ? undefined : database
  const defaultSchema = isPg ? 'public' : undefined
  const kinds = new Map(objects.map((o) => [`${(o.schema ?? o.database ?? '').toUpperCase()}|${o.name.toUpperCase()}`, o.kind]))

  /** A qualifier is a schema on PostgreSQL and a database on MySQL; other engines have neither. */
  const scopeOf = (qualifier?: string): { key: string; database?: string; schema?: string } | undefined => {
    if (qualifier && !isPg && !isMy) return undefined
    const d = isMy ? (qualifier ?? db) : db
    const s = isPg ? (qualifier ?? defaultSchema) : undefined
    if (isMy && !d) return undefined
    return { key: `${sessionId}|${d ?? ''}|${s ?? ''}`, database: d, schema: s }
  }

  const load = (qualifier?: string): Promise<void> => {
    const scope = scopeOf(qualifier)
    if (!scope) return Promise.resolve()
    let entry = scopes.get(scope.key)
    if (entry?.tables && entry.routines) return Promise.resolve()
    if (entry?.loading) return entry.loading
    entry = {}
    scopes.set(scope.key, entry)
    const target = entry
    const p = { database: scope.database, schema: scope.schema }
    target.loading = Promise.all([client.call('listColumns', p), client.call('listRoutines', p).catch(() => [] as CatalogRoutine[])])
      .then(([columns, routines]) => {
        const tables = new Map<string, { name: string; columns: CatalogColumn[] }>()
        for (const c of columns) {
          const k = c.table.toUpperCase()
          const t = tables.get(k) ?? tables.set(k, { name: c.table, columns: [] }).get(k)!
          t.columns.push(c)
        }
        target.tables = tables
        target.routines = new Map(routines.map((r) => [r.name.toUpperCase(), r]))
      })
      // A failed load is forgotten so the next request retries it.
      .catch(() => {
        if (scopes.get(scope.key) === target) scopes.delete(scope.key)
      })
      .finally(() => {
        target.loading = undefined
      })
    return target.loading
  }

  const loaded = (qualifier?: string): Scope | undefined => {
    const scope = scopeOf(qualifier)
    return scope && scopes.get(scope.key)
  }

  const findTable = (schema: string | undefined, name: string): { name: string; columns: CatalogColumn[] } | null | undefined => {
    if (SYSTEM_NAME[engine]?.test(name)) return undefined
    const scope = loaded(schema)
    if (!scope?.tables || !scope.routines) return undefined
    const t = scope.tables.get(name.toUpperCase())
    if (t) return t
    // Selectable procedures (Firebird) and unqualified names on PostgreSQL's search path
    // (pg_catalog, other schemas) are not errors.
    if (scope.routines.has(name.toUpperCase())) return undefined
    if (isPg && !schema) return undefined
    return null
  }

  return {
    engine,
    defaultSchema,
    quote: (name) => quoteFor(engine, name),
    async ensure(qualifiers = []) {
      await Promise.all([load(), ...[...new Set(qualifiers.filter(Boolean))].map((q) => load(q))])
    },
    tables(qualifier) {
      const scope = loaded(qualifier)
      const key = (qualifier ?? defaultSchema ?? db ?? '').toUpperCase()
      return [...(scope?.tables?.values() ?? [])].map((t) => ({ ...t, kind: kinds.get(`${key}|${t.name.toUpperCase()}`) ?? kinds.get(`|${t.name.toUpperCase()}`) }))
    },
    qualifiers() {
      if (!isPg && !isMy) return Promise.resolve([])
      const key = `${sessionId}|${isPg ? (db ?? '') : ''}|#schemas`
      let p = schemaLists.get(key)
      if (!p) {
        p = (isPg ? client.call('listSchemas', { database: db }) : client.call('listDatabases', undefined)).catch(() => {
          schemaLists.delete(key)
          return [] as string[]
        })
        schemaLists.set(key, p)
      }
      return p
    },
    table(schema, name) {
      const t = findTable(schema, name)
      return t === undefined || t === null ? t : { columns: t.columns.map((c) => c.name) }
    },
    columnsOf(source) {
      if (source.kind === 'cte' || source.kind === 'subquery') {
        return source.columns?.map((name) => ({ table: source.alias ?? source.name, name, type: '', nullable: true, primaryKey: false }))
      }
      if (source.kind !== 'table') return undefined
      return findTable(source.schema, source.name)?.columns
    },
    routine(name, qualifier) {
      return loaded(qualifier)?.routines?.get(name.toUpperCase())
    },
    routines(qualifier) {
      return [...(loaded(qualifier)?.routines?.values() ?? [])]
    }
  }
}
