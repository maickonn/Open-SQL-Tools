import type { DbEngine } from '@shared/model'

/**
 * Engines whose connection is bound to a single database (Firebird attachment, SQLite file):
 * there is no database list to browse and no switching between databases.
 */
export function isSingleDatabase(engine: DbEngine | undefined): boolean {
  return engine === 'firebird' || engine === 'sqlite'
}

/** Engines that open a local file instead of a network server (no host, port, user, SSH or SSL). */
export function isFileBased(engine: DbEngine | undefined): boolean {
  return engine === 'sqlite'
}

/** Engines whose DDL runs inside transactions (a failed multi-statement change rolls back). */
export function hasTransactionalDdl(engine: DbEngine | undefined): boolean {
  return engine === 'firebird' || engine === 'postgres' || engine === 'sqlite'
}

/** Engines with table options to change in bulk (engine, charset, collation, schema, owner). */
export function hasBulkTableOptions(engine: DbEngine | undefined): boolean {
  return engine === 'mysql' || engine === 'mariadb' || engine === 'postgres'
}
