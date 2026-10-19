import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings, type Theme } from '@shared/model'
import { api } from '../gateways/api'

const media = window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(theme: Theme): 'dark' | 'light' {
  return theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  // Switch instantly: suspend color transitions for a frame.
  root.classList.add('theme-switching')
  root.dataset.theme = resolveTheme(theme)
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
  void api.invoke('app:setNativeTheme', theme)
}

interface SettingsVM {
  settings: AppSettings
  loaded: boolean
  load(): Promise<void>
  update(patch: Partial<AppSettings>): Promise<void>
}

export const useSettings = create<SettingsVM>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const settings = await api.invoke('settings:get')
    applyTheme(settings.theme)
    set({ settings, loaded: true })
  },
  async update(patch) {
    const prev = get().settings
    const optimistic = { ...prev, ...patch, ai: { ...prev.ai, ...(patch.ai ?? {}) } }
    set({ settings: optimistic })
    if (patch.theme) applyTheme(patch.theme)
    set({ settings: await api.invoke('settings:set', patch) })
  }
}))

media.addEventListener('change', () => {
  const { settings } = useSettings.getState()
  if (settings.theme === 'system') applyTheme('system')
})
