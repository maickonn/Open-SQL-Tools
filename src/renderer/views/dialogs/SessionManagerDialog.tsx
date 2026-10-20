import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CopyPlus, Download, Folder, Plug, Plus, Search, Trash2, Upload, CheckCircle2 } from 'lucide-react'
import { ENGINE_LABELS, type ConnectionProfile, type DbEngine } from '@shared/model'
import { useConnections } from '../../stores/connectionsStore'
import { Button, Checkbox, Dialog, DropdownMenu, Field, IconButton, Input, SegmentedTabs, Select, Textarea, cx } from '../../components/ui'
import { EngineBadge } from '../common/EngineBadge'
import { confirmDialog } from '../../components/ui/prompts'
import { api } from '../../gateways/api'
import { notify } from '../../stores/toast'
import { isFileBased } from '@domain/engineTraits'
import { defaultSessionName, endpointLabel } from '../../lib/format'

const ENGINES: DbEngine[] = ['mysql', 'mariadb', 'postgres', 'firebird', 'sqlite']
const SQLITE_EXTENSIONS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3']
const COLORS = ['', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']

export function SessionManagerDialog() {
  const { t } = useTranslation()
  const vm = useConnections()
  const [filter, setFilter] = useState('')
  const [section, setSection] = useState<'settings' | 'ssh' | 'ssl' | 'advanced'>('settings')

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = vm.profiles.filter((p) => !f || p.name.toLowerCase().includes(f) || endpointLabel(p).toLowerCase().includes(f))
    const map = new Map<string, ConnectionProfile[]>()
    for (const p of list) {
      const k = p.folder ?? ''
      map.set(k, [...(map.get(k) ?? []), p])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [vm.profiles, filter])

  const d = vm.draft
  const fileBased = isFileBased(d?.engine)
  // SSH/SSL tabs do not exist for file-based engines: fall back to the settings tab.
  const activeSection = fileBased && (section === 'ssh' || section === 'ssl') ? 'settings' : section
  const set = (patch: Partial<ConnectionProfile>): void => vm.updateDraft(patch)
  const setOpt = (patch: Partial<ConnectionProfile['options']>): void => {
    if (d) set({ options: { ...d.options, ...patch } })
  }

  const exportSessions = async (): Promise<void> => {
    const file = await api.invoke('dialog:saveFile', { defaultPath: 'sessions.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (file) notify.success(t('sessions.exported', { count: await api.invoke('connections:export', file, []), file }))
  }
  const importSessions = async (): Promise<void> => {
    const file = await api.invoke('dialog:openFile', { filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!file) return
    try {
      const n = await api.invoke('connections:import', file)
      await vm.load()
      notify.success(t('sessions.imported', { count: n }))
    } catch (err) {
      notify.error(err)
    }
  }

  return (
    <Dialog
      open={vm.dialogOpen}
      onOpenChange={(o) => vm.openDialog(o)}
      title={t('sessions.title')}
      width={980}
      height={640}
      footer={
        <>
          {vm.testResult && (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 size={14} /> {t('sessions.testOk', { label: vm.testResult.label })}
            </span>
          )}
          <Button onClick={() => void vm.test()} disabled={!d} loading={vm.busy === 'test'}>
            {t('sessions.test')}
          </Button>
          <Button onClick={() => void vm.save()} disabled={!d || !vm.dirty} loading={vm.busy === 'save'}>
            {t('common.save')}
          </Button>
          <Button variant="primary" icon={<Plug size={14} />} onClick={() => void vm.connect()} disabled={!d} loading={vm.busy === 'connect'}>
            {t('sessions.connect')}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border">
          <div className="flex items-center gap-1 p-2">
            <DropdownMenu
              items={ENGINES.map((e) => ({ label: ENGINE_LABELS[e], icon: <EngineBadge engine={e} size={14} />, onSelect: () => vm.newProfile(e) }))}
              trigger={
                <Button size="sm" variant="primary" icon={<Plus size={13} />}>
                  {t('sessions.newSession')}
                  <ChevronDown size={12} />
                </Button>
              }
            />
            <div className="flex-1" />
            <IconButton label={t('common.duplicate')} disabled={!vm.selectedId} onClick={() => vm.selectedId && void vm.duplicate(vm.selectedId)}>
              <CopyPlus size={14} />
            </IconButton>
            <IconButton
              label={t('common.delete')}
              disabled={!vm.selectedId}
              onClick={async () => {
                const p = vm.profiles.find((x) => x.id === vm.selectedId)
                if (p && (await confirmDialog(t('common.delete'), t('sessions.deleteConfirm', { name: p.name }), true))) await vm.remove(p.id)
              }}
            >
              <Trash2 size={14} />
            </IconButton>
            <IconButton label={t('sessions.importSessions')} onClick={() => void importSessions()}>
              <Upload size={14} />
            </IconButton>
            <IconButton label={t('sessions.exportSessions')} onClick={() => void exportSessions()}>
              <Download size={14} />
            </IconButton>
          </div>
          <div className="relative px-2 pb-2">
            <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-[60%] text-subtle" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('sessions.filter')} className="h-7 pl-7 text-xs" />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            {!vm.profiles.length && <div className="p-4 text-center text-xs text-muted">{t('sessions.empty')}</div>}
            {groups.map(([folder, items]) => (
              <div key={folder}>
                {folder && (
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                    <Folder size={12} /> {folder}
                  </div>
                )}
                {items.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => void vm.select(p.id)}
                    onDoubleClick={() => void vm.connect(p.id)}
                    className={cx('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5', vm.selectedId === p.id ? 'bg-accent-soft' : 'hover:bg-hover')}
                  >
                    <EngineBadge engine={p.engine} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]" style={p.color ? { color: p.color } : undefined}>
                        {p.name}
                      </div>
                      <div className="truncate text-[11px] text-subtle">
                        {endpointLabel(p)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!d ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">{t('sessions.empty')}</div>
          ) : (
            <>
              <SegmentedTabs
                value={activeSection}
                onChange={setSection}
                items={[
                  { value: 'settings', label: t('sessions.settings') },
                  // A local database file has no network: no SSH tunnel or TLS.
                  ...(fileBased ? [] : [{ value: 'ssh' as const, label: t('sessions.ssh') }, { value: 'ssl' as const, label: t('sessions.ssl') }]),
                  { value: 'advanced', label: t('sessions.advanced') }
                ]}
              />
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {activeSection === 'settings' && (
                  <div className="grid grid-cols-6 gap-3">
                    <Field label={t('common.name')} className="col-span-4">
                      <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={defaultSessionName(d)} autoFocus />
                    </Field>
                    <Field label={t('sessions.engine')} className="col-span-2">
                      <Select value={d.engine} onChange={(e) => set({ engine: e.target.value as DbEngine })}>
                        {ENGINES.map((e) => (
                          <option key={e} value={e}>
                            {ENGINE_LABELS[e]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {fileBased ? (
                      <>
                        <Field label={t('sessions.databaseFile')} className="col-span-6">
                          <FileInput
                            value={d.database ?? ''}
                            save={!!d.options.createIfMissing}
                            filters={[{ name: t('sessions.sqliteFilter'), extensions: SQLITE_EXTENSIONS }, { name: '*', extensions: ['*'] }]}
                            onChange={(v) => set({ database: v })}
                          />
                        </Field>
                        <div className="col-span-6 flex gap-6">
                          <Checkbox checked={!!d.options.createIfMissing} disabled={!!d.options.readOnly} onChange={(v) => setOpt({ createIfMissing: v || undefined })} label={t('sessions.createIfMissing')} />
                          <Checkbox checked={!!d.options.readOnly} onChange={(v) => setOpt({ readOnly: v || undefined, createIfMissing: v ? undefined : d.options.createIfMissing })} label={t('sessions.readOnly')} />
                        </div>
                      </>
                    ) : (
                      <>
                        <Field label={t('sessions.host')} className="col-span-4">
                          <Input value={d.host} onChange={(e) => set({ host: e.target.value })} />
                        </Field>
                        <Field label={t('sessions.port')} className="col-span-2">
                          <Input type="number" value={d.port} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
                        </Field>
                        <Field label={t('sessions.user')} className="col-span-3">
                          <Input value={d.user} onChange={(e) => set({ user: e.target.value })} />
                        </Field>
                        <Field label={t('sessions.password')} className="col-span-3" hint={vm.hasStoredPassword && !vm.secrets.password ? t('sessions.passwordSaved') : undefined}>
                          <Input type="password" value={vm.secrets.password ?? ''} placeholder={vm.hasStoredPassword ? '••••••••' : ''} onChange={(e) => vm.setSecret('password', e.target.value)} />
                        </Field>
                        <Field
                          label={d.engine === 'firebird' ? t('sessions.databaseFb') : d.engine === 'postgres' ? t('sessions.databasePg') : t('sessions.database')}
                          className="col-span-6"
                        >
                          <Input
                            value={d.engine === 'mysql' || d.engine === 'mariadb' ? (d.databaseFilter?.join(';') ?? d.database ?? '') : (d.database ?? '')}
                            placeholder={d.engine === 'firebird' ? '/var/lib/firebird/data/app.fdb' : d.engine === 'postgres' ? 'postgres' : 'db1;db2 (empty = all)'}
                            onChange={(e) => {
                              if (d.engine === 'mysql' || d.engine === 'mariadb') {
                                const list = e.target.value.split(';').map((s) => s.trim()).filter(Boolean)
                                set({ databaseFilter: list.length ? list : undefined, database: list[0] })
                              } else set({ database: e.target.value })
                            }}
                          />
                        </Field>
                        <div className="col-span-6">
                          <Checkbox checked={d.savePassword} onChange={(v) => set({ savePassword: v })} label={t('sessions.savePassword')} />
                        </div>
                      </>
                    )}
                    <Field label={t('sessions.folder')} className="col-span-3">
                      <Input value={d.folder ?? ''} onChange={(e) => set({ folder: e.target.value || undefined })} list="session-folders" />
                    </Field>
                    <datalist id="session-folders">
                      {[...new Set(vm.profiles.map((p) => p.folder).filter(Boolean))].map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                    <Field label={t('sessions.color')} className="col-span-3">
                      <div className="flex h-8 items-center gap-1.5">
                        {COLORS.map((c) => (
                          <button
                            key={c || 'none'}
                            type="button"
                            onClick={() => set({ color: c || undefined })}
                            className={cx('h-5 w-5 rounded-full border', (d.color ?? '') === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-panel' : 'border-border')}
                            style={{ background: c || 'transparent' }}
                          />
                        ))}
                      </div>
                    </Field>
                    {d.lastConnectedAt && (
                      <div className="col-span-6 text-[11px] text-subtle">
                        {t('sessions.lastConnected')}: {new Date(d.lastConnectedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}

                {activeSection === 'ssh' && (
                  <div className="grid grid-cols-6 gap-3">
                    <div className="col-span-6">
                      <Checkbox checked={d.ssh.enabled} onChange={(v) => set({ ssh: { ...d.ssh, enabled: v } })} label={t('sessions.useSsh')} />
                    </div>
                    <Field label={t('sessions.sshHost')} className="col-span-4">
                      <Input disabled={!d.ssh.enabled} value={d.ssh.host} onChange={(e) => set({ ssh: { ...d.ssh, host: e.target.value } })} />
                    </Field>
                    <Field label={t('sessions.sshPort')} className="col-span-2">
                      <Input disabled={!d.ssh.enabled} type="number" value={d.ssh.port} onChange={(e) => set({ ssh: { ...d.ssh, port: Number(e.target.value) || 22 } })} />
                    </Field>
                    <Field label={t('sessions.sshUser')} className="col-span-3">
                      <Input disabled={!d.ssh.enabled} value={d.ssh.user} onChange={(e) => set({ ssh: { ...d.ssh, user: e.target.value } })} />
                    </Field>
                    <Field label={t('sessions.sshAuth')} className="col-span-3">
                      <Select disabled={!d.ssh.enabled} value={d.ssh.authMethod} onChange={(e) => set({ ssh: { ...d.ssh, authMethod: e.target.value as 'password' | 'key' | 'agent' } })}>
                        <option value="password">{t('sessions.sshPassword')}</option>
                        <option value="key">{t('sessions.sshKey')}</option>
                        <option value="agent">{t('sessions.sshAgent')}</option>
                      </Select>
                    </Field>
                    {d.ssh.authMethod === 'password' && (
                      <Field label={t('sessions.sshPassword')} className="col-span-6">
                        <Input disabled={!d.ssh.enabled} type="password" value={vm.secrets.sshPassword ?? ''} onChange={(e) => vm.setSecret('sshPassword', e.target.value)} />
                      </Field>
                    )}
                    {d.ssh.authMethod === 'key' && (
                      <>
                        <Field label={t('sessions.sshKey')} className="col-span-4">
                          <FileInput disabled={!d.ssh.enabled} value={d.ssh.privateKeyPath ?? ''} onChange={(v) => set({ ssh: { ...d.ssh, privateKeyPath: v } })} />
                        </Field>
                        <Field label={t('sessions.sshPassphrase')} className="col-span-2">
                          <Input disabled={!d.ssh.enabled} type="password" value={vm.secrets.sshPassphrase ?? ''} onChange={(e) => vm.setSecret('sshPassphrase', e.target.value)} />
                        </Field>
                      </>
                    )}
                  </div>
                )}

                {activeSection === 'ssl' && (
                  <div className="grid grid-cols-6 gap-3">
                    <div className="col-span-6 flex gap-6">
                      <Checkbox checked={d.ssl.enabled} onChange={(v) => set({ ssl: { ...d.ssl, enabled: v } })} label={t('sessions.useSsl')} />
                      <Checkbox disabled={!d.ssl.enabled} checked={d.ssl.rejectUnauthorized} onChange={(v) => set({ ssl: { ...d.ssl, rejectUnauthorized: v } })} label={t('sessions.sslVerify')} />
                    </div>
                    <Field label={t('sessions.sslCa')} className="col-span-6">
                      <FileInput disabled={!d.ssl.enabled} value={d.ssl.caPath ?? ''} onChange={(v) => set({ ssl: { ...d.ssl, caPath: v || undefined } })} />
                    </Field>
                    <Field label={t('sessions.sslCert')} className="col-span-6">
                      <FileInput disabled={!d.ssl.enabled} value={d.ssl.certPath ?? ''} onChange={(v) => set({ ssl: { ...d.ssl, certPath: v || undefined } })} />
                    </Field>
                    <Field label={t('sessions.sslKey')} className="col-span-6">
                      <FileInput disabled={!d.ssl.enabled} value={d.ssl.keyPath ?? ''} onChange={(v) => set({ ssl: { ...d.ssl, keyPath: v || undefined } })} />
                    </Field>
                  </div>
                )}

                {activeSection === 'advanced' && (
                  <div className="grid grid-cols-6 gap-3">
                    {!fileBased && (
                      <>
                        <Field label={t('sessions.charset')} className="col-span-2">
                          <Input value={d.options.charset ?? ''} placeholder={d.engine === 'firebird' ? 'UTF8' : d.engine === 'postgres' ? 'UTF8' : 'utf8mb4'} onChange={(e) => setOpt({ charset: e.target.value || undefined })} />
                        </Field>
                        <Field label={t('sessions.timeout')} className="col-span-2">
                          <Input type="number" value={d.options.connectTimeoutSec ?? 15} onChange={(e) => setOpt({ connectTimeoutSec: Number(e.target.value) || 15 })} />
                        </Field>
                        <Field label={t('sessions.keepAlive')} className="col-span-2">
                          <Input type="number" value={d.options.keepAliveSec ?? 0} onChange={(e) => setOpt({ keepAliveSec: Number(e.target.value) || 0 })} />
                        </Field>
                      </>
                    )}
                    {d.engine === 'firebird' && (
                      <>
                        <Field label={t('sessions.role')} className="col-span-2">
                          <Input value={d.options.role ?? ''} onChange={(e) => setOpt({ role: e.target.value || undefined })} />
                        </Field>
                        <Field label={t('sessions.wireCrypt')} className="col-span-2">
                          <Select value={d.options.wireCrypt ?? 'enabled'} onChange={(e) => setOpt({ wireCrypt: e.target.value as 'enabled' | 'disabled' })}>
                            <option value="enabled">Enabled</option>
                            <option value="disabled">Disabled</option>
                          </Select>
                        </Field>
                        <div className="col-span-2 flex items-end pb-1.5">
                          <Checkbox checked={!!d.options.wireCompression} onChange={(v) => setOpt({ wireCompression: v })} label={t('sessions.wireCompression')} />
                        </div>
                      </>
                    )}
                    <Field label={t('sessions.startupScript')} className="col-span-6">
                      <Textarea rows={6} value={d.options.startupScript ?? ''} onChange={(e) => setOpt({ startupScript: e.target.value || undefined })} />
                    </Field>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  )
}

export function FileInput({
  value,
  onChange,
  disabled,
  filters,
  save
}: {
  value: string
  onChange(v: string): void
  disabled?: boolean
  filters?: { name: string; extensions: string[] }[]
  /** Pick a file that may not exist yet (save dialog). */
  save?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-1.5">
      <Input disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
      <Button
        disabled={disabled}
        onClick={async () => {
          const f = await api.invoke(save ? 'dialog:saveFile' : 'dialog:openFile', { filters, defaultPath: value || undefined })
          if (f) onChange(f)
        }}
      >
        {t('common.browse')}
      </Button>
    </div>
  )
}
