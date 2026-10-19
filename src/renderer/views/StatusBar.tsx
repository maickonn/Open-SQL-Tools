import { useTranslation } from 'react-i18next'
import { CircleDot, Lock, Unlock } from 'lucide-react'
import { useWorkspace } from '../stores/workspaceStore'
import { cx } from '../components/ui'
import { commands } from './commands'

export function StatusBar() {
  const { t } = useTranslation()
  const session = useWorkspace((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null))
  const tab = useWorkspace((s) => s.tabs.find((x) => x.id === s.activeTabId))

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <CircleDot size={10} className={cx(session ? (session.lost ? 'text-danger' : 'text-success') : 'text-subtle')} />
        {session ? t('status.connected', { label: `${session.profile.name} · ${session.info.label}` }) : t('status.notConnected')}
      </span>
      {session && (
        <button type="button" onClick={() => void commands.toggleAutocommit()} className="flex items-center gap-1 hover:text-fg">
          {session.autocommit ? <Unlock size={11} /> : <Lock size={11} className="text-warning" />}
          {session.autocommit ? t('status.autocommitOn') : t('status.autocommitOff')}
        </button>
      )}
      {session?.inTransaction && <span className="text-warning">{t('status.inTransaction')}</span>}
      <div className="flex-1" />
      {tab?.database && <span>{tab.database}</span>}
      {session && <span>{session.info.currentUser}</span>}
    </footer>
  )
}
