import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { SqliteStore, historyRepository, settingsRepository, snippetRepository } from '@infrastructure/persistence/sqliteStore'
import { SafeStorageSecretStore } from '@infrastructure/security/safeStorageSecretStore'
import { ConnectionService } from '@application/connections/connectionService'
import { AgentService } from '@application/chat/agentService'
import { UpdateService } from '@application/update/updateService'
import { ElectronUpdateSource } from '@infrastructure/update/electronUpdateSource'
import { PreviewUpdateSource } from '@infrastructure/update/previewUpdateSource'
import { REPOSITORY_URL, type AppSettings } from '@shared/model'
import { SessionManager } from './sessions/sessionManager'
import { ProviderRegistry } from './providers'
import { createAgentGateway } from './agentGateway'
import { broadcast, registerIpc } from './ipc'
import { setDefaultAppMenu } from './appMenu'
import { createMainWindow, createSplashWindow } from './window'

// Tests run with an isolated profile directory.
if (process.env.OST_USER_DATA) app.setPath('userData', process.env.OST_USER_DATA)
else app.setPath('userData', join(app.getPath('appData'), 'Open SQL Tools'))

// One instance: a second launch focuses the existing window.
if (!process.env.OST_USER_DATA && !app.requestSingleInstanceLock()) app.quit()

app.setAppUserModelId('dev.opensqltools.app')

let mainWindow: BrowserWindow | null = null
let sessions: SessionManager | null = null

/**
 * Installed Windows and macOS builds check GitHub for a new release behind a splash on startup.
 * Windows downloads and installs it; macOS (unsigned, so Squirrel.Mac can't install it) opens the
 * release page in the browser and quits. OST_SPLASH_PREVIEW (update|offline|latest) shows the splash with
 * fake releases in dev.
 */
function createUpdates(settings: AppSettings): UpdateService | null {
  const preview = process.env.OST_SPLASH_PREVIEW
  const enabled = (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged && settings.checkForUpdates && !process.env.OST_USER_DATA
  if (!preview && !enabled) return null
  return new UpdateService({
    source: preview ? new PreviewUpdateSource(preview, () => app.quit()) : new ElectronUpdateSource(),
    currentVersion: app.getVersion(),
    emit: (state) => broadcast('update:state', state),
    openReleasePage: process.platform === 'darwin' ? (version) => shell.openExternal(`${REPOSITORY_URL}/releases/tag/v${version}`) : undefined
  })
}

async function bootstrap(): Promise<void> {
  const store = new SqliteStore(join(app.getPath('userData'), 'open-sql-tools.db'))
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

  const updates = createUpdates(settings.get())
  registerIpc({ store, settings, history: historyRepository(store), snippets: snippetRepository(store), secrets, connections, sessions, agent, providers, updates })

  nativeTheme.themeSource = settings.get().theme
  // The renderer draws its own menu bar in the title bar area; on macOS it fills the native one (menu:set).
  setDefaultAppMenu()

  // will-quit fires after every window has closed (and saved its bounds).
  app.on('will-quit', () => store.close())

  if (updates) {
    const splash = createSplashWindow()
    // "Restart now" quits the app and runs the installer; on macOS "Download" opens the release page
    // and quits, so the new disk image can replace the app.
    const outcome = await updates.run()
    if (outcome === 'install') return
    if (outcome === 'quit') return app.quit()
    openMainWindow(settings)
    splash.destroy()
  } else openMainWindow(settings)
}

function openMainWindow(settings: ReturnType<typeof settingsRepository>): void {
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
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(bootstrap)

app.on('window-all-closed', async () => {
  await sessions?.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && sessions) mainWindow = createMainWindow()
})
