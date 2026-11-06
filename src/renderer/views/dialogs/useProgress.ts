import { useEffect, useState } from 'react'
import type { ProgressInfo } from '@shared/model'
import type { SessionState } from '../../stores/workspaceStore'

/** Tracks worker progress events for one operation. */
export function useProgress(session: SessionState | undefined, operationId: string): ProgressInfo | null {
  const [p, setP] = useState<ProgressInfo | null>(null)
  useEffect(() => {
    if (!session) return
    return session.client.on('progress', (e) => {
      if (e.operationId === operationId) setP(e)
    })
  }, [session, operationId])
  return p
}
