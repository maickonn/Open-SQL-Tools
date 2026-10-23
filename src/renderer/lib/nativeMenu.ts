import { useEffect, useRef } from 'react'
import type { NativeMenu, NativeMenuItem } from '@shared/ipc'
import type { MenuItem } from '../components/ui'
import { normalizeShortcut } from './shortcuts'
import { api } from '../gateways/api'

/** Shortcut text ("Ctrl+Shift+F") as an Electron accelerator: Ctrl is Command on macOS. */
export function toAccelerator(shortcut: string | undefined): string | undefined {
  const s = normalizeShortcut(shortcut ?? '')
  return s ? s.replace(/^Ctrl\+/, 'CmdOrCtrl+') : undefined
}

export interface NativeMenuSource {
  app: MenuItem[]
  menus: { label: string; items: MenuItem[] }[]
}

/** Serializable menus for the main process, plus the handlers of their items by id. */
export function toNativeMenu(source: NativeMenuSource): { menu: NativeMenu; handlers: Map<string, () => void> } {
  const handlers = new Map<string, () => void>()
  const convert = (items: MenuItem[], path: string): NativeMenuItem[] =>
    items.map((it, i) => {
      if (it.separator) return { separator: true }
      const id = `${path}.${i}`
      const label = typeof it.label === 'string' ? it.label : ''
      if (it.items) return { label, enabled: !it.disabled, submenu: convert(it.items, id) }
      if (it.onSelect) handlers.set(id, it.onSelect)
      return { id, label, accelerator: toAccelerator(it.shortcut), enabled: !it.disabled, checked: it.checked }
    })
  return {
    menu: { app: convert(source.app, 'app'), menus: source.menus.map((m, i) => ({ label: m.label, items: convert(m.items, String(i)) })) },
    handlers
  }
}

/** Keeps the macOS menu bar in step with the given menus (rebuilt only when they change). */
export function useNativeMenu(source: NativeMenuSource, enabled: boolean): void {
  const { menu, handlers } = toNativeMenu(source)
  const json = JSON.stringify(menu)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (enabled) void api.invoke('menu:set', JSON.parse(json) as NativeMenu)
  }, [enabled, json])

  useEffect(() => {
    if (!enabled) return
    return api.on('menu:command', ({ command }) => handlersRef.current.get(command)?.())
  }, [enabled])
}
