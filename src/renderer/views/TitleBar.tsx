import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Database,
  FileDown,
  FileUp,
  FolderOpen,
  Moon,
  PanelBottom,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  Square,
  Sun,
  Users,
  Check
} from 'lucide-react'
import { IconButton, Menubar, cx, type MenuItem } from '../components/ui'
import { useConnections } from '../stores/connectionsStore'
import { useWorkspace } from '../stores/workspaceStore'
import { useUi } from '../stores/uiStore'
import { useChat } from '../stores/chatStore'
import { useSettings, resolveTheme } from '../stores/settingsStore'
import { commands } from './commands'
import { resolveShortcut } from '../lib/shortcuts'
import { api } from '../gateways/api'
import { useNativeMenu } from '../lib/nativeMenu'
import logo from '../assets/logo.svg'
import { isFileBased } from '@domain/engineTraits'

export function TitleBar() {
  const { t } = useTranslation()
  const activeSession = useWorkspace((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null))
  const activeTab = useWorkspace((s) => s.tabs.find((x) => x.id === s.activeTabId))
  const settings = useSettings((s) => s.settings)
  const ui = useUi()
  const chatOpen = useChat((s) => s.open)
  const isMac = api.platform === 'darwin'
  const theme = resolveTheme(settings.theme)
  const sid = activeSession?.id
  const sc = (id: string): string => resolveShortcut(id, settings.shortcuts)
  // The drag region swallows clicks before the page sees them, so it is disabled while a menu is open
  // to let a click anywhere on the title bar close the menu.
  const [menuOpen, setMenuOpen] = useState(false)

  const fileMenu: MenuItem[] = [
    { label: t('menu.sessionManager'), icon: <Database size={14} />, shortcut: sc('sessionManager'), onSelect: () => useConnections.getState().openDialog() },
    { label: t('menu.newQueryTab'), icon: <Plus size={14} />, shortcut: sc('newQuery'), disabled: !sid, onSelect: () => commands.newQuery() },
    { separator: true },
    { label: t('menu.openSqlFile'), icon: <FolderOpen size={14} />, shortcut: sc('openFile'), disabled: !sid, onSelect: () => commands.openSqlFile() },
    { label: t('menu.saveSqlFile'), icon: <Save size={14} />, shortcut: sc('save'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.saveSqlFile(false) },
    { label: t('menu.saveSqlFileAs'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.saveSqlFile(true) },
    { separator: true },
    { label: t('menu.closeTab'), shortcut: sc('closeTab'), disabled: !activeTab, onSelect: () => activeTab && useWorkspace.getState().closeTab(activeTab.id) },
    { label: t('menu.disconnect'), disabled: !sid, onSelect: () => sid && void useWorkspace.getState().closeSession(sid) },
    // macOS quits from the application menu.
    ...(isMac ? [] : [{ separator: true }, { label: t('menu.exit'), onSelect: () => window.close() }])
  ]

  const queryMenu: MenuItem[] = [
    { label: t('menu.runAll'), icon: <Play size={14} />, shortcut: sc('run'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.run('all') },
    { label: t('menu.runCurrent'), shortcut: sc('runCurrent'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.run('current') },
    { label: t('menu.runSelection'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.run('selection') },
    { label: t('menu.stop'), icon: <Square size={14} />, disabled: activeTab?.kind !== 'query', onSelect: () => commands.stop() },
    { label: t('menu.explain'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.explain() },
    { label: t('menu.format'), shortcut: sc('format'), disabled: activeTab?.kind !== 'query', onSelect: () => commands.format() },
    { separator: true },
    { label: t('menu.autocommit'), checked: activeSession?.autocommit ?? true, disabled: !sid, onSelect: () => commands.toggleAutocommit() },
    { label: t('menu.commit'), icon: <Check size={14} />, disabled: !sid, onSelect: () => commands.commit() },
    { label: t('menu.rollback'), icon: <RotateCcw size={14} />, disabled: !sid, onSelect: () => commands.rollback() }
  ]

  const toolsMenu: MenuItem[] = [
    { label: t('menu.exportGrid'), icon: <FileDown size={14} />, disabled: !sid, onSelect: () => commands.exportActive() },
    { label: t('menu.dumpSql'), disabled: !sid, onSelect: () => sid && ui.openDialog({ kind: 'dump', sessionId: sid }) },
    { label: t('menu.importSql'), icon: <FileUp size={14} />, disabled: !sid, onSelect: () => sid && ui.openDialog({ kind: 'importSql', sessionId: sid }) },
    { label: t('menu.importCsv'), disabled: !sid, onSelect: () => sid && ui.openDialog({ kind: 'importCsv', sessionId: sid }) },
    { separator: true },
    { label: t('menu.findText'), icon: <Search size={14} />, shortcut: sc('findText'), disabled: !sid, onSelect: () => sid && ui.openDialog({ kind: 'findText', sessionId: sid }) },
    { label: t('menu.userManager'), icon: <Users size={14} />, disabled: !sid || isFileBased(activeSession?.info.engine), onSelect: () => sid && ui.openDialog({ kind: 'users', sessionId: sid }) }
  ]
  const settingsItem: MenuItem = { label: t('menu.settings'), icon: <Settings size={14} />, shortcut: sc('settings'), onSelect: () => ui.openDialog({ kind: 'settings' }) }
  const aboutItem: MenuItem = { label: t('menu.about'), onSelect: () => ui.openDialog({ kind: 'about' }) }

  const viewMenu: MenuItem[] = [
    { label: t('menu.toggleSidebar'), checked: ui.sidebar, shortcut: sc('toggleSidebar'), onSelect: ui.toggleSidebar },
    { label: t('menu.toggleLog'), checked: ui.logPanel, shortcut: sc('toggleLog'), onSelect: ui.toggleLog },
    { label: t('menu.toggleChat'), checked: chatOpen, shortcut: sc('toggleChat'), onSelect: () => useChat.getState().toggle() },
    { separator: true },
    {
      label: t('menu.theme'),
      items: [
        { label: t('menu.themeDark'), checked: settings.theme === 'dark', onSelect: () => void useSettings.getState().update({ theme: 'dark' }) },
        { label: t('menu.themeLight'), checked: settings.theme === 'light', onSelect: () => void useSettings.getState().update({ theme: 'light' }) },
        { label: t('menu.themeSystem'), checked: settings.theme === 'system', onSelect: () => void useSettings.getState().update({ theme: 'system' }) }
      ]
    }
  ]

  const helpMenu: MenuItem[] = [{ label: t('menu.shortcuts'), onSelect: () => ui.openDialog({ kind: 'shortcuts' }) }]

  const menus = [
    { label: t('menu.file'), items: fileMenu },
    { label: t('menu.query'), items: queryMenu },
    // macOS keeps Settings and About in the application menu.
    { label: t('menu.tools'), items: isMac ? toolsMenu : [...toolsMenu, { separator: true }, settingsItem] },
    { label: t('menu.view'), items: viewMenu },
    { label: t('menu.help'), items: isMac ? helpMenu : [...helpMenu, aboutItem] }
  ]
  useNativeMenu(
    { app: [{ ...aboutItem, label: t('menu.aboutApp') }, { separator: true }, { ...settingsItem, label: t('menu.appSettings') }], menus },
    isMac
  )

  return (
    // macOS: the menus live in the system menu bar; the left padding clears the traffic lights and the
    // right one is only for the window controls Windows draws over the page.
    <header className={cx(!menuOpen && 'drag', 'flex h-9 shrink-0 items-center gap-1 border-b border-border bg-bg', isMac ? 'pl-20 pr-2' : 'pl-2 pr-[140px]')}>
      {!isMac && (
        <>
          <img src={logo} alt="" className="mr-1 h-5 w-5" draggable={false} />
          <Menubar className="no-drag" onOpenChange={setMenuOpen} menus={menus} />
        </>
      )}

      {/* Session, query tab, run and stop live in the menus and the query toolbar; only the pending transaction gets buttons here. */}
      {activeSession && !activeSession.autocommit && (
        <div className={cx('no-drag flex items-center gap-0.5', !isMac && 'ml-3 border-l border-border pl-2')}>
          <IconButton label={t('menu.commit')} onClick={() => commands.commit()}>
            <Check size={16} />
          </IconButton>
          <IconButton label={t('menu.rollback')} onClick={() => commands.rollback()}>
            <RotateCcw size={15} />
          </IconButton>
        </div>
      )}

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-0.5">
        <IconButton label={t('menu.toggleSidebar')} active={ui.sidebar} onClick={ui.toggleSidebar}>
          <PanelLeft size={16} />
        </IconButton>
        <IconButton label={t('menu.toggleLog')} active={ui.logPanel} onClick={ui.toggleLog}>
          <PanelBottom size={16} />
        </IconButton>
        <IconButton label={t('menu.toggleChat')} active={chatOpen} onClick={() => useChat.getState().toggle()}>
          <Bot size={16} />
        </IconButton>
        <IconButton
          label={t('menu.theme')}
          onClick={() => void useSettings.getState().update({ theme: theme === 'dark' ? 'light' : 'dark' })}
        >
          {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </IconButton>
        <IconButton label={t('menu.settings')} onClick={() => ui.openDialog({ kind: 'settings' })}>
          <Settings size={16} />
        </IconButton>
      </div>
    </header>
  )
}
