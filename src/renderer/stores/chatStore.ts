import { create } from 'zustand'
import { AI_MODELS, resolveAiModel, type AiProviderId, type ChatConversation, type ChatEvent, type ChatMessage } from '@shared/model'
import { api } from '../gateways/api'
import { notify } from './toast'
import { useSettings } from './settingsStore'

export interface PendingApproval {
  callId: string
  name: string
  sql: string
  reason: string
  decided?: boolean
  approved?: boolean
}

export interface ToolActivity {
  callId: string
  name: string
  input: unknown
  output?: string
  isError?: boolean
}

/** In-flight state of one conversation; kept per conversation so switching sessions never mixes runs. */
export interface LiveState {
  streamingText: string
  /** The model is reasoning right now (its text is never shown). */
  thinking: boolean
  running: boolean
  approvals: PendingApproval[]
  tools: Record<string, ToolActivity>
  error: string | null
}

export const IDLE: LiveState = { streamingText: '', thinking: false, running: false, approvals: [], tools: {}, error: null }

/** Conversations belong to a connection profile; '' holds the ones started without a session. */
export type ChatScope = string

interface ChatVM {
  open: boolean
  conversations: ChatConversation[]
  /** Conversations were fetched at least once; scopes resolve their latest chat only after that. */
  loaded: boolean
  scope: ChatScope
  /** Conversation shown for each scope (null = new chat, created on the first message). */
  activeByScope: Record<ChatScope, string | null>
  messages: Record<string, ChatMessage[]>
  live: Record<string, LiveState>
  hasKey: Record<AiProviderId, boolean>

  toggle(open?: boolean): void
  init(): Promise<void>
  refreshKeys(): Promise<void>
  setScope(scope: ChatScope): Promise<void>
  select(id: string | null): Promise<void>
  /** Opens an empty chat in the current scope; it is created on the first message. */
  newConversation(): void
  send(text: string, ctx: { sessionId?: string; database?: string; editorContext?: string }): Promise<void>
  stop(): Promise<void>
  approve(callId: string, approved: boolean): Promise<void>
  remove(id: string): Promise<void>
  setModel(provider: AiProviderId, model: string): Promise<void>
}

export const inScope = (c: ChatConversation, scope: ChatScope): boolean => (c.connectionId ?? '') === scope

/** Model for new conversations: the last one picked, else the default provider's. */
export function lastModel(): { provider: AiProviderId; model: string } {
  const ai = useSettings.getState().settings.ai
  const m = AI_MODELS.find((x) => x.id === ai.lastModel)
  return m ? { provider: m.provider, model: m.id } : { provider: ai.defaultProvider, model: resolveAiModel(ai.defaultProvider, undefined) }
}

const refreshConversations = (): void => {
  void api.invoke('chat:conversations').then((conversations) => useChat.setState({ conversations }))
}

const patchLive = (id: string, patch: Partial<LiveState> | ((l: LiveState) => Partial<LiveState>)): void =>
  useChat.setState((s) => {
    const cur = s.live[id] ?? IDLE
    return { live: { ...s.live, [id]: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } } }
  })

export const useChat = create<ChatVM>((set, get) => {
  const activeId = (): string | null => get().activeByScope[get().scope] ?? null

  return {
    open: false,
    conversations: [],
    loaded: false,
    scope: '',
    activeByScope: {},
    messages: {},
    live: {},
    hasKey: { anthropic: false, openai: false },

    toggle(open) {
      set((s) => ({ open: open ?? !s.open }))
      if (get().open) void get().init()
    },

    async init() {
      await get().refreshKeys()
      set({ conversations: await api.invoke('chat:conversations'), loaded: true })
      await get().setScope(get().scope)
    },

    async refreshKeys() {
      const [anthropic, openai] = await Promise.all([api.invoke('ai:hasKey', 'anthropic'), api.invoke('ai:hasKey', 'openai')])
      set({ hasKey: { anthropic, openai } })
    },

    async setScope(scope) {
      set({ scope })
      if (!get().loaded || scope in get().activeByScope) return
      // First visit: reopen the scope's latest conversation (the list is sorted by recency).
      const latest = get().conversations.find((c) => inScope(c, scope))
      await get().select(latest?.id ?? null)
    },

    async select(id) {
      const scope = get().scope
      set((s) => ({ activeByScope: { ...s.activeByScope, [scope]: id } }))
      if (!id || get().messages[id]) return
      const messages = await api.invoke('chat:messages', id)
      set((s) => ({ messages: { ...s.messages, [id]: messages } }))
    },

    newConversation() {
      void get().select(null)
    },

    async send(text, ctx) {
      let id = activeId()
      if (!id) {
        const { provider, model } = lastModel()
        const scope = get().scope
        const c = await api.invoke('chat:create', { provider, model, connectionId: scope || undefined })
        id = c.id
        set((s) => ({ conversations: [c, ...s.conversations], messages: { ...s.messages, [c.id]: [] }, activeByScope: { ...s.activeByScope, [scope]: c.id } }))
      }
      patchLive(id, { running: true, streamingText: '', thinking: false, error: null })
      try {
        await api.invoke('chat:send', { conversationId: id, text, sessionId: ctx.sessionId, database: ctx.database, editorContext: ctx.editorContext })
      } catch (err) {
        patchLive(id, { running: false })
        notify.error(err)
      }
    },

    async stop() {
      const id = activeId()
      if (id) await api.invoke('chat:cancel', id)
    },

    async approve(callId, approved) {
      const id = activeId()
      if (id) patchLive(id, (l) => ({ approvals: l.approvals.map((a) => (a.callId === callId ? { ...a, decided: true, approved } : a)) }))
      await api.invoke('chat:approve', callId, approved)
    },

    async remove(id) {
      await api.invoke('chat:delete', id)
      set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
      if (activeId() === id) {
        const next = get().conversations.find((c) => inScope(c, get().scope))
        await get().select(next?.id ?? null)
      }
    },

    async setModel(provider, model) {
      const ai = useSettings.getState().settings.ai
      void useSettings.getState().update({ ai: { ...ai, lastModel: model } })
      const id = activeId()
      if (!id) return
      const c = await api.invoke('chat:update', id, { provider, model })
      set((s) => ({ conversations: s.conversations.map((x) => (x.id === id ? c : x)) }))
    }
  }
})

api.on('chat:event', (e: ChatEvent) => {
  const id = e.conversationId
  switch (e.type) {
    case 'start':
      patchLive(id, { streamingText: '', running: true })
      break
    case 'text-delta':
      patchLive(id, (l) => ({ streamingText: l.streamingText + e.text, thinking: false }))
      break
    case 'thinking-delta':
      if (!useChat.getState().live[id]?.thinking) patchLive(id, { thinking: true })
      break
    case 'tool-call':
      patchLive(id, (l) => ({ tools: { ...l.tools, [e.callId]: { callId: e.callId, name: e.name, input: e.input } }, thinking: false }))
      break
    case 'tool-result':
      patchLive(id, (l) => ({ tools: { ...l.tools, [e.callId]: { ...l.tools[e.callId], output: e.output, isError: e.isError } } }))
      break
    case 'approval-required':
      patchLive(id, (l) => ({ approvals: [...l.approvals, { callId: e.callId, name: e.name, sql: e.sql, reason: e.reason }] }))
      break
    case 'message-saved':
      useChat.setState((s) => (s.messages[id] ? { messages: { ...s.messages, [id]: [...s.messages[id], e.message] } } : {}))
      if (e.message.role === 'assistant') patchLive(id, { streamingText: '', thinking: false })
      break
    case 'done':
      patchLive(id, { running: false, streamingText: '', thinking: false })
      refreshConversations()
      break
    case 'error':
      patchLive(id, { running: false, thinking: false, error: e.error })
      refreshConversations()
      break
  }
})
