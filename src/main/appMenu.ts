import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { NativeMenu, NativeMenuItem } from '@shared/ipc'

/** Before the renderer sends its menus: the standard macOS menus, so editing shortcuts work at once. */
export function setDefaultAppMenu(): void {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
}

/**
 * macOS menu bar built from the renderer's menus (File, Query, Tools, View, Help), around the
 * standard application, Edit and Window menus. A click sends the item id back to the window.
 */
export function setAppMenu(menu: NativeMenu, win: BrowserWindow): void {
  const toItem = (it: NativeMenuItem): MenuItemConstructorOptions => {
    if (it.separator) return { type: 'separator' }
    if (it.submenu) return { label: it.label, enabled: it.enabled, submenu: it.submenu.map(toItem) }
    return {
      label: it.label,
      accelerator: it.accelerator,
      enabled: it.enabled,
      type: it.checked === undefined ? 'normal' : 'checkbox',
      checked: it.checked,
      click: () => {
        if (!win.isDestroyed() && it.id) win.webContents.send('menu:command', { command: it.id })
      }
    }
  }
  const menus = menu.menus.map((m): MenuItemConstructorOptions => ({ label: m.label, submenu: m.items.map(toItem) }))
  const help = menus.pop()
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        ...menu.app.map(toItem),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    // Edit follows File, as in every Mac app; Help stays last, after Window.
    ...menus.slice(0, 1),
    { role: 'editMenu' },
    ...menus.slice(1),
    { role: 'windowMenu' },
    ...(help ? [{ ...help, role: 'help' as const }] : [])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
