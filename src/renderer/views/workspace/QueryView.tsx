import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { AlignLeft, CheckCircle2, History, ListTree, Play, PlayCircle, Square, TextCursorInput, XCircle, Bookmark, Trash2, Plus } from 'lucide-react'
import type { QueryHistoryEntry, Snippet } from '@shared/model'
import { useWorkspace, type Tab } from '../../stores/workspaceStore'
import { useQueries } from '../../stores/queryStore'
import { SqlEditor, type SqlEditorHandle } from '../../components/editor/SqlEditor'
import { ResultGrid } from '../../components/grid/ResultGrid'
import { Badge, Empty, IconButton, Select, Spinner, cx } from '../../components/ui'
import { commands, editors, exportSources } from '../commands'
import { api } from '../../gateways/api'
import { notify } from '../../stores/toast'
import { promptDialog } from '../../components/ui/prompts'
import { uid } from '../../lib/format'
import { useSqlCatalog } from './useSqlCatalog'
import { GridContextMenu } from './GridContextMenu'
import { isSingleDatabase } from '@domain/engineTraits'

export default function QueryView({ tab, active }: { tab: Tab; active: boolean }) {
  const { t } = useTranslation()
  const session = useWorkspace((s) => s.sessions[tab.sessionId])
  const state = useQueries((s) => s.tabs[tab.id])
  const editorRef = useRef<SqlEditorHandle>(null)
  const [side, setSide] = useState<'history' | 'snippets' | null>(null)
  const [view, setView] = useState<number | 'messages'>(0)

  useEffect(() => {
    useQueries.getState().ensure(tab.id)
  }, [tab.id])

  useEffect(() => {
    exportSources.set(tab.id, () => {
      const q = useQueries.getState().tabs[tab.id]
      const rs = q?.results[typeof view === 'number' ? view : 0]
      return rs ? { result: rs, sql: rs.sql, database: q.database } : null
    })
    return () => {
      exportSources.delete(tab.id)
    }
  }, [tab.id, view])

  useEffect(() => () => void editors.delete(tab.id), [tab.id])

  // Callback ref: the editor mounts after the first render (state is created lazily).
  const setEditor = useCallback(
    (h: SqlEditorHandle | null) => {
      editorRef.current = h
      if (h) editors.set(tab.id, h)
    },
    [tab.id]
  )

  useEffect(() => {
    if (active) setTimeout(() => editorRef.current?.focus(), 30)
  }, [active])

  // Mark the failing statement in the editor.
  useEffect(() => {
    editorRef.current?.markError(state?.errorOffset ?? null)
    if (state?.errorOffset) setView('messages')
  }, [state?.errorOffset])

  // Jump to the first result when a new run starts producing results.
  const resultCount = state?.results.length ?? 0
  useEffect(() => {
    if (resultCount === 1) setView(0)
  }, [resultCount])

  const catalog = useSqlCatalog(session, state?.database)

  if (!session || !state) return null
  const databases = session.databases ?? []

  const results = state.results
  const statements = state.statements
  const errors = statements.filter((s) => s.error)
  const affected = statements.reduce((n, s) => n + (s.affectedRows ?? 0), 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        <IconButton label={`${t('menu.runAll')} (Ctrl+Enter / F9)`} onClick={() => void commands.run('all')} disabled={state.running}>
          <Play size={15} className="text-success" />
        </IconButton>
        <IconButton label={`${t('menu.runCurrent')} (Ctrl+Shift+Enter)`} onClick={() => void commands.run('current')} disabled={state.running}>
          <PlayCircle size={15} />
        </IconButton>
        <IconButton label={t('menu.runSelection')} onClick={() => void commands.run('selection')} disabled={state.running}>
          <TextCursorInput size={15} />
        </IconButton>
        <IconButton label={t('menu.stop')} onClick={() => commands.stop()} disabled={!state.running}>
          <Square size={13} className={state.running ? 'text-danger' : ''} />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-border" />
        <IconButton label={t('menu.explain')} onClick={() => void commands.explain()} disabled={state.running}>
          <ListTree size={15} />
        </IconButton>
        <IconButton label={`${t('menu.format')} (Ctrl+Shift+F)`} onClick={() => commands.format()}>
          <AlignLeft size={15} />
        </IconButton>
        {!isSingleDatabase(session.info.engine) && (
          <>
            <div className="mx-1 h-5 w-px bg-border" />
            <span className="text-xs text-muted">{t('query.database')}</span>
            <Select
              className="h-7 w-48 text-xs"
              value={state.database ?? ''}
              onChange={(e) => useQueries.getState().setDatabase(tab.id, e.target.value || undefined)}
            >
              <option value="">—</option>
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </>
        )}
        {state.running && <Spinner className="ml-2" />}
        {session.inTransaction && <Badge tone="warning">{t('query.transactionOpen')}</Badge>}
        <div className="flex-1" />
        <IconButton label={t('query.history')} active={side === 'history'} onClick={() => setSide(side === 'history' ? null : 'history')}>
          <History size={15} />
        </IconButton>
        <IconButton label={t('query.snippets')} active={side === 'snippets'} onClick={() => setSide(side === 'snippets' ? null : 'snippets')}>
          <Bookmark size={15} />
        </IconButton>
      </div>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel minSize={300}>
          <Group orientation="vertical">
            <Panel defaultSize="45%" minSize={80}>
              <SqlEditor
                ref={setEditor}
                value={state.sql}
                engine={session.info.engine}
                catalog={catalog}
                onChange={(v) => useQueries.getState().setSql(tab.id, v)}
                onRun={() => void commands.run('all')}
                onRunCurrent={() => void commands.run('current')}
                onSave={() => void commands.saveSqlFile(false)}
                onShortcut={(id) => {
                  if (id === 'runSelection') void commands.run('selection')
                  else if (id === 'explain') void commands.explain()
                }}
              />
            </Panel>
            <Separator className="h-[3px]" />
            <Panel minSize={80}>
              <div className="flex h-full flex-col">
                <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-panel px-1">
                  {results.map((rs, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setView(i)}
                      className={cx('-mb-px flex h-7 shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs', view === i ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
                      title={rs.sql}
                    >
                      {t('query.results', { n: i + 1 })}
                      <span className="text-subtle">{rs.rowCount.toLocaleString()}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setView('messages')}
                    className={cx('-mb-px flex h-7 shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs', view === 'messages' ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
                  >
                    {errors.length ? <XCircle size={12} className="text-danger" /> : statements.length ? <CheckCircle2 size={12} className="text-success" /> : null}
                    {t('query.messages')}
                  </button>
                  <div className="flex-1" />
                  <div className="flex h-7 items-center gap-3 px-2 text-[11px] text-muted">
                    {statements.length > 0 && <span>{t('query.statements', { count: statements.length })}</span>}
                    {affected > 0 && <span>{t('query.affected', { count: affected })}</span>}
                    {state.totalMs !== undefined && !state.running && <span>{t('query.duration', { ms: state.totalMs.toLocaleString() })}</span>}
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  {view === 'messages' ? (
                    <Messages statements={statements} cancelled={state.cancelled} />
                  ) : results[view] ? (
                    <ResultPane tabId={tab.id} sessionId={tab.sessionId} index={view} />
                  ) : (
                    <Empty title={state.running ? t('common.running') : t('query.noResults')} />
                  )}
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>
        {side && (
          <>
            <Separator className="w-[3px]" />
            <Panel defaultSize={280} minSize={200} maxSize={600}>
              {side === 'history' ? (
                <HistoryPanel connectionId={session.profile.id} onPick={(sql) => editorRef.current?.insert(sql)} />
              ) : (
                <SnippetsPanel onPick={(sql) => editorRef.current?.insert(sql)} getSql={() => editorRef.current?.getSelection()?.text ?? editorRef.current?.getValue() ?? ''} />
              )}
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}

function ResultPane({ tabId, sessionId, index }: { tabId: string; sessionId: string; index: number }) {
  const { t } = useTranslation()
  const rs = useQueries((s) => s.tabs[tabId]?.results[index])
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number; selection: import('@glideapps/glide-data-grid').GridSelection } | null>(null)
  if (!rs) return null
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ResultGrid result={rs} onContextMenu={(e) => setMenu(e)} />
      </div>
      {rs.truncated && <div className="shrink-0 border-t border-border bg-warning/10 px-3 py-1 text-[11px] text-warning">{t('query.truncated', { count: rs.rowCount })}</div>}
      <GridContextMenu menu={menu} onClose={() => setMenu(null)} result={rs} sessionId={sessionId} />
    </div>
  )
}

function Messages({ statements, cancelled }: { statements: import('@shared/workerApi').StatementSummary[]; cancelled?: boolean }) {
  const { t } = useTranslation()
  if (!statements.length) return <Empty title={t('query.noResults')} />
  return (
    <div className="selectable h-full overflow-auto p-2 font-mono text-xs">
      {statements.map((s) => (
        <div key={s.index} className={cx('mb-2 rounded-md border px-3 py-2', s.error ? 'border-danger/40 bg-danger-soft' : 'border-border bg-panel')}>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
            {s.error ? <XCircle size={12} className="text-danger" /> : <CheckCircle2 size={12} className="text-success" />}
            <span>#{s.index + 1}</span>
            <span>{t('query.duration', { ms: s.durationMs })}</span>
            {s.hasResultSet ? <span>{t('query.rowsFetched', { count: s.rowCount })}</span> : s.affectedRows !== undefined && <span>{t('query.affected', { count: s.affectedRows })}</span>}
          </div>
          <div className="truncate text-fg/80">{s.sql.slice(0, 300)}</div>
          {s.error && <div className="mt-1 whitespace-pre-wrap text-danger">{s.error.message}</div>}
        </div>
      ))}
      {cancelled && <div className="text-warning">{t('query.cancelled')}</div>}
    </div>
  )
}

function HistoryPanel({ connectionId, onPick }: { connectionId: string; onPick(sql: string): void }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<QueryHistoryEntry[]>([])
  const [q, setQ] = useState('')
  const load = useMemo(() => () => void api.invoke('history:list', connectionId, q, 300).then(setItems), [connectionId, q])
  useEffect(() => load(), [load])
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} className="h-7 flex-1 rounded-md bg-sunken px-2 text-xs outline-none" />
        <IconButton label={t('query.clearHistory')} onClick={() => void api.invoke('history:clear', connectionId).then(load)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {items.map((h) => (
          <button key={h.id} type="button" onDoubleClick={() => onPick(h.sql)} className="block w-full border-b border-border px-3 py-2 text-left hover:bg-hover" title={h.sql}>
            <div className="flex items-center gap-2 text-[10px] text-subtle">
              <span>{new Date(h.executedAt).toLocaleString()}</span>
              {h.durationMs !== undefined && <span>{h.durationMs} ms</span>}
              {h.error && <span className="text-danger">✕</span>}
            </div>
            <div className="line-clamp-3 font-mono text-[11px] text-fg/90">{h.sql}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function SnippetsPanel({ onPick, getSql }: { onPick(sql: string): void; getSql(): string }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<Snippet[]>([])
  const load = (): void => void api.invoke('snippets:list').then(setItems)
  useEffect(load, [])
  const add = async (): Promise<void> => {
    const sql = getSql().trim()
    if (!sql) return
    const r = await promptDialog(t('query.saveSnippet'), t('query.snippetName'))
    if (!r) return
    await api.invoke('snippets:save', { id: uid(), name: r.value, sql, updatedAt: '' }).catch(notify.error)
    load()
  }
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex-1 text-xs font-medium text-muted">{t('query.snippets')}</span>
        <IconButton label={t('query.saveSnippet')} onClick={() => void add()}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {items.map((s) => (
          <div key={s.id} className="group flex items-start border-b border-border hover:bg-hover">
            <button type="button" onDoubleClick={() => onPick(s.sql)} className="min-w-0 flex-1 px-3 py-2 text-left" title={s.sql}>
              <div className="text-xs font-medium">{s.name}</div>
              <div className="line-clamp-2 font-mono text-[11px] text-muted">{s.sql}</div>
            </button>
            <IconButton label={t('common.delete')} className="m-1 opacity-0 group-hover:opacity-100" onClick={() => void api.invoke('snippets:delete', s.id).then(load)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}
