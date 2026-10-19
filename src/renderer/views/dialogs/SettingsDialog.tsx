import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, KeyRound } from 'lucide-react'
import type { AiProviderId, AppSettings } from '@shared/model'
import { useSettings } from '../../stores/settingsStore'
import { useChat } from '../../stores/chatStore'
import { useUi } from '../../stores/uiStore'
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, cx } from '../../components/ui'
import { api } from '../../gateways/api'
import { SHORTCUT_ACTIONS, normalizeShortcut, resolveShortcut, shortcutFromEvent } from '../../lib/shortcuts'
import { notify } from '../../stores/toast'

type Section = 'general' | 'editor' | 'grid' | 'shortcuts' | 'ai'

export function SettingsDialog({ section: initial }: { section?: string }) {
  const { t } = useTranslation()
  const { settings, update } = useSettings()
  const close = useUi((s) => s.closeDialog)
  const [section, setSection] = useState<Section>((initial as Section) ?? 'general')
  const set = (patch: Partial<AppSettings>): void => void update(patch)
  const setAi = (patch: Partial<AppSettings['ai']>): void => void update({ ai: { ...settings.ai, ...patch } })

  const nav: { id: Section; label: string }[] = [
    { id: 'general', label: t('settings.general') },
    { id: 'editor', label: t('settings.editor') },
    { id: 'grid', label: t('settings.grid') },
    { id: 'shortcuts', label: t('keys.title') },
    { id: 'ai', label: t('settings.ai') }
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={t('settings.title')} width={760} height={560} footer={<Button variant="primary" onClick={close}>{t('common.close')}</Button>}>
      <div className="flex h-full">
        <nav className="w-44 shrink-0 border-r border-border p-2">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              className={cx('block w-full rounded-md px-3 py-1.5 text-left text-[13px]', section === n.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto p-5">
          {section === 'general' && (
            <div className="grid max-w-md gap-4">
              <Field label={t('settings.theme')}>
                <Select value={settings.theme} onChange={(e) => set({ theme: e.target.value as AppSettings['theme'] })}>
                  <option value="dark">{t('menu.themeDark')}</option>
                  <option value="light">{t('menu.themeLight')}</option>
                  <option value="system">{t('menu.themeSystem')}</option>
                </Select>
              </Field>
              <Checkbox checked={settings.confirmDangerousQueries} onChange={(v) => set({ confirmDangerousQueries: v })} label={t('settings.confirmDangerous')} />
              <Checkbox checked={settings.restoreTabs} onChange={(v) => set({ restoreTabs: v })} label={t('settings.restoreTabs')} />
            </div>
          )}
          {section === 'editor' && (
            <div className="grid max-w-md gap-4">
              <Field label={t('settings.fontSize')}>
                <Input type="number" min={9} max={28} value={settings.editorFontSize} onChange={(e) => set({ editorFontSize: Number(e.target.value) || 13 })} />
              </Field>
              <Field label={t('settings.fontFamily')}>
                <Input value={settings.editorFontFamily} onChange={(e) => set({ editorFontFamily: e.target.value })} />
              </Field>
              <Field label={t('settings.maxRows')}>
                <Input type="number" min={1} value={settings.maxRowsQuery} onChange={(e) => set({ maxRowsQuery: Math.max(1, Number(e.target.value) || 1) })} />
              </Field>
            </div>
          )}
          {section === 'grid' && (
            <div className="grid max-w-md gap-4">
              <Field label={t('settings.fontSize')}>
                <Input type="number" min={9} max={24} value={settings.gridFontSize} onChange={(e) => set({ gridFontSize: Number(e.target.value) || 12 })} />
              </Field>
              <Field label={t('settings.pageSize')}>
                <Input type="number" min={10} value={settings.dataPageSize} onChange={(e) => set({ dataPageSize: Math.max(10, Number(e.target.value) || 1000) })} />
              </Field>
              <Field label={t('settings.nullText')}>
                <Input value={settings.nullText} onChange={(e) => set({ nullText: e.target.value })} />
              </Field>
            </div>
          )}
          {section === 'shortcuts' && <ShortcutEditor overrides={settings.shortcuts} onChange={(shortcuts) => set({ shortcuts })} />}
          {section === 'ai' && (
            <div className="grid max-w-xl gap-5">
              <KeyEditor provider="anthropic" label={t('settings.anthropicKey')} />
              <KeyEditor provider="openai" label={t('settings.openaiKey')} />
              <Field label={t('settings.defaultProvider')}>
                <Select value={settings.ai.defaultProvider} onChange={(e) => setAi({ defaultProvider: e.target.value as AiProviderId })}>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('settings.effort')}>
                  <Select value={settings.ai.effort} onChange={(e) => setAi({ effort: e.target.value as AppSettings['ai']['effort'] })}>
                    <option value="low">{t('settings.low')}</option>
                    <option value="medium">{t('settings.medium')}</option>
                    <option value="high">{t('settings.high')}</option>
                  </Select>
                </Field>
                <Field label={t('settings.maxRowsModel')}>
                  <Input type="number" min={1} max={1000} value={settings.ai.maxRowsToModel} onChange={(e) => setAi({ maxRowsToModel: Math.min(1000, Math.max(1, Number(e.target.value) || 200)) })} />
                </Field>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function KeyEditor({ provider, label }: { provider: AiProviderId; label: string }) {
  const { t } = useTranslation()
  const [has, setHas] = useState(false)
  const [value, setValue] = useState('')
  const refresh = (): void => void api.invoke('ai:hasKey', provider).then(setHas)
  useEffect(refresh, [provider])
  const save = async (key: string | null): Promise<void> => {
    try {
      await api.invoke('ai:setKey', provider, key)
      setValue('')
      refresh()
      void useChat.getState().refreshKeys()
    } catch (err) {
      notify.error(err)
    }
  }
  return (
    <Field label={<span className="flex items-center gap-2">{label} {has ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" />{t('settings.keySaved')}</Badge> : <Badge>{t('settings.keyMissing')}</Badge>}</span>}>
      <div className="flex gap-1.5">
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={has ? '••••••••••••' : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
        <Button icon={<KeyRound size={13} />} disabled={!value.trim()} onClick={() => void save(value.trim())}>
          {t('settings.setKey')}
        </Button>
        {has && (
          <Button variant="danger" onClick={() => void save(null)}>
            {t('settings.clearKey')}
          </Button>
        )}
      </div>
    </Field>
  )
}

function ShortcutEditor({ overrides, onChange }: { overrides: Record<string, string>; onChange(v: Record<string, string>): void }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState<string | null>(null)
  const effective = (id: string): string => normalizeShortcut(resolveShortcut(id, overrides))
  const conflictFor = (id: string): string | undefined => {
    const mine = effective(id)
    if (!mine) return undefined
    return SHORTCUT_ACTIONS.find((a) => a.id !== id && effective(a.id) === mine)?.label
  }
  const label = (a: (typeof SHORTCUT_ACTIONS)[number]): string => (a.id === 'prevTab' ? `${t(a.label)} (←)` : a.id === 'nextTab' ? `${t(a.label)} (→)` : t(a.label))
  return (
    <div className="grid gap-2">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onChange({})}>{t('keys.resetAll')}</Button>
      </div>
      <table className="w-full text-[13px]">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">{t('keys.action')}</th>
            <th className="w-56 py-1 font-medium">{t('keys.shortcut')}</th>
            <th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_ACTIONS.map((a) => {
            const conflict = conflictFor(a.id)
            return (
              <tr key={a.id} className="border-t border-border">
                <td className="py-1.5">{label(a)}</td>
                <td>
                  <input
                    readOnly
                    data-shortcut-capture
                    value={recording === a.id ? t('keys.press') : effective(a.id)}
                    onFocus={() => setRecording(a.id)}
                    onBlur={() => setRecording(null)}
                    onKeyDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (e.key === 'Escape') return (e.target as HTMLInputElement).blur()
                      if (e.key === 'Backspace' || e.key === 'Delete') {
                        onChange({ ...overrides, [a.id]: '' })
                        return (e.target as HTMLInputElement).blur()
                      }
                      const combo = shortcutFromEvent(e.nativeEvent)
                      if (!combo) return
                      onChange({ ...overrides, [a.id]: combo })
                      ;(e.target as HTMLInputElement).blur()
                    }}
                    className={cx('h-7 w-full rounded-md border bg-sunken px-2 font-mono text-xs outline-none focus:border-accent', conflict ? 'border-danger' : 'border-border')}
                    title={conflict ? t('keys.conflict', { action: t(conflict) }) : undefined}
                  />
                </td>
                <td className="pl-2">
                  {Object.prototype.hasOwnProperty.call(overrides, a.id) && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      const next = { ...overrides }
                      delete next[a.id]
                      onChange(next)
                    }}>
                      {t('keys.reset')}
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
