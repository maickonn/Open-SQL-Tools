import { create } from 'zustand'
import type { StatementSummary } from '@shared/workerApi'
import { classifyStatement, isDangerousStatement } from '@domain/sql/classifier'
import { splitSql } from '@domain/sql/splitter'
import { ResultSet } from '../lib/resultSet'
import { uid } from '../lib/format'
import { api } from '../gateways/api'
import type { SessionClient } from '../gateways/sessionClient'
import { useWorkspace, pendingQuerySql } from './workspaceStore'
import { useSettings } from './settingsStore'
import { notify } from './toast'
import i18n from '../i18n'
import { confirmDialog } from '../components/ui/prompts'

export interface QueryTabState {
  sql: string
  database?: string
  running: boolean
  queryId?: string
  results: ResultSet[]
  activeResult: number
  statements: StatementSummary[]
  totalMs?: number
  cancelled?: boolean
  filePath?: string
  /** Offset of the last error, for the editor marker. */
  errorOffset?: { start: number; end: number; message: string }
}

const empty = (): QueryTabState => ({ sql: '', running: false, results: [], activeResult: 0, statements: [] })

/** Dispatches worker result events to the run that owns the queryId. */
const routers = new WeakMap<SessionClient, Map<string, RunHandlers>>()

interface RunHandlers {
  start(e: { resultIndex: number; statementIndex: number; sql: string; columns: ResultSet['columns'] }): void
  rows(e: { resultIndex: number; columns: Parameters<ResultSet['append']>[0]; rowCount: number }): void
  end(e: { resultIndex: number; truncated: boolean; durationMs: number }): void
  statement(s: StatementSummary): void
}

function router(client: SessionClient): Map<string, RunHandlers> {
  let map = routers.get(client)
  if (map) return map
  const m = new Map<string, RunHandlers>()
  routers.set(client, m)
  client.on('result:start', (e) => m.get(e.queryId)?.start(e))
  client.on('result:rows', (e) => m.get(e.queryId)?.rows(e))
  client.on('result:end', (e) => m.get(e.queryId)?.end(e))
  client.on('statement:done', (e) => m.get(e.queryId)?.statement(e.summary))
  map = m
  return map
}

/**
 * Executes a script on a session and streams results into ResultSets.
 * Returns the summary once every statement finished.
 */
export async function runScript(
  client: SessionClient,
  sql: string,
  opts: { database?: string; maxRows: number; onResult(rs: ResultSet): void; onStatement?(s: StatementSummary): void; queryId?: string }
) {
  const queryId = opts.queryId ?? uid()
  const results = new Map<number, ResultSet>()
  const r = router(client)
  r.set(queryId, {
    start: (e) => {
      const rs = new ResultSet(e.columns)
      rs.statementIndex = e.statementIndex
      rs.sql = e.sql
      results.set(e.resultIndex, rs)
      opts.onResult(rs)
    },
    rows: (e) => results.get(e.resultIndex)?.append(e.columns, e.rowCount),
    end: (e) => results.get(e.resultIndex)?.finish(e.truncated, e.durationMs),
    statement: (s) => opts.onStatement?.(s)
  })
  try {
    return await client.call('execute', { queryId, sql, database: opts.database, maxRows: opts.maxRows })
  } finally {
    r.delete(queryId)
  }
}

interface QueryVM {
  tabs: Record<string, QueryTabState>
  ensure(tabId: string): QueryTabState
  setSql(tabId: string, sql: string): void
  setDatabase(tabId: string, database: string | undefined): void
  setActiveResult(tabId: string, index: number): void
  run(tabId: string, sql?: string, baseOffset?: number): Promise<void>
  cancel(tabId: string): Promise<void>
  setFilePath(tabId: string, filePath: string | undefined): void
  /** Swaps a result for its edited copy once grid changes were posted. */
  replaceResult(tabId: string, index: number, rs: ResultSet): void
}

export const useQueries = create<QueryVM>((set, get) => ({
  tabs: {},

  ensure(tabId) {
    const existing = get().tabs[tabId]
    if (existing) return existing
    const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
    const state: QueryTabState = { ...empty(), sql: pendingQuerySql.get(tabId) ?? '', database: tab?.database }
    pendingQuerySql.delete(tabId)
    set((s) => ({ tabs: { ...s.tabs, [tabId]: state } }))
    return state
  },

  setSql(tabId, sql) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? empty()), sql } } }))
  },

  setDatabase(tabId, database) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? empty()), database } } }))
  },

  setActiveResult(tabId, index) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], activeResult: index } } }))
  },

  setFilePath(tabId, filePath) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], filePath } } }))
  },

  replaceResult(tabId, index, rs) {
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab?.results[index]) return s
      const results = [...tab.results]
      results[index] = rs
      return { tabs: { ...s.tabs, [tabId]: { ...tab, results } } }
    })
  },

  async run(tabId, sqlOverride, baseOffset = 0) {
    const ws = useWorkspace.getState()
    const tab = ws.tabs.find((t) => t.id === tabId)
    const session = tab ? ws.sessions[tab.sessionId] : undefined
    const state = get().ensure(tabId)
    if (!tab || !session || state.running) return
    const sql = (sqlOverride ?? state.sql).trim()
    if (!sql) return
    const settings = useSettings.getState().settings
    if (settings.confirmDangerousQueries) {
      const dangerous = splitSql(sql, session.info.engine).some((s) => isDangerousStatement(s.sql))
      if (dangerous && !(await confirmDialog(i18n.t('menu.runAll'), i18n.t('query.confirmDangerous'), true))) return
    }
    const queryId = uid()
    const results: ResultSet[] = []
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], running: true, queryId, results: [], statements: [], activeResult: 0, errorOffset: undefined, cancelled: false } } }))
    const started = Date.now()
    try {
      const summary = await runScript(session.client, sql, {
        queryId,
        database: state.database,
        // Query tabs fetch every row: limiting the result is up to the SQL.
        maxRows: Number.MAX_SAFE_INTEGER,
        onResult: (rs) => {
          results.push(rs)
          set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], results: [...results] } } }))
        },
        onStatement: (st) => set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], statements: [...s.tabs[tabId].statements, st] } } }))
      })
      const failed = summary.statements.find((x) => x.error)
      set((s) => ({
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...s.tabs[tabId],
            running: false,
            totalMs: summary.totalMs,
            cancelled: summary.cancelled,
            errorOffset: failed ? { start: baseOffset + failed.start, end: baseOffset + failed.start + failed.sql.length, message: failed.error!.message } : undefined
          }
        }
      }))
      // Schema changes: refresh the object lists already loaded for this session.
      if (summary.statements.some((st) => !st.error && classifyStatement(st.sql) === 'ddl')) {
        const ws2 = useWorkspace.getState()
        if (summary.statements.some((st) => /^\s*(CREATE|DROP)\s+(DATABASE|SCHEMA)\b/i.test(st.sql))) void ws2.refreshDatabases(session.id)
        for (const [key, entry] of Object.entries(ws2.objects)) {
          if (!key.startsWith(session.id) || entry.status !== 'ok') continue
          const [, db, schema] = key.split('\u0001')
          void ws2.loadObjects(session.id, db || undefined, schema || undefined, true)
        }
      }
      const inTx = await session.client.call('inTransaction', undefined).catch(() => false)
      useWorkspace.getState().setTransactionState(session.id, { inTransaction: inTx })
      void api.invoke('history:add', {
        connectionId: session.profile.id,
        database: state.database,
        sql,
        executedAt: new Date(started).toISOString(),
        durationMs: summary.totalMs,
        rowCount: summary.statements.reduce((n, x) => n + (x.rowCount || x.affectedRows || 0), 0),
        error: failed?.error?.message
      })
    } catch (err) {
      set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], running: false } } }))
      notify.error(err)
    }
  },

  async cancel(tabId) {
    const state = get().tabs[tabId]
    const ws = useWorkspace.getState()
    const tab = ws.tabs.find((t) => t.id === tabId)
    const session = tab ? ws.sessions[tab.sessionId] : undefined
    if (!state?.queryId || !session) return
    await session.client.call('cancel', { queryId: state.queryId }).catch(notify.error)
  }
}))

