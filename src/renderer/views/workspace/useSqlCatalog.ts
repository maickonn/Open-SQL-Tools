import { useMemo } from 'react'
import type { DbObjectInfo } from '@shared/model'
import { useWorkspace, type SessionState } from '../../stores/workspaceStore'
import { catalogFor, type SqlCatalog } from '../../lib/sqlCatalog'

/** The IntelliSense catalog of a query tab: its session and database (the tree's cache adds object kinds). */
export function useSqlCatalog(session: SessionState | undefined, database: string | undefined): SqlCatalog | null {
  const objects = useWorkspace((s) => s.objects)
  return useMemo(() => {
    if (!session) return null
    const items: DbObjectInfo[] = []
    for (const [key, entry] of Object.entries(objects)) if (entry.status === 'ok' && key.startsWith(session.id)) items.push(...entry.items)
    return catalogFor(session.id, session.client, session.info.engine, database, items)
  }, [session, objects, database])
}
