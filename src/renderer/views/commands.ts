import { format as formatSql } from 'sql-formatter'
import { statementAtOffset } from '@domain/sql/splitter'
import type { DbEngine } from '@shared/model'
import { api } from '../gateways/api'
import { useWorkspace } from '../stores/workspaceStore'
import { useQueries } from '../stores/queryStore'
import { useUi } from '../stores/uiStore'
import { notify } from '../stores/toast'
import type { SqlEditorHandle } from '../components/editor/SqlEditor'
import type { ResultSet } from '../lib/resultSet'
import i18n from '../i18n'

/** Editors of open query tabs, registered by QueryView. */
export const editors = new Map<string, SqlEditorHandle>()

/** Views that can export what they show register a provider here (keyed by tab id). */
export const exportSources = new Map<string, () => { result?: ResultSet; sql?: string; database?: string; ref?: import('@shared/model').DbObjectRef } | null>()

const activeTab = () => {
  const ws = useWorkspace.getState()
  return ws.tabs.find((t) => t.id === ws.activeTabId)
}

const activeSession = () => {
  const ws = useWorkspace.getState()
  return ws.activeSessionId ? ws.sessions[ws.activeSessionId] : undefined
}

const dialect = (engine: DbEngine | undefined): 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'sql' =>
  engine === 'mysql' ? 'mysql' : engine === 'mariadb' ? 'mariadb' : engine === 'postgres' ? 'postgresql' : engine === 'sqlite' ? 'sqlite' : 'sql'

export const commands = {
  newQuery(sql?: string) {
    const id = useWorkspace.getState().newQueryTab(undefined, sql)
    if (id) setTimeout(() => editors.get(id)?.focus(), 50)
  },

  async run(mode: 'all' | 'current' | 'selection') {
    const tab = activeTab()
    if (tab?.kind !== 'query') return
    const editor = editors.get(tab.id)
    const session = useWorkspace.getState().sessions[tab.sessionId]
    if (!editor || !session) return
    const sel = editor.getSelection()
    if (mode === 'selection' || (mode === 'all' && sel)) {
      if (sel) return useQueries.getState().run(tab.id, sel.text, sel.start)
      if (mode === 'selection') return
    }
    if (mode === 'current') {
      const sql = editor.getValue()
      const st = statementAtOffset(sql, session.info.engine, editor.getCursorOffset())
      if (st) return useQueries.getState().run(tab.id, st.sql, st.start)
      return
    }
    return useQueries.getState().run(tab.id)
  },

  stop() {
    const tab = activeTab()
    if (tab?.kind === 'query') void useQueries.getState().cancel(tab.id)
  },

  async explain() {
    const tab = activeTab()
    if (tab?.kind !== 'query') return
    const editor = editors.get(tab.id)
    const session = useWorkspace.getState().sessions[tab.sessionId]
    if (!editor || !session) return
    const sql = editor.getSelection()?.text ?? statementAtOffset(editor.getValue(), session.info.engine, editor.getCursorOffset())?.sql
    if (!sql) return
    if (session.info.engine === 'firebird') {
      notify.info(i18n.t('errors.unsupported'))
      return
    }
    await useQueries.getState().run(tab.id, session.info.engine === 'sqlite' ? `EXPLAIN QUERY PLAN ${sql}` : `EXPLAIN ${sql}`)
  },

  format() {
    const tab = activeTab()
    if (tab?.kind !== 'query') return
    const editor = editors.get(tab.id)
    const session = useWorkspace.getState().sessions[tab.sessionId]
    if (!editor) return
    try {
      const sel = editor.getSelection()
      const opts = { language: dialect(session?.info.engine), keywordCase: 'upper' as const, tabWidth: 2 }
      if (sel) editor.insert(formatSql(sel.text, opts))
      else editor.setValue(formatSql(editor.getValue(), opts))
    } catch (err) {
      notify.error(err)
    }
  },

  async openSqlFile() {
    const file = await api.invoke('dialog:openFile', { filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: '*', extensions: ['*'] }] })
    if (!file) return
    const content = await api.invoke('fs:readText', file)
    const id = useWorkspace.getState().newQueryTab(undefined, content)
    if (id) {
      useQueries.getState().ensure(id)
      useQueries.getState().setFilePath(id, file)
      useWorkspace.getState().updateTab(id, { title: file.split(/[\\/]/).pop() })
    }
  },

  async saveSqlFile(saveAs: boolean) {
    const tab = activeTab()
    if (tab?.kind !== 'query') return
    const q = useQueries.getState().tabs[tab.id]
    const sql = editors.get(tab.id)?.getValue() ?? q?.sql ?? ''
    let file = saveAs ? undefined : q?.filePath
    if (!file) file = (await api.invoke('dialog:saveFile', { defaultPath: `${tab.title.replace(/[^\w.-]+/g, '_')}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })) ?? undefined
    if (!file) return
    await api.invoke('fs:writeText', file, sql)
    useQueries.getState().setFilePath(tab.id, file)
    useWorkspace.getState().updateTab(tab.id, { title: file.split(/[\\/]/).pop() })
  },

  async toggleAutocommit() {
    const s = activeSession()
    if (!s) return
    const enabled = !s.autocommit
    try {
      await s.client.call('setAutocommit', { enabled })
      useWorkspace.getState().setTransactionState(s.id, { autocommit: enabled, inTransaction: enabled ? false : s.inTransaction })
    } catch (err) {
      notify.error(err)
    }
  },

  async commit() {
    const s = activeSession()
    if (!s) return
    try {
      await s.client.call('commit', undefined)
      useWorkspace.getState().setTransactionState(s.id, { inTransaction: false })
    } catch (err) {
      notify.error(err)
    }
  },

  async rollback() {
    const s = activeSession()
    if (!s) return
    try {
      await s.client.call('rollback', undefined)
      useWorkspace.getState().setTransactionState(s.id, { inTransaction: false })
    } catch (err) {
      notify.error(err)
    }
  },

  exportActive() {
    const tab = activeTab()
    if (!tab) return
    const src = exportSources.get(tab.id)?.()
    if (!src) {
      notify.info(i18n.t('query.noResults'))
      return
    }
    useUi.getState().openDialog({ kind: 'export', sessionId: tab.sessionId, source: { ref: src.ref, sql: src.sql, database: src.database }, result: src.result, title: tab.title })
  },

  closeActiveTab() {
    const tab = activeTab()
    if (tab) useWorkspace.getState().closeTab(tab.id)
  }
}
