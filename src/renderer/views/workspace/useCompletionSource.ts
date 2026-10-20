import { useMemo } from 'react'
import type { DbObjectInfo } from '@shared/model'
import { useWorkspace, objectsKey, type SessionState } from '../../stores/workspaceStore'
import type { CompletionSource } from '../../components/editor/monaco'
import { isSingleDatabase } from '@domain/engineTraits'

const KEYWORDS = (
  'SELECT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS GROUP BY ORDER HAVING LIMIT OFFSET ' +
  'FETCH FIRST SKIP ROWS UNION ALL DISTINCT INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN ' +
  'REFERENCES CONSTRAINT CHECK DEFAULT CASCADE TRUNCATE BEGIN COMMIT ROLLBACK TRANSACTION CASE WHEN THEN ELSE END WITH RECURSIVE RETURNING ' +
  'PROCEDURE FUNCTION TRIGGER SEQUENCE DATABASE SCHEMA GRANT REVOKE EXPLAIN ANALYZE COUNT SUM AVG MIN MAX COALESCE CAST CURRENT_TIMESTAMP'
).split(' ')

const columnCache = new Map<string, Promise<string[]>>()

/** Completion data from the cached object tree; columns load lazily per table. */
export function useCompletionSource(session: SessionState | undefined, database: string | undefined): CompletionSource | null {
  const objects = useWorkspace((s) => s.objects)
  return useMemo(() => {
    if (!session) return null
    const engine = session.info.engine
    const lists: DbObjectInfo[] = []
    for (const [key, entry] of Object.entries(objects)) {
      if (entry.status !== 'ok' || !key.startsWith(session.id)) continue
      const [, db] = key.split('\u0001')
      if (!isSingleDatabase(engine) && database && db !== database) continue
      lists.push(...entry.items)
    }
    const tables = lists.filter((o) => o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view')
    const quote = (name: string): string => {
      if (engine === 'mysql' || engine === 'mariadb') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`'
      if (engine === 'postgres') return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
      // SQLite identifiers are case-insensitive: only unusual names need quotes.
      if (engine === 'sqlite') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
      return /^[A-Z][A-Z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
    }
    return {
      keywords: KEYWORDS,
      quote,
      tables: () => tables.map((o) => ({ name: o.name, detail: o.schema ? `${o.schema} · ${o.kind}` : o.kind })),
      columns: (table: string) => {
        const obj = tables.find((o) => o.name.toLowerCase() === table.toLowerCase())
        if (!obj) return Promise.resolve([])
        const key = `${session.id}|${obj.database ?? ''}|${obj.schema ?? ''}|${obj.name}`
        let p = columnCache.get(key)
        if (!p) {
          p = session.client
            .call('getTableStructure', { ref: { database: obj.database, schema: obj.schema, name: obj.name, kind: 'table' } })
            .then((s) => s.columns.map((c) => c.name))
            .catch(() => [])
          columnCache.set(key, p)
        }
        return p
      }
    }
  }, [session, objects, database])
}
