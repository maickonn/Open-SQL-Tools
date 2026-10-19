import type { DbEngine, ObjectKind } from '@shared/model'

const isMySqlFamily = (engine: DbEngine): boolean => engine === 'mysql' || engine === 'mariadb'

/** Whether the engine can rename this kind of object in place (mirrors the dialects' renameObject). */
export function canRename(engine: DbEngine, kind: ObjectKind): boolean {
  switch (engine) {
    case 'firebird':
      return false
    case 'postgres':
      return ['table', 'view', 'materialized_view', 'sequence', 'function', 'procedure', 'schema', 'domain', 'type'].includes(kind)
    case 'mariadb':
      return ['table', 'view', 'event', 'sequence'].includes(kind)
    case 'mysql':
      return ['table', 'view', 'event'].includes(kind)
  }
}

/** Whether objects of this kind can be activated / deactivated without dropping them. */
export function canToggle(engine: DbEngine, kind: ObjectKind): boolean {
  if (kind === 'trigger') return engine === 'firebird' || engine === 'postgres'
  if (kind === 'event') return isMySqlFamily(engine)
  return false
}

/** Whether the "Operations" view (DML statements with their plans) is available. */
export function hasOperations(engine: DbEngine, kind: ObjectKind): boolean {
  return engine === 'firebird' && (kind === 'trigger' || kind === 'procedure' || kind === 'function')
}

/** Object kinds that can be created from a template, per engine. */
export function creatableKinds(engine: DbEngine): ObjectKind[] {
  switch (engine) {
    case 'firebird':
      return ['table', 'view', 'procedure', 'function', 'trigger', 'sequence', 'exception', 'domain']
    case 'postgres':
      return ['table', 'view', 'materialized_view', 'function', 'procedure', 'trigger', 'sequence', 'domain', 'type']
    case 'mariadb':
      return ['table', 'view', 'procedure', 'function', 'trigger', 'event', 'sequence']
    case 'mysql':
      return ['table', 'view', 'procedure', 'function', 'trigger', 'event']
  }
}

/** Kinds listed in a dedicated grid tab (current values / messages). */
export function hasListView(engine: DbEngine, kind: ObjectKind): kind is 'sequence' | 'exception' {
  return kind === 'sequence' || (kind === 'exception' && engine === 'firebird')
}
