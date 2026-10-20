import { stripLeadingComments } from './splitter'

export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction' | 'session' | 'unknown'

const READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'HELP', 'CHECKSUM'])
const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'CALL', 'EXECUTE', 'EXEC', 'LOAD', 'COPY', 'HANDLER', 'DO', 'LOCK', 'UNLOCK', 'KILL', 'FLUSH', 'RESET', 'PURGE', 'INSTALL', 'UNINSTALL', 'OPTIMIZE', 'REPAIR', 'ANALYZE', 'VACUUM', 'CLUSTER', 'REINDEX', 'REFRESH', 'NOTIFY', 'LISTEN', 'PREPARE', 'DEALLOCATE', 'IMPORT', 'CACHE', 'CHECKPOINT', 'DISCARD'])
const DDL = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMENT', 'RECREATE', 'SECURITY', 'DECLARE'])
const TRANSACTION = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'START', 'SAVEPOINT', 'RELEASE', 'XA', 'END', 'ABORT'])
const SESSION = new Set(['USE', 'SET'])
/** SQLite pragmas that change the database file when assigned. */
const PRAGMA_PERSISTENT = new Set(['user_version', 'application_id', 'schema_version', 'journal_mode', 'page_size', 'auto_vacuum', 'encoding'])
/** SQLite pragmas that act on the database even without an assignment. */
const PRAGMA_ACTIONS = new Set(['optimize', 'incremental_vacuum', 'wal_checkpoint', 'shrink_memory'])

/** Tokens that make an otherwise read-looking statement modify data or lock rows. */
const WRITE_MARKERS = /\b(INSERT|UPDATE|DELETE|MERGE|INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|LOCK\s+IN\s+SHARE\s+MODE)\b/i

/**
 * Classifies a single SQL statement. Conservative by design: anything that is not
 * clearly read-only is reported as non-read, so callers can require confirmation.
 */
export function classifyStatement(sql: string): StatementKind {
  const text = maskLiterals(stripLeadingComments(sql)).trim()
  if (!text) return 'unknown'
  const words = text.split(/[\s(]+/).filter(Boolean)
  const first = words[0]?.toUpperCase() ?? ''

  if (first === 'WITH' || first === 'SELECT' || first === 'VALUES' || first === 'TABLE') {
    if (WRITE_MARKERS.test(text)) return 'write'
    // PostgreSQL / Firebird: SELECT ... INTO creates a table or assigns variables.
    if (/^SELECT\b[\s\S]*\bINTO\b/i.test(text) && first === 'SELECT') return 'write'
    return 'read'
  }
  if (first === 'EXPLAIN' || first === 'DESCRIBE' || first === 'DESC') {
    // EXPLAIN ANALYZE executes the statement.
    if (/\bANALY[SZ]E\b/i.test(words.slice(1, 4).join(' '))) {
      const inner = text.replace(/^\s*(EXPLAIN|DESCRIBE|DESC)\s+(\([^)]*\)\s*)?(ANALY[SZ]E\s+)?(VERBOSE\s+)?(FORMAT\s*=\s*\w+\s+)?/i, '')
      const innerKind = classifyStatement(inner)
      return innerKind === 'read' ? 'read' : 'write'
    }
    return 'read'
  }
  if (first === 'SET') {
    if (/^SET\s+(GLOBAL|PERSIST|PERSIST_ONLY|PASSWORD|DEFAULT\s+ROLE|STATISTICS|GENERATOR)\b/i.test(text)) return 'write'
    if (/^SET\s+(TRANSACTION|SESSION\s+CHARACTERISTICS)\b/i.test(text)) return 'transaction'
    return 'session'
  }
  if (first === 'ALTER' && /^ALTER\s+(SESSION|DATABASE\s+SET)\b/i.test(text)) return 'session'
  // SQLite: PRAGMA reads a setting or catalog unless it assigns a value or runs an action.
  if (first === 'PRAGMA') {
    const name = /^PRAGMA\s+(?:\w+\.)?(\w+)/i.exec(text)?.[1]?.toLowerCase() ?? ''
    if (/^PRAGMA\s+[\w.]+\s*=/i.test(text)) return PRAGMA_PERSISTENT.has(name) ? 'write' : 'session'
    return PRAGMA_ACTIONS.has(name) ? 'write' : 'read'
  }
  if (first === 'ATTACH' || first === 'DETACH') return 'session'
  if (READ.has(first)) return 'read'
  if (TRANSACTION.has(first)) return 'transaction'
  if (SESSION.has(first)) return 'session'
  if (DDL.has(first)) return 'ddl'
  if (WRITE.has(first)) return 'write'
  return 'unknown'
}

export function isReadOnlyStatement(sql: string): boolean {
  return classifyStatement(sql) === 'read'
}

/** Replaces string literals and quoted identifiers with placeholders to avoid false keyword matches. */
function maskLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")
}

/** Statements worth a confirmation: DROP/TRUNCATE, or UPDATE/DELETE without WHERE. */
export function isDangerousStatement(sql: string): boolean {
  const text = maskLiterals(stripLeadingComments(sql)).trim()
  if (/^(DROP|TRUNCATE)\b/i.test(text)) return true
  if (/^(UPDATE|DELETE)\b/i.test(text) && !/\bWHERE\b/i.test(text)) return true
  return false
}
