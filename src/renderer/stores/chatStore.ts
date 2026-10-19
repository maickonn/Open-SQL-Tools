import { create } from 'zustand'
import { resolveAiModel, type AiProviderId, type ChatConversation, type ChatEvent, type ChatMessage } from '@shared/model'
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

interface ChatVM {
  open: boolean
  conversations: ChatConversation[]
  activeId: string | null
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  running: boolean
  approvals: PendingApproval[]
  tools: Record<string, ToolActivity>
  hasKey: Record<AiProviderId, boolean>
  error: string | null

  toggle(open?: boolean): void
  init(): Promise<void>
  refreshKeys(): Promise<void>
  select(id: string | null): Promise<void>
  newConversation(provider?: AiProviderId, model?: string): Promise<string>
  send(text: string, ctx: { sessionId?: string; database?: string; editorContext?: string; connectionId?: string }): Promise<void>
  stop(): Promise<void>
  approve(callId: string, approved: boolean): Promise<void>
  remove(id: string): Promise<void>
  setModel(provider: AiProviderId, model: string): Promise<void>
}

const refreshConversations = (): void => {
  void api.invoke('chat:conversations').then((conversations) => useChat.setState({ conversations }))
}

export const useChat = create<ChatVM>((set, get) => ({
  open: false,
  conversations: [],
  activeId: null,
  messages: [],
  streamingText: '',
  streamingThinking: '',
  running: false,
  approvals: [],
  tools: {},
  hasKey: { anthropic: false, openai: false },
  error: null,

  toggle(open) {
    set((s) => ({ open: open ?? !s.open }))
    if (get().open) void get().init()
  },

  async init() {
    await get().refreshKeys()
    const conversations = await api.invoke('chat:conversations')
    set({ conversations })
    if (!get().activeId && conversations[0]) await get().select(conversations[0].id)
  },

  async refreshKeys() {
    const [anthropic, openai] = await Promise.all([api.invoke('ai:hasKey', 'anthropic'), api.invoke('ai:hasKey', 'openai')])
    set({ hasKey: { anthropic, openai } })
  },

  async select(id) {
    if (!id) {
      set({ activeId: null, messages: [], approvals: [], tools: {} })
      return
    }
    const messages = await api.invoke('chat:messages', id)
    set({ activeId: id, messages, streamingText: '', streamingThinking: '', approvals: [], tools: {}, error: null })
  },

  async newConversation(provider, model) {
    const ai = useSettings.getState().settings.ai
    const p = provider ?? ai.defaultProvider
    const c = await api.invoke('chat:create', { provider: p, model: resolveAiModel(p, model) })
    set((s) => ({ conversations: [c, ...s.conversations] }))
    await get().select(c.id)
    return c.id
  },

  async send(text, ctx) {
    let id = get().activeId
    if (!id) id = await get().newConversation()
    set({ running: true, streamingText: '', streamingThinking: '', error: null })
    try {
      if (ctx.connectionId) await api.invoke('chat:update', id, { connectionId: ctx.connectionId })
      await api.invoke('chat:send', { conversationId: id, text, sessionId: ctx.sessionId, database: ctx.database, editorContext: ctx.editorContext })
    } catch (err) {
      set({ running: false })
      notify.error(err)
    }
  },

  async stop() {
    const id = get().activeId
    if (id) await api.invoke('chat:cancel', id)
  },

  async approve(callId, approved) {
    set((s) => ({ approvals: s.approvals.map((a) => (a.callId === callId ? { ...a, decided: true, approved } : a)) }))
    await api.invoke('chat:approve', callId, approved)
  },

  async remove(id) {
    await api.invoke('chat:delete', id)
    set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
    if (get().activeId === id) await get().select(get().conversations[0]?.id ?? null)
  },

  async setModel(provider, model) {
    const id = get().activeId
    if (!id) return
    const c = await api.invoke('chat:update', id, { provider, model })
    set((s) => ({ conversations: s.conversations.map((x) => (x.id === id ? c : x)) }))
  }
}))

api.on('chat:event', (e: ChatEvent) => {
  const s = useChat.getState()
  if (e.conversationId !== s.activeId) {
    if (e.type === 'done' || e.type === 'error') refreshConversations()
    return
  }
  switch (e.type) {
    case 'start':
      useChat.setState({ streamingText: '', streamingThinking: '', running: true })
      break
    case 'text-delta':
      useChat.setState((st) => ({ streamingText: st.streamingText + e.text }))
      break
    case 'thinking-delta':
      useChat.setState((st) => ({ streamingThinking: st.streamingThinking + e.text }))
      break
    case 'tool-call':
      useChat.setState((st) => ({ tools: { ...st.tools, [e.callId]: { callId: e.callId, name: e.name, input: e.input } } }))
      break
    case 'tool-result':
      useChat.setState((st) => ({ tools: { ...st.tools, [e.callId]: { ...st.tools[e.callId], output: e.output, isError: e.isError } } }))
      break
    case 'approval-required':
      useChat.setState((st) => ({ approvals: [...st.approvals, { callId: e.callId, name: e.name, sql: e.sql, reason: e.reason }] }))
      break
    case 'message-saved':
      useChat.setState((st) => ({
        messages: [...st.messages, e.message],
        streamingText: e.message.role === 'assistant' ? '' : st.streamingText,
        streamingThinking: e.message.role === 'assistant' ? '' : st.streamingThinking
      }))
      break
    case 'done':
      useChat.setState({ running: false, streamingText: '', streamingThinking: '' })
      refreshConversations()
      break
    case 'error':
      useChat.setState({ running: false, error: e.error })
      break
  }
})
