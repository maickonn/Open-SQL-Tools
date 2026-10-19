import type {
  AppSettings,
  ChatConversation,
  ChatMessage,
  ConnectionProfile,
  ConnectionSecrets,
  QueryHistoryEntry,
  Snippet
} from '@shared/model'

export interface ConnectionRepository {
  list(): ConnectionProfile[]
  get(id: string): ConnectionProfile | undefined
  save(profile: ConnectionProfile): void
  delete(id: string): void
}

export interface SettingsRepository {
  get(): AppSettings
  set(settings: AppSettings): void
  getState(key: string): unknown
  setState(key: string, value: unknown): void
}

export interface HistoryRepository {
  add(entry: Omit<QueryHistoryEntry, 'id'>): void
  list(connectionId: string | null, search: string, limit: number): QueryHistoryEntry[]
  clear(connectionId: string | null): void
}

export interface SnippetRepository {
  list(): Snippet[]
  save(snippet: Snippet): void
  delete(id: string): void
}

export interface ChatRepository {
  listConversations(): ChatConversation[]
  getConversation(id: string): ChatConversation | undefined
  saveConversation(c: ChatConversation): void
  deleteConversation(id: string): void
  listMessages(conversationId: string): ChatMessage[]
  addMessage(conversationId: string, message: ChatMessage): void
}

/** Stores encrypted secrets (DB passwords, API keys). */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): boolean
}

export const secretKeys = {
  connection: (id: string, field: keyof ConnectionSecrets): string => `conn:${id}:${field}`,
  aiKey: (provider: string): string => `ai:${provider}`
}
