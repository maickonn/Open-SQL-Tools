/**
 * Keyboard shortcut registry. Defaults can be overridden in settings (AppSettings.shortcuts),
 * stored as normalized strings such as "Ctrl+Shift+Enter".
 */
export type ShortcutScope = 'global' | 'editor'

export interface ShortcutAction {
  id: string
  /** i18n key of the action label. */
  label: string
  default: string
  scope: ShortcutScope
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'sessionManager', label: 'menu.sessionManager', default: 'Ctrl+N', scope: 'global' },
  { id: 'newQuery', label: 'menu.newQueryTab', default: 'Ctrl+T', scope: 'global' },
  { id: 'closeTab', label: 'menu.closeTab', default: 'Ctrl+W', scope: 'global' },
  { id: 'openFile', label: 'menu.openSqlFile', default: 'Ctrl+O', scope: 'global' },
  { id: 'nextTab', label: 'tabs.nextPrev', default: 'Ctrl+Tab', scope: 'global' },
  { id: 'prevTab', label: 'tabs.nextPrev', default: 'Ctrl+Shift+Tab', scope: 'global' },
  { id: 'toggleSidebar', label: 'menu.toggleSidebar', default: 'Ctrl+B', scope: 'global' },
  { id: 'toggleLog', label: 'menu.toggleLog', default: 'Ctrl+J', scope: 'global' },
  { id: 'toggleChat', label: 'menu.toggleChat', default: 'Ctrl+L', scope: 'global' },
  { id: 'findText', label: 'menu.findText', default: 'Ctrl+Shift+H', scope: 'global' },
  { id: 'settings', label: 'menu.settings', default: 'Ctrl+,', scope: 'global' },
  { id: 'refresh', label: 'common.refresh', default: 'F5', scope: 'global' },
  { id: 'format', label: 'menu.format', default: 'Ctrl+Shift+F', scope: 'global' },
  { id: 'run', label: 'menu.runAll', default: 'Ctrl+Enter', scope: 'editor' },
  { id: 'runCurrent', label: 'menu.runCurrent', default: 'Ctrl+Shift+Enter', scope: 'editor' },
  { id: 'runSelection', label: 'menu.runSelection', default: '', scope: 'editor' },
  { id: 'explain', label: 'menu.explain', default: '', scope: 'editor' },
  { id: 'save', label: 'menu.saveSqlFile', default: 'Ctrl+S', scope: 'editor' }
]

export function resolveShortcut(id: string, overrides: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id]
  return SHORTCUT_ACTIONS.find((a) => a.id === id)?.default ?? ''
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'])

/** Normalized shortcut for a keyboard event, or '' for modifier-only presses. */
export function shortcutFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  if (MODIFIER_KEYS.has(e.key)) return ''
  let key: string
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (e.key === ' ') key = 'Space'
  else if (e.key.length === 1) key = e.key.toUpperCase()
  else key = e.key
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function normalizeShortcut(s: string): string {
  if (!s) return ''
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((p) => (/^(cmd|meta|control|ctrl)$/i.test(p) ? 'Ctrl' : p[0].toUpperCase() + p.slice(1).toLowerCase())))
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)].join('+')
}

/** Finds the action bound to an event within the given scopes. */
export function actionForEvent(e: KeyboardEvent, overrides: Record<string, string>, scopes: ShortcutScope[]): string | null {
  const pressed = shortcutFromEvent(e)
  if (!pressed) return null
  for (const a of SHORTCUT_ACTIONS) {
    if (!scopes.includes(a.scope)) continue
    const bound = normalizeShortcut(resolveShortcut(a.id, overrides))
    if (bound && bound === pressed) return a.id
  }
  return null
}
