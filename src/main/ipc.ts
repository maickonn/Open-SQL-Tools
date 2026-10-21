import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { IpcChannel, IpcEventMap, IpcInvokeMap, SessionsFile } from '@shared/ipc'
import type { AppSettings } from '@shared/model'
import { resolveAiModel } from '@shared/model'
import type { HistoryRepository, SecretStore, SettingsRepository, SnippetRepository } from '@domain/ports/repositories'
import { secretKeys } from '@domain/ports/repositories'
import type { ConnectionService } from '@application/connections/connectionService'
import type { AgentService } from '@application/chat/agentService'
import type { UpdateService } from '@application/update/updateService'
import type { SqliteStore } from '@infrastructure/persistence/sqliteStore'
import type { SessionManager } from './sessions/sessionManager'
import { demoAi, type ProviderRegistry } from './providers'
import { applyTitleBarTheme } from './window'

export interface IpcServices {
  store: SqliteStore
  settings: SettingsRepository
  history: HistoryRepository
  snippets: SnippetRepository
  secrets: SecretStore
  connections: ConnectionService
  sessions: SessionManager
  agent: AgentService
  providers: ProviderRegistry
  /** Present only while the startup update splash runs. */
  updates: UpdateService | null
}

type Handler<C extends IpcChannel> = (e: IpcMainInvokeEvent, ...args: IpcInvokeMap[C]['args']) => Promise<IpcInvokeMap[C]['result']> | IpcInvokeMap[C]['result']

function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (e, ...args) => handler(e, ...(args as IpcInvokeMap[C]['args'])))
}

export function broadcast<E extends keyof IpcEventMap>(event: E, payload: IpcEventMap[E]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(event, payload)
}

const isHttpUrl = (u: string): boolean => /^https?:\/\//i.test(u)

export function registerIpc(s: IpcServices): void {
  /* Connections */
  handle('connections:list', () => s.connections.list())
  handle('connections:save', (_e, profile, secrets) => s.connections.save(profile, secrets))
  handle('connections:delete', (_e, id) => s.connections.delete(id))
  handle('connections:duplicate', (_e, id) => s.connections.duplicate(id))
  handle('connections:hasPassword', (_e, id) => s.connections.hasPassword(id))
  handle('connections:test', async (_e, profile, secrets) => {
    const stored = profile.id ? await s.connections.resolveSecrets(profile.id) : {}
    return s.sessions.test(profile, { ...stored, ...Object.fromEntries(Object.entries(secrets ?? {}).filter(([, v]) => v)) })
  })
  handle('connections:export', async (_e, filePath, ids) => {
    const file = s.connections.exportProfiles(ids)
    await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8')
    return file.connections.length
  })
  handle('connections:import', async (_e, filePath) => s.connections.importProfiles(JSON.parse(await readFile(filePath, 'utf8')) as SessionsFile))

  /* Sessions */
  handle('session:open', async (e, profileId, oneTimeSecrets) => {
    const profile = s.connections.get(profileId)
    const secrets = await s.connections.resolveSecrets(profileId, oneTimeSecrets)
    const session = await s.sessions.open(profile, secrets)
    s.connections.markConnected(profileId)
    s.sessions.attachRenderer(session.id, e.sender)
    return { sessionId: session.id, serverInfo: session.info }
  })
  handle('session:close', (_e, sessionId) => s.sessions.close(sessionId))
  handle('session:list', () => s.sessions.list())

  /* Settings and UI state */
  handle('settings:get', () => s.settings.get())
  handle('settings:set', (_e, patch) => {
    const current = s.settings.get()
    const next: AppSettings = { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) }, shortcuts: patch.shortcuts ?? current.shortcuts }
    s.settings.set(next)
    return next
  })
  handle('state:get', (_e, key) => s.settings.getState(key))
  handle('state:set', (_e, key, value) => s.settings.setState(key, value))

  /* History and snippets */
  handle('history:list', (_e, connectionId, search, limit) => s.history.list(connectionId, search, Math.min(limit, 5000)))
  handle('history:add', (_e, entry) => s.history.add(entry))
  handle('history:clear', (_e, connectionId) => s.history.clear(connectionId))
  handle('snippets:list', () => s.snippets.list())
  handle('snippets:save', (_e, snippet) => {
    const saved = { ...snippet, updatedAt: new Date().toISOString() }
    s.snippets.save(saved)
    return saved
  })
  handle('snippets:delete', (_e, id) => s.snippets.delete(id))

  /* AI */
  handle('ai:setKey', async (_e, provider, key) => {
    if (key) await s.secrets.set(secretKeys.aiKey(provider), key.trim())
    else await s.secrets.delete(secretKeys.aiKey(provider))
    s.providers.invalidate(provider)
  })
  handle('ai:hasKey', async (_e, provider) => demoAi() || (await s.secrets.has(secretKeys.aiKey(provider))))

  handle('chat:conversations', () => s.store.listConversations())
  handle('chat:create', (_e, init) => s.agent.createConversation(init))
  handle('chat:messages', (_e, id) => s.store.listMessages(id))
  handle('chat:delete', (_e, id) => {
    s.agent.cancel(id)
    s.store.deleteConversation(id)
  })
  handle('chat:update', (_e, id, patch) => {
    const c = s.store.getConversation(id)
    if (!c) throw new Error('Conversation not found')
    const next = { ...c, ...patch, updatedAt: new Date().toISOString() }
    next.model = resolveAiModel(next.provider, next.model)
    s.store.saveConversation(next)
    return next
  })
  // Fire and forget: progress arrives as chat:event broadcasts.
  handle('chat:send', (_e, p) => {
    void s.agent.send(p)
  })
  handle('chat:approve', (_e, callId, approved) => s.agent.approve(callId, approved))
  handle('chat:cancel', (_e, id) => s.agent.cancel(id))

  /* Files and shell */
  handle('dialog:openFile', async (e, options) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const r = win ? await dialog.showOpenDialog(win, { ...options, properties: ['openFile'] }) : await dialog.showOpenDialog({ ...options, properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle('dialog:saveFile', async (e, options) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return r.canceled ? null : (r.filePath ?? null)
  })
  handle('fs:readText', (_e, filePath) => readFile(filePath, 'utf8'))
  handle('fs:writeText', (_e, filePath, content) => writeFile(filePath, content, 'utf8'))
  handle('shell:showItem', (_e, filePath) => shell.showItemInFolder(filePath))
  handle('shell:openExternal', async (_e, url) => {
    if (!isHttpUrl(url)) throw new Error('Only http(s) links can be opened')
    await shell.openExternal(url)
  })

  /* App */
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: app.getPath('userData')
  }))

  /* Startup update splash */
  handle('update:getState', () => s.updates?.state ?? { phase: 'checking' as const, current: app.getVersion() })
  handle('update:download', () => s.updates?.download())
  handle('update:cancel', () => s.updates?.cancel())
  handle('update:skip', () => s.updates?.skip())
  handle('update:install', () => s.updates?.install())
  handle('edit:command', (e, command) => {
    const allowed = ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'] as const
    if (allowed.includes(command)) e.sender[command]()
  })
  handle('edit:canPaste', async () => (await clipboard.readText()).length > 0)
  handle('app:setNativeTheme', (e, theme) => {
    nativeTheme.themeSource = theme
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) applyTitleBarTheme(win)
  })
}

