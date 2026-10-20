import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, BarChart3, Gauge, RefreshCw, Search, SlidersHorizontal } from 'lucide-react'
import type { MaterializedResult } from '@shared/model'
import type { HostInfo } from '@shared/workerApi'
import { useWorkspace, type Tab } from '../../stores/workspaceStore'
import { Checkbox, Empty, IconButton, Input, SegmentedTabs, Spinner } from '../../components/ui'
import { ResultGrid } from '../../components/grid/ResultGrid'
import { PointMenu } from '../../components/ui/PointMenu'
import { ResultSet } from '../../lib/resultSet'
import { notify } from '../../stores/toast'
import { confirmDialog } from '../../components/ui/prompts'
import { EngineBadge } from '../common/EngineBadge'

type Section = 'variables' | 'status' | 'processes' | 'commandStats'

function filtered(r: MaterializedResult | undefined, q: string): ResultSet {
  if (!r) return new ResultSet()
  const needle = q.trim().toLowerCase()
  const rows = needle ? r.rows.filter((row) => row.some((v) => v !== null && String(v).toLowerCase().includes(needle))) : r.rows
  return ResultSet.fromRows(r.columns, rows)
}

export function HostView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation()
  const session = useWorkspace((s) => s.sessions[tab.sessionId])
  const [section, setSection] = useState<Section>('processes')
  const [info, setInfo] = useState<HostInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; row: number } | null>(null)

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    try {
      setInfo(await session.client.call('hostInfo', undefined))
    } catch (err) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (active && !info) void load()
  }, [active, info, load])

  useEffect(() => {
    if (!autoRefresh || !active) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [autoRefresh, active, load])

  const current = info ? (section === 'commandStats' ? info.commandStats : info[section]) : undefined
  const result = useMemo(() => filtered(current, filter), [current, filter])

  if (!session) return null

  const processId = (row: number): string | number | null => {
    const idx = result.columns.findIndex((c) => /^(id|pid)$/i.test(c.name))
    const v = result.get(idx >= 0 ? idx : 0, row)
    return v === null ? null : (v as string | number)
  }

  const kill = async (row: number, queryOnly: boolean): Promise<void> => {
    const id = processId(row)
    if (id === null) return
    if (!(await confirmDialog(t('host.kill'), t('host.killConfirm', { id })))) return
    try {
      await session.client.call('killProcess', { id, queryOnly })
      void load()
    } catch (err) {
      notify.error(err)
    }
  }

  const sections = [
    { value: 'processes' as const, label: t('host.processes'), icon: <Activity size={14} /> },
    { value: 'variables' as const, label: t('host.variables'), icon: <SlidersHorizontal size={14} /> },
    { value: 'status' as const, label: t('host.status'), icon: <Gauge size={14} /> },
    ...(info?.commandStats ? [{ value: 'commandStats' as const, label: t('host.commandStats'), icon: <BarChart3 size={14} /> }] : [])
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 py-3">
        <EngineBadge engine={session.info.engine} size={28} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{session.profile.name}</div>
          <div className="truncate text-xs text-muted">
            {session.info.label} · {session.info.currentUser} · {session.profile.engine === 'sqlite' ? session.profile.database : `${session.profile.host}:${session.profile.port}`}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pr-2">
        <SegmentedTabs value={section} onChange={setSection} items={sections} className="flex-1 border-b-0" />
        <div className="relative w-56">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('common.filter')} className="h-7 pl-7 text-xs" />
        </div>
        {section === 'processes' && <Checkbox checked={autoRefresh} onChange={setAutoRefresh} label={t('host.autoRefresh')} />}
        <IconButton label={t('common.refresh')} onClick={() => void load()}>
          {loading ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 border-t border-border">
        {current ? (
          <ResultGrid
            result={result}
            onContextMenu={section === 'processes' ? (e) => setMenu({ x: e.x, y: e.y, row: e.row }) : undefined}
          />
        ) : (
          <Empty title={loading ? t('common.loading') : t('errors.unsupported')} />
        )}
      </div>
      <PointMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={[
          { label: t('host.killQuery'), disabled: !session.info.capabilities.includes('killQuery'), onSelect: () => menu && void kill(menu.row, true) },
          { label: t('host.kill'), danger: true, onSelect: () => menu && void kill(menu.row, false) }
        ]}
      />
    </div>
  )
}
