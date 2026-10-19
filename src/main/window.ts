import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'

const DARK_BG = '#16171b'
const LIGHT_BG = '#f7f7f8'
// One pixel less than the 36px header so its bottom border stays visible under the window controls.
export const TITLE_BAR_HEIGHT = 35

export function applyTitleBarTheme(win: BrowserWindow): void {
  const dark = nativeTheme.shouldUseDarkColors
  win.setBackgroundColor(dark ? DARK_BG : LIGHT_BG)
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({ color: dark ? DARK_BG : LIGHT_BG, symbolColor: dark ? '#d4d4d8' : '#3f3f46', height: TITLE_BAR_HEIGHT })
  }
}

export function createMainWindow(bounds?: { x: number; y: number; width: number; height: number; maximized?: boolean }): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    width: bounds?.width ?? Math.min(1440, workAreaSize.width),
    height: bounds?.height ?? Math.min(900, workAreaSize.height),
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // Matches the theme so no white flash appears before the renderer paints.
    backgroundColor: dark ? DARK_BG : LIGHT_BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: dark ? DARK_BG : LIGHT_BG, symbolColor: dark ? '#d4d4d8' : '#3f3f46', height: TITLE_BAR_HEIGHT },
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  if (bounds?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // External links open in the system browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
