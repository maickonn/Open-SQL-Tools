import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { join } from 'node:path'
import { SqliteStore, historyRepository, settingsRepository, snippetRepository } from '@infrastructure/persistence/sqliteStore'
import { SafeStorageSecretStore } from '@infrastructure/security/safeStorageSecretStore'
import { ConnectionService } from '@application/connections/connectionService'
import { AgentService } from '@application/chat/agentService'
import { SessionManager } from './sessions/sessionManager'
import { ProviderRegistry } from './providers'
import { createAgentGateway } from './agentGateway'
import { broadcast, registerIpc } from './ipc'
import { createMainWindow } from './window'

// Tests run with an isolated profile directory.
if (process.env.OST_USER_DATA) app.setPath('userData', process.env.OST_USER_DATA)
// Keep the profile directory from before the rename to Open SQL Tools (settings, connections, history).
else app.setPath('userData', join(app.getPath('appData'), 'Open SQL Tool'))

// One instance: a second launch focuses the existing window.
if (!process.env.OST_USER_DATA && !app.requestSingleInstanceLock()) app.quit()

app.setAppUserModelId('dev.opensqltool.app')

let mainWindow: BrowserWindow | null = null
let sessions: SessionManager | null = null

function bootstrap(): void {
  const store = new SqliteStore(join(app.getPath('userData'), 'open-sql-tool.db'))
  const settings = settingsRepository(store)
  const secrets = new SafeStorageSecretStore(store)
  sessions = new SessionManager((sessionId, reason) => broadcast('session:closed', { sessionId, reason }))
  const connections = new ConnectionService(store, secrets)
  const providers = new ProviderRegistry(secrets)
  const manager = sessions
  const agent = new AgentService({
    repo: store,
    provider: (id) => providers.get(id),
    gateway: (sessionId, database) => {
      const live = sessionId ? manager.get(sessionId) : undefined
      return live ? createAgentGateway(live, database, (sql) => broadcast('editor:open', { sql, sessionId })) : null
    },
    settings: () => settings.get(),
    emit: (event) => broadcast('chat:event', event)
  })

  registerIpc({ store, settings, history: historyRepository(store), snippets: snippetRepository(store), secrets, connections, sessions, agent, providers })

  nativeTheme.themeSource = settings.get().theme
  // The renderer draws its own menu bar in the title bar area.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)

  const bounds = settings.getState('window.bounds') as Parameters<typeof createMainWindow>[0]
  mainWindow = createMainWindow(bounds)
  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    settings.setState('window.bounds', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() })
  }
  mainWindow.on('close', persistBounds)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // will-quit fires after every window has closed (and saved its bounds).
  app.on('will-quit', () => store.close())
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(bootstrap)

app.on('window-all-closed', async () => {
  await sessions?.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && sessions) mainWindow = createMainWindow()
})
