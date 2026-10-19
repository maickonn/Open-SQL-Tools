import { api } from '../gateways/api'
import { useQueries } from '../stores/queryStore'
import { useSettings } from '../stores/settingsStore'
import { useWorkspace } from '../stores/workspaceStore'

interface SavedTab {
  title: string
  sql: string
  database?: string
}

const key = (profileId: string): string => `queryTabs.${profileId}`

/** Saves query tab contents per connection profile and restores them when the profile reconnects. */
export function initTabPersistence(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (!useSettings.getState().settings.restoreTabs) return
    const ws = useWorkspace.getState()
    const queries = useQueries.getState().tabs
    const byProfile = new Map<string, SavedTab[]>()
    for (const s of Object.values(ws.sessions)) byProfile.set(s.profile.id, [])
    for (const tab of ws.tabs) {
      if (tab.kind !== 'query') continue
      const session = ws.sessions[tab.sessionId]
      const q = queries[tab.id]
      if (!session || !q?.sql.trim()) continue
      byProfile.get(session.profile.id)?.push({ title: tab.title, sql: q.sql, database: q.database })
    }
    for (const [profileId, tabs] of byProfile) void api.invoke('state:set', key(profileId), tabs)
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 800)
  }
  useQueries.subscribe(schedule)
  useWorkspace.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) schedule()
    // Restore when a session appears.
    for (const id of Object.keys(s.sessions)) {
      if (prev.sessions[id]) continue
      if (!useSettings.getState().settings.restoreTabs) continue
      const profileId = s.sessions[id].profile.id
      void api.invoke('state:get', key(profileId)).then((saved) => {
        for (const tab of (saved as SavedTab[] | undefined) ?? []) {
          const tabId = useWorkspace.getState().newQueryTab(id, tab.sql, tab.database)
          if (tabId) useWorkspace.getState().updateTab(tabId, { title: tab.title })
        }
        // Keep the host tab in front after restoring.
        const host = useWorkspace.getState().tabs.find((t) => t.sessionId === id && t.kind === 'host')
        if (host) useWorkspace.getState().activateTab(host.id)
      })
    }
  })
  window.addEventListener('beforeunload', save)
}
