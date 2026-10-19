import { lazy, Suspense, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, FileCode2, Plus, Server, TerminalSquare, X } from 'lucide-react'
import { useWorkspace, type Tab } from '../../stores/workspaceStore'
import { useConnections } from '../../stores/connectionsStore'
import { ContextMenu, Button, Empty, IconButton, Spinner, cx } from '../../components/ui'
import { KIND_ICONS } from '../sidebar/ObjectTree'
import { HostView } from './HostView'
import { DatabaseView } from './DatabaseView'
import logo from '../../assets/logo.svg'

// Heavy views (Monaco editor) load on demand.
const QueryView = lazy(() => import('./QueryView'))
const ObjectView = lazy(() => import('./ObjectView'))
const ObjectListView = lazy(() => import('../object/ObjectListView'))

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'host') return <Server size={13} />
  if (tab.kind === 'database') return <Database size={13} className="text-warning" />
  if (tab.kind === 'query') return <TerminalSquare size={13} className="text-success" />
  const Icon = (tab.ref && KIND_ICONS[tab.ref.kind]) || (tab.listKind && KIND_ICONS[tab.listKind]) || FileCode2
  return <Icon size={13} className="text-accent" />
}

export function Workspace() {
  const { t } = useTranslation()
  const tabs = useWorkspace((s) => s.tabs)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const hasSessions = useWorkspace((s) => Object.keys(s.sessions).length > 0)
  const sessions = useWorkspace((s) => s.sessions)
  const ws = useWorkspace.getState
  const stripRef = useRef<HTMLDivElement>(null)

  if (!hasSessions) {
    return (
      <Empty icon={<img src={logo} alt="" className="h-16 w-16 opacity-90" />} title={t('welcome.title')}>
        <p className="max-w-sm text-[13px]">{t('welcome.subtitle')}</p>
        <Button variant="primary" className="mt-3" onClick={() => useConnections.getState().openDialog()}>
          {t('welcome.open')}
        </Button>
      </Empty>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        ref={stripRef}
        className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-panel px-1"
        onWheel={(e) => {
          if (stripRef.current) stripRef.current.scrollLeft += e.deltaY
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const color = sessions[tab.sessionId]?.profile.color
          return (
            <ContextMenu
              key={tab.id}
              items={[
                { label: t('menu.closeTab'), onSelect: () => ws().closeTab(tab.id) },
                { label: t('tabs.closeOthers'), onSelect: () => ws().tabs.filter((x) => x.id !== tab.id).forEach((x) => ws().closeTab(x.id)) },
                { label: t('tabs.pin'), disabled: !tab.preview, onSelect: () => ws().updateTab(tab.id, { preview: false }) }
              ]}
            >
              <div
                role="tab"
                aria-selected={active}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    ws().closeTab(tab.id)
                  }
                }}
                onClick={() => ws().activateTab(tab.id)}
                onDoubleClick={() => ws().updateTab(tab.id, { preview: false })}
                className={cx(
                  'group relative flex h-8 max-w-[220px] shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 pl-2.5 pr-1 text-[13px]',
                  active ? 'border-border bg-bg text-fg' : 'border-transparent text-muted hover:bg-hover hover:text-fg'
                )}
                style={active && color ? { boxShadow: `inset 0 2px 0 ${color}` } : undefined}
              >
                <TabIcon tab={tab} />
                <span className={cx('truncate', tab.preview && 'italic pr-[0.2em]')}>{tab.title}</span>
                <button
                  type="button"
                  aria-label={t('menu.closeTab')}
                  onClick={(e) => {
                    e.stopPropagation()
                    ws().closeTab(tab.id)
                  }}
                  className={cx('ml-0.5 rounded p-0.5 hover:bg-active', active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')}
                >
                  <X size={12} />
                </button>
              </div>
            </ContextMenu>
          )
        })}
        <IconButton label={t('menu.newQueryTab')} size={26} className="mb-1 ml-1" onClick={() => ws().newQueryTab()}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          // Inactive tabs stay mounted (hidden) so editors and grids keep their state.
          <div key={tab.id} className={cx('absolute inset-0', tab.id !== activeTabId && 'invisible pointer-events-none')}>
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner size={20} /></div>}>
              <TabContent tab={tab} active={tab.id === activeTabId} />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  )
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case 'host':
      return <HostView tab={tab} active={active} />
    case 'database':
      return <DatabaseView tab={tab} />
    case 'query':
      return <QueryView tab={tab} active={active} />
    case 'object':
      return <ObjectView tab={tab} active={active} />
    case 'list':
      return <ObjectListView tab={tab} active={active} />
  }
}
