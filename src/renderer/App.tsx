import { lazy, Suspense, useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { TooltipProvider } from './components/ui'
import { PromptHost } from './components/ui/prompts'
import { TitleBar } from './views/TitleBar'
import { ObjectTree } from './views/sidebar/ObjectTree'
import { Workspace } from './views/workspace/Workspace'
import { LogPanel } from './views/LogPanel'
import { StatusBar } from './views/StatusBar'
import { SessionManagerDialog } from './views/dialogs/SessionManagerDialog'
import { useUi } from './stores/uiStore'
import { useChat } from './stores/chatStore'
import { useConnections } from './stores/connectionsStore'
import { useWorkspace } from './stores/workspaceStore'
import { useSettings, resolveTheme } from './stores/settingsStore'
import { commands } from './views/commands'
import { actionForEvent } from './lib/shortcuts'

// Loaded on first use to keep startup light.
const ChatPanel = lazy(() => import('./views/chat/ChatPanel').then((m) => ({ default: m.ChatPanel })))
const SettingsDialog = lazy(() => import('./views/dialogs/SettingsDialog').then((m) => ({ default: m.SettingsDialog })))
const tools = () => import('./views/dialogs/ToolDialogs')
const ExportDialog = lazy(() => tools().then((m) => ({ default: m.ExportDialog })))
const DumpDialog = lazy(() => tools().then((m) => ({ default: m.DumpDialog })))
const ImportSqlDialog = lazy(() => tools().then((m) => ({ default: m.ImportSqlDialog })))
const ImportCsvDialog = lazy(() => tools().then((m) => ({ default: m.ImportCsvDialog })))
const FindTextDialog = lazy(() => tools().then((m) => ({ default: m.FindTextDialog })))
const UsersDialog = lazy(() => tools().then((m) => ({ default: m.UsersDialog })))
const tableDialogs = () => import('./views/dialogs/TableDialogs')
const BulkEditDialog = lazy(() => tableDialogs().then((m) => ({ default: m.BulkEditDialog })))
const CopyTableDialog = lazy(() => tableDialogs().then((m) => ({ default: m.CopyTableDialog })))
const AboutDialog = lazy(() => tools().then((m) => ({ default: m.AboutDialog })))
const ShortcutsDialog = lazy(() => tools().then((m) => ({ default: m.ShortcutsDialog })))

function DialogHost() {
  return (
    <Suspense fallback={null}>
      <DialogSwitch />
    </Suspense>
  )
}

function DialogSwitch() {
  const d = useUi((s) => s.dialog)
  if (!d) return null
  switch (d.kind) {
    case 'settings':
      return <SettingsDialog section={d.section} />
    case 'export':
      return <ExportDialog d={d} />
    case 'dump':
      return <DumpDialog d={d} />
    case 'importSql':
      return <ImportSqlDialog d={d} />
    case 'importCsv':
      return <ImportCsvDialog d={d} />
    case 'findText':
      return <FindTextDialog d={d} />
    case 'users':
      return <UsersDialog d={d} />
    case 'bulkEdit':
      return <BulkEditDialog d={d} />
    case 'copyTable':
      return <CopyTableDialog d={d} />
    case 'about':
      return <AboutDialog />
    case 'shortcuts':
      return <ShortcutsDialog />
  }
}

/** Global keyboard shortcuts, resolved through the customizable registry (editor ones live in SqlEditor). */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The shortcut editor records keys itself.
      if ((e.target as HTMLElement | null)?.closest?.('[data-shortcut-capture]')) return
      const id = actionForEvent(e, useSettings.getState().settings.shortcuts, ['global'])
      if (!id) return
      const ws = useWorkspace.getState()
      const ui = useUi.getState()
      const cycle = (dir: 1 | -1): void => {
        if (!ws.tabs.length) return
        const idx = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
        ws.activateTab(ws.tabs[(idx + dir + ws.tabs.length) % ws.tabs.length].id)
      }
      const handlers: Record<string, () => void> = {
        sessionManager: () => useConnections.getState().openDialog(),
        newQuery: () => commands.newQuery(),
        closeTab: () => commands.closeActiveTab(),
        openFile: () => void commands.openSqlFile(),
        nextTab: () => cycle(1),
        prevTab: () => cycle(-1),
        toggleSidebar: () => ui.toggleSidebar(),
        toggleLog: () => ui.toggleLog(),
        toggleChat: () => useChat.getState().toggle(),
        settings: () => ui.openDialog({ kind: 'settings' }),
        findText: () => ws.activeSessionId && ui.openDialog({ kind: 'findText', sessionId: ws.activeSessionId }),
        format: () => commands.format(),
        refresh: () => {
          const tab = ws.tabs.find((t) => t.id === ws.activeTabId)
          if (tab && (tab.database !== undefined || tab.kind === 'database')) void ws.loadObjects(tab.sessionId, tab.database, tab.schema, true)
          else if (ws.activeSessionId) void ws.refreshDatabases(ws.activeSessionId)
        }
      }
      const handler = handlers[id]
      if (!handler) return
      e.preventDefault()
      e.stopPropagation()
      handler()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

export function App() {
  const sidebar = useUi((s) => s.sidebar)
  const logPanel = useUi((s) => s.logPanel)
  const chatOpen = useChat((s) => s.open)
  const theme = useSettings((s) => resolveTheme(s.settings.theme))
  useShortcuts()

  useEffect(() => {
    // First launch without saved sessions: open the session manager.
    void useConnections.getState().load().then(() => {
      if (!Object.keys(useWorkspace.getState().sessions).length) useConnections.getState().openDialog()
    })
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <Group orientation="horizontal" className="min-h-0 flex-1">
          {sidebar && (
            <>
              <Panel id="sidebar" defaultSize={280} minSize={180} maxSize={600}>
                <ObjectTree />
              </Panel>
              <Separator className="w-px" />
            </>
          )}
          <Panel id="main" minSize={400}>
            <Group orientation="vertical">
              <Panel id="workspace" minSize={200}>
                <Workspace />
              </Panel>
              {logPanel && (
                <>
                  <Separator className="h-px" />
                  <Panel id="log" defaultSize={140} minSize={60} maxSize={500}>
                    <LogPanel />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          {chatOpen && (
            <>
              <Separator className="w-px" />
              <Panel id="chat" defaultSize={400} minSize={300} maxSize={900}>
                <Suspense fallback={null}>
                  <ChatPanel />
                </Suspense>
              </Panel>
            </>
          )}
        </Group>
        <StatusBar />
      </div>
      <SessionManagerDialog />
      <DialogHost />
      <PromptHost />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </TooltipProvider>
  )
}
