import { create } from 'zustand'
import { DEFAULT_PORTS, DEFAULT_USERS, type ConnectionProfile, type ConnectionSecrets, type DbEngine, type ServerInfo } from '@shared/model'
import { api } from '../gateways/api'
import { useWorkspace } from './workspaceStore'
import { notify } from './toast'

export function blankProfile(engine: DbEngine = 'mysql', folder?: string): ConnectionProfile {
  const now = new Date().toISOString()
  return {
    id: '',
    name: '',
    folder,
    engine,
    host: '127.0.0.1',
    port: DEFAULT_PORTS[engine],
    user: DEFAULT_USERS[engine],
    database: engine === 'postgres' ? 'postgres' : '',
    options: engine === 'firebird' ? { charset: 'UTF8', wireCrypt: 'enabled' } : {},
    ssl: { enabled: false, rejectUnauthorized: true },
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'password' },
    savePassword: true,
    createdAt: now,
    updatedAt: now
  }
}

interface ConnectionsVM {
  profiles: ConnectionProfile[]
  dialogOpen: boolean
  selectedId: string | null
  draft: ConnectionProfile | null
  secrets: ConnectionSecrets
  hasStoredPassword: boolean
  dirty: boolean
  busy: 'test' | 'connect' | 'save' | null
  testResult: ServerInfo | null

  load(): Promise<void>
  openDialog(open?: boolean): void
  select(id: string | null): Promise<void>
  newProfile(engine?: DbEngine): void
  updateDraft(patch: Partial<ConnectionProfile>): void
  setSecret(field: keyof ConnectionSecrets, value: string): void
  save(): Promise<ConnectionProfile | null>
  remove(id: string): Promise<void>
  duplicate(id: string): Promise<void>
  test(): Promise<void>
  connect(id?: string, oneTime?: ConnectionSecrets): Promise<void>
}

export const useConnections = create<ConnectionsVM>((set, get) => ({
  profiles: [],
  dialogOpen: false,
  selectedId: null,
  draft: null,
  secrets: {},
  hasStoredPassword: false,
  dirty: false,
  busy: null,
  testResult: null,

  async load() {
    set({ profiles: await api.invoke('connections:list') })
  },

  openDialog(open = true) {
    set({ dialogOpen: open })
    if (open) void get().load()
  },

  async select(id) {
    if (!id) {
      set({ selectedId: null, draft: null, secrets: {}, dirty: false, testResult: null })
      return
    }
    const p = get().profiles.find((x) => x.id === id)
    if (!p) return
    const hasStoredPassword = await api.invoke('connections:hasPassword', id)
    set({ selectedId: id, draft: structuredClone(p), secrets: {}, hasStoredPassword, dirty: false, testResult: null })
  },

  newProfile(engine = 'mysql') {
    const folder = get().draft?.folder
    set({ selectedId: null, draft: blankProfile(engine, folder), secrets: {}, hasStoredPassword: false, dirty: true, testResult: null })
  },

  updateDraft(patch) {
    const d = get().draft
    if (!d) return
    const next = { ...d, ...patch }
    // Switching engines resets engine-specific defaults the user left untouched.
    if (patch.engine && patch.engine !== d.engine) {
      if (d.port === DEFAULT_PORTS[d.engine]) next.port = DEFAULT_PORTS[patch.engine]
      if (d.user === DEFAULT_USERS[d.engine]) next.user = DEFAULT_USERS[patch.engine]
      if (patch.engine === 'firebird') next.options = { charset: 'UTF8', wireCrypt: 'enabled', ...next.options }
      if (patch.engine === 'postgres' && !next.database) next.database = 'postgres'
    }
    set({ draft: next, dirty: true, testResult: null })
  },

  setSecret(field, value) {
    set((s) => ({ secrets: { ...s.secrets, [field]: value }, dirty: true }))
  },

  async save() {
    const { draft, secrets } = get()
    if (!draft) return null
    set({ busy: 'save' })
    try {
      const name = draft.name.trim() || `${draft.user}@${draft.host}`
      const saved = await api.invoke('connections:save', { ...draft, name }, secrets)
      await get().load()
      const hasStoredPassword = await api.invoke('connections:hasPassword', saved.id)
      set({ selectedId: saved.id, draft: structuredClone(saved), secrets: {}, hasStoredPassword, dirty: false })
      return saved
    } catch (err) {
      notify.error(err)
      return null
    } finally {
      set({ busy: null })
    }
  },

  async remove(id) {
    await api.invoke('connections:delete', id)
    await get().load()
    if (get().selectedId === id) set({ selectedId: null, draft: null, dirty: false })
  },

  async duplicate(id) {
    const copy = await api.invoke('connections:duplicate', id)
    await get().load()
    await get().select(copy.id)
  },

  async test() {
    const { draft, secrets } = get()
    if (!draft) return
    set({ busy: 'test', testResult: null })
    try {
      set({ testResult: await api.invoke('connections:test', draft, secrets) })
    } catch (err) {
      notify.error(err)
    } finally {
      set({ busy: null })
    }
  },

  async connect(id, oneTime) {
    let profileId = id ?? get().selectedId
    // Typed secrets are kept for this attempt even when the profile does not save them.
    const typed = !id && Object.values(get().secrets).some(Boolean) ? get().secrets : undefined
    if (!id && get().dirty) {
      const saved = await get().save()
      if (!saved) return
      profileId = saved.id
    }
    const profile = get().profiles.find((p) => p.id === profileId)
    if (!profile) return
    set({ busy: 'connect' })
    try {
      await useWorkspace.getState().openSession(profile, oneTime ?? typed)
      set({ dialogOpen: false })
      void get().load()
    } catch (err) {
      notify.error(err)
    } finally {
      set({ busy: null })
    }
  }
}))
