import type {
  AiProviderId,
  AppSettings,
  ChatConversation,
  ChatEvent,
  ChatMessage,
  ConnectionProfile,
  ConnectionSecrets,
  ProgressInfo,
  QueryHistoryEntry,
  ServerInfo,
  Snippet,
  UpdateState
} from './model'

export interface OpenSessionResult {
  sessionId: string
  serverInfo: ServerInfo
}

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'

export interface FileDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface SessionsFile {
  version: 1
  connections: ConnectionProfile[]
}

/**
 * IPC invoke contract (renderer → main). Each channel maps arguments → result.
 * The preload exposes only an `invoke` typed by this map.
 */
export interface IpcInvokeMap {
  'connections:list': { args: []; result: ConnectionProfile[] }
  'connections:save': { args: [profile: ConnectionProfile, secrets: ConnectionSecrets | null]; result: ConnectionProfile }
  'connections:delete': { args: [id: string]; result: void }
  'connections:duplicate': { args: [id: string]; result: ConnectionProfile }
  'connections:hasPassword': { args: [id: string]; result: boolean }
  'connections:test': { args: [profile: ConnectionProfile, secrets: ConnectionSecrets | null]; result: ServerInfo }
  'connections:export': { args: [filePath: string, ids: string[]]; result: number }
  'connections:import': { args: [filePath: string]; result: number }

  'session:open': { args: [profileId: string, oneTimeSecrets?: ConnectionSecrets]; result: OpenSessionResult }
  'session:close': { args: [sessionId: string]; result: void }
  'session:list': { args: []; result: { sessionId: string; profileId: string }[] }

  'settings:get': { args: []; result: AppSettings }
  'settings:set': { args: [patch: Partial<AppSettings>]; result: AppSettings }

  'history:list': { args: [connectionId: string | null, search: string, limit: number]; result: QueryHistoryEntry[] }
  'history:add': { args: [entry: Omit<QueryHistoryEntry, 'id'>]; result: void }
  'history:clear': { args: [connectionId: string | null]; result: void }

  'snippets:list': { args: []; result: Snippet[] }
  'snippets:save': { args: [snippet: Snippet]; result: Snippet }
  'snippets:delete': { args: [id: string]; result: void }

  'state:get': { args: [key: string]; result: unknown }
  'state:set': { args: [key: string, value: unknown]; result: void }

  'ai:setKey': { args: [provider: AiProviderId, key: string | null]; result: void }
  'ai:hasKey': { args: [provider: AiProviderId]; result: boolean }

  'chat:conversations': { args: []; result: ChatConversation[] }
  'chat:create': { args: [init: { provider: AiProviderId; model: string; connectionId?: string }]; result: ChatConversation }
  'chat:messages': { args: [conversationId: string]; result: ChatMessage[] }
  'chat:delete': { args: [conversationId: string]; result: void }
  'chat:update': { args: [conversationId: string, patch: Partial<Pick<ChatConversation, 'title' | 'provider' | 'model' | 'connectionId'>>]; result: ChatConversation }
  'chat:send': {
    args: [p: { conversationId: string; text: string; sessionId?: string; database?: string; editorContext?: string }]
    result: void
  }
  'chat:approve': { args: [callId: string, approved: boolean]; result: void }
  'chat:cancel': { args: [conversationId: string]; result: void }

  'dialog:openFile': { args: [options: FileDialogOptions]; result: string | null }
  'dialog:saveFile': { args: [options: FileDialogOptions]; result: string | null }
  'fs:readText': { args: [filePath: string]; result: string }
  'fs:readBytes': { args: [filePath: string]; result: Uint8Array }
  'fs:writeText': { args: [filePath: string, content: string]; result: void }
  'fs:writeBytes': { args: [filePath: string, content: Uint8Array]; result: void }
  'shell:showItem': { args: [filePath: string]; result: void }
  'shell:openExternal': { args: [url: string]; result: void }

  'app:info': { args: []; result: { version: string; electron: string; chrome: string; userData: string } }
  'app:setNativeTheme': { args: [theme: 'dark' | 'light' | 'system']; result: void }
  /* Startup update splash */
  'update:getState': { args: []; result: UpdateState }
  'update:download': { args: []; result: void }
  'update:cancel': { args: []; result: void }
  'update:skip': { args: []; result: void }
  'update:install': { args: []; result: void }
  'update:openPage': { args: []; result: void }
  /** Runs an edit command on the focused field (keeps the native undo stack and input events). */
  'edit:command': { args: [command: EditCommand]; result: void }
  'edit:canPaste': { args: []; result: boolean }
  /** macOS: the menus of the native menu bar; clicks come back as `menu:command` with the item id. */
  'menu:set': { args: [menu: NativeMenu]; result: void }
}

export type IpcChannel = keyof IpcInvokeMap

/** Events main → renderer. */
export interface IpcEventMap {
  'chat:event': ChatEvent
  'session:closed': { sessionId: string; reason?: string }
  'progress': ProgressInfo
  'menu:command': { command: string }
  'update:state': UpdateState
  /** The agent asks to open SQL in a new editor tab. */
  'editor:open': { sql: string; sessionId?: string }
}

/** An item of the native menu bar (macOS), described by the renderer that owns its commands. */
export interface NativeMenuItem {
  /** Sent back in `menu:command` when the item is clicked. */
  id?: string
  label?: string
  /** Electron accelerator, e.g. CmdOrCtrl+Shift+F. */
  accelerator?: string
  enabled?: boolean
  /** Checkbox items only. */
  checked?: boolean
  separator?: boolean
  submenu?: NativeMenuItem[]
}

export interface NativeMenu {
  /** Items at the top of the application menu (About, Settings). */
  app: NativeMenuItem[]
  menus: { label: string; items: NativeMenuItem[] }[]
}

/** Channel used to hand a session MessagePort to the renderer. */
export const SESSION_PORT_CHANNEL = 'session:port'

export interface PreloadApi {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcInvokeMap[C]['args']): Promise<IpcInvokeMap[C]['result']>
  on<E extends keyof IpcEventMap>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void
  platform: string
}
