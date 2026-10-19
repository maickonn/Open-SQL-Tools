import { create } from 'zustand'
import type { ConnectionProfile, ConnectionSecrets, DbObjectInfo, DbObjectRef, ServerInfo } from '@shared/model'
import { api, errorMessage } from '../gateways/api'
import { connectSessionClient, type SessionClient } from '../gateways/sessionClient'
import { uid } from '../lib/format'
import { notify } from './toast'
import i18n from '../i18n'

export interface SessionState {
  id: string
  profile: ConnectionProfile
  info: ServerInfo
  client: SessionClient
  databases?: string[]
  autocommit: boolean
  inTransaction: boolean
  lost?: string
}

export type TabKind = 'host' | 'database' | 'object' | 'query' | 'list'

export type ObjectSubView = 'structure' | 'data' | 'ddl' | 'dependencies' | 'operations'

export interface Tab {
  id: string
  sessionId: string
  kind: TabKind
  title: string
  ref?: DbObjectRef
  database?: string
  schema?: string
  /** Preview tabs are replaced by the next tree selection unless pinned. */
  preview?: boolean
  /** Sub view for object tabs. */
  view?: ObjectSubView
  /** List tabs: the grid of generators / sequences or exceptions. */
  listKind?: 'sequence' | 'exception'
  /** Object tab for a table that does not exist yet. */
  isNew?: boolean
}

export interface LogEntry {
  id: number
  sessionId: string
  kind: 'sql' | 'info' | 'error'
  text: string
  at: number
}

export type ObjectsEntry = { status: 'loading' } | { status: 'ok'; items: DbObjectInfo[] } | { status: 'error'; error: string }

export const objectsKey = (sessionId: string, database?: string, schema?: string): string => `${sessionId}\u0001${database ?? ''}\u0001${schema ?? ''}`

const MAX_LOG = 3000
let logSeq = 0

interface WorkspaceVM {
  sessions: Record<string, SessionState>
  activeSessionId: string | null
  tabs: Tab[]
  activeTabId: string | null
  log: LogEntry[]
  objects: Record<string, ObjectsEntry>
  schemas: Record<string, string[] | undefined>
  expanded: Record<string, boolean>
  selectedNode: string | null

  openSession(profile: ConnectionProfile, secrets?: ConnectionSecrets): Promise<string>
  closeSession(sessionId: string): Promise<void>
  setActiveSession(sessionId: string): void
  refreshDatabases(sessionId: string): Promise<void>
  loadSchemas(sessionId: string, database: string, force?: boolean): Promise<void>
  loadObjects(sessionId: string, database?: string, schema?: string, force?: boolean): Promise<void>
  toggleNode(key: string, value?: boolean): void
  selectNode(key: string | null): void

  openTab(tab: Omit<Tab, 'id'>, opts?: { preview?: boolean }): string
  updateTab(id: string, patch: Partial<Tab>): void
  closeTab(id: string): void
  activateTab(id: string): void
  newQueryTab(sessionId?: string, sql?: string, database?: string): string

  addLog(sessionId: string, kind: LogEntry['kind'], text: string): void
  clearLog(): void
  setTransactionState(sessionId: string, patch: Partial<Pick<SessionState, 'autocommit' | 'inTransaction'>>): void
}

/** Initial SQL for new query tabs, consumed by the query view model. */
export const pendingQuerySql = new Map<string, string>()

export const useWorkspace = create<WorkspaceVM>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  tabs: [],
  activeTabId: null,
  log: [],
  objects: {},
  schemas: {},
  expanded: {},
  selectedNode: null,

  async openSession(profile, secrets) {
    const { sessionId, serverInfo } = await api.invoke('session:open', profile.id, secrets)
    const client = await connectSessionClient(sessionId)
    client.on('log', (e) => get().addLog(sessionId, e.kind, e.text))
    client.on('connection:lost', (e) => {
      set((s) => (s.sessions[sessionId] ? { sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], lost: e.message } } } : s))
      notify.error(i18n.t('errors.connectionLost', { message: e.message }))
    })
    const session: SessionState = { id: sessionId, profile, info: serverInfo, client, autocommit: true, inTransaction: false }
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId,
      expanded: { ...s.expanded, [sessionId]: true },
      selectedNode: sessionId
    }))
    get().addLog(sessionId, 'info', `${profile.name}: ${serverInfo.label} (${serverInfo.versionString})`)
    get().openTab({ sessionId, kind: 'host', title: profile.name }, { preview: true })
    if (serverInfo.engine === 'firebird') void get().loadObjects(sessionId)
    else void get().refreshDatabases(sessionId)
    return sessionId
  },

  async closeSession(sessionId) {
    const s = get().sessions[sessionId]
    if (!s) return
    s.client.close()
    await api.invoke('session:close', sessionId).catch(() => undefined)
    set((st) => {
      const sessions = { ...st.sessions }
      delete sessions[sessionId]
      const tabs = st.tabs.filter((t) => t.sessionId !== sessionId)
      const activeTabId = tabs.some((t) => t.id === st.activeTabId) ? st.activeTabId : (tabs[tabs.length - 1]?.id ?? null)
      const objects = Object.fromEntries(Object.entries(st.objects).filter(([k]) => !k.startsWith(sessionId)))
      const activeSessionId = st.activeSessionId === sessionId ? (Object.keys(sessions)[0] ?? null) : st.activeSessionId
      return { sessions, tabs, activeTabId, objects, activeSessionId }
    })
  },

  setActiveSession(sessionId) {
    set({ activeSessionId: sessionId })
  },

  async refreshDatabases(sessionId) {
    const s = get().sessions[sessionId]
    if (!s) return
    try {
      let databases = await s.client.call('listDatabases', undefined)
      const filter = s.profile.databaseFilter?.filter(Boolean)
      if (filter?.length) databases = databases.filter((d) => filter.includes(d))
      set((st) => (st.sessions[sessionId] ? { sessions: { ...st.sessions, [sessionId]: { ...st.sessions[sessionId], databases } } } : st))
    } catch (err) {
      notify.error(err)
    }
  },

  async loadSchemas(sessionId, database, force) {
    const key = objectsKey(sessionId, database)
    if (!force && get().schemas[key]) return
    const s = get().sessions[sessionId]
    if (!s) return
    try {
      const schemas = await s.client.call('listSchemas', { database })
      set((st) => ({ schemas: { ...st.schemas, [key]: schemas } }))
    } catch (err) {
      notify.error(err)
    }
  },

  async loadObjects(sessionId, database, schema, force) {
    const key = objectsKey(sessionId, database, schema)
    const current = get().objects[key]
    if (!force && current && current.status !== 'error') return
    const s = get().sessions[sessionId]
    if (!s) return
    set((st) => ({ objects: { ...st.objects, [key]: { status: 'loading' } } }))
    try {
      const items = await s.client.call('listObjects', { database, schema })
      set((st) => ({ objects: { ...st.objects, [key]: { status: 'ok', items } } }))
    } catch (err) {
      set((st) => ({ objects: { ...st.objects, [key]: { status: 'error', error: errorMessage(err) } } }))
    }
  },

  toggleNode(key, value) {
    set((s) => ({ expanded: { ...s.expanded, [key]: value ?? !s.expanded[key] } }))
  },

  selectNode(key) {
    set({ selectedNode: key })
  },

  openTab(tab, opts) {
    const st = get()
    // Reuse an equivalent open tab.
    const same = st.tabs.find(
      (t) =>
        t.sessionId === tab.sessionId &&
        t.kind === tab.kind &&
        tab.kind !== 'query' &&
        t.database === tab.database &&
        t.schema === tab.schema &&
        t.ref?.name === tab.ref?.name &&
        t.ref?.kind === tab.ref?.kind &&
        t.ref?.args === tab.ref?.args &&
        t.listKind === tab.listKind &&
        !t.isNew &&
        !tab.isNew
    )
    if (same) {
      set({ activeTabId: same.id, activeSessionId: same.sessionId, tabs: st.tabs.map((t) => (t.id === same.id ? { ...t, ...tab, id: t.id, preview: t.preview && !!opts?.preview } : t)) })
      return same.id
    }
    const id = uid()
    const next: Tab = { ...tab, id, preview: !!opts?.preview }
    const previewIdx = opts?.preview ? st.tabs.findIndex((t) => t.preview && t.kind !== 'query') : -1
    const tabs = previewIdx >= 0 ? st.tabs.map((t, i) => (i === previewIdx ? next : t)) : [...st.tabs, next]
    set({ tabs, activeTabId: id, activeSessionId: tab.sessionId })
    return id
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  },

  closeTab(id) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId = s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  activateTab(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) set({ activeTabId: id, activeSessionId: tab.sessionId })
  },

  newQueryTab(sessionId, sql, database) {
    const sid = sessionId ?? get().activeSessionId
    if (!sid || !get().sessions[sid]) {
      notify.error(i18n.t('errors.noSession'))
      return ''
    }
    const count = get().tabs.filter((t) => t.kind === 'query').length + 1
    const id = get().openTab({ sessionId: sid, kind: 'query', title: `${i18n.t('query.untitled')} #${count}`, database: database ?? get().sessions[sid].info.currentDatabase })
    if (sql) pendingQuerySql.set(id, sql)
    return id
  },

  addLog(sessionId, kind, text) {
    set((s) => {
      const entry: LogEntry = { id: ++logSeq, sessionId, kind, text, at: Date.now() }
      const log = s.log.length >= MAX_LOG ? [...s.log.slice(s.log.length - MAX_LOG + 1), entry] : [...s.log, entry]
      return { log }
    })
  },

  clearLog() {
    set({ log: [] })
  },

  setTransactionState(sessionId, patch) {
    set((s) => (s.sessions[sessionId] ? { sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], ...patch } } } : s))
  }
}))

api.on('session:closed', ({ sessionId, reason }) => {
  const s = useWorkspace.getState().sessions[sessionId]
  if (!s) return
  if (reason) notify.error(i18n.t('errors.connectionLost', { message: reason }))
  void useWorkspace.getState().closeSession(sessionId)
})

api.on('editor:open', ({ sql, sessionId }) => {
  useWorkspace.getState().newQueryTab(sessionId, sql)
})

export const useActiveSession = (): SessionState | null =>
  useWorkspace((s) => (s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null))
