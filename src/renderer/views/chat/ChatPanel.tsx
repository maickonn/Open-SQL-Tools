import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Brain, ChevronRight, Copy, Plus, Send, ShieldAlert, Square, SquareTerminal, Trash2, User, Wrench, X } from 'lucide-react'
import { AI_MODELS, resolveAiModel, type ChatMessage, type ChatPart } from '@shared/model'
import { IDLE, inScope, lastModel, useChat, type PendingApproval } from '../../stores/chatStore'
import { useWorkspace } from '../../stores/workspaceStore'
import { useSettings } from '../../stores/settingsStore'
import { useUi } from '../../stores/uiStore'
import { Badge, Button, Checkbox, DropdownMenu, Empty, IconButton, Select, Spinner, cx } from '../../components/ui'
import { editors } from '../commands'

const NO_MESSAGES: ChatMessage[] = []

export function ChatPanel() {
  const { t } = useTranslation()
  const chat = useChat()
  const settings = useSettings((s) => s.settings)
  const session = useWorkspace((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null))
  const activeTab = useWorkspace((s) => s.tabs.find((x) => x.id === s.activeTabId))
  const [text, setText] = useState('')
  const [attachEditor, setAttachEditor] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Each connection has its own conversations, so contexts of different sessions never mix.
  const scope = session?.profile.id ?? ''
  const activeId = chat.scope === scope ? (chat.activeByScope[scope] ?? null) : null
  const conversation = chat.conversations.find((c) => c.id === activeId)
  const conversations = useMemo(() => chat.conversations.filter((c) => inScope(c, scope)), [chat.conversations, scope])
  const messages = (activeId && chat.messages[activeId]) || NO_MESSAGES
  const live = (activeId && chat.live[activeId]) || IDLE
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model = useMemo(() => (conversation ? resolveAiModel(conversation.provider, conversation.model) : lastModel().model), [conversation, settings.ai])
  const anyKey = chat.hasKey.anthropic || chat.hasKey.openai

  useEffect(() => {
    void chat.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void useChat.getState().setScope(scope)
  }, [scope])

  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight
  }, [messages, live.streamingText, live.approvals])

  // Tool results are stored in user messages; index them by call id for rendering next to the call.
  const results = useMemo(() => {
    const m = new Map<string, Extract<ChatPart, { type: 'tool_result' }>>()
    for (const msg of messages) for (const p of msg.parts) if (p.type === 'tool_result') m.set(p.callId, p)
    return m
  }, [messages])

  const send = (): void => {
    const value = text.trim()
    if (!value || live.running) return
    setText('')
    const editorSql = attachEditor && activeTab?.kind === 'query' ? editors.get(activeTab.id)?.getValue() : undefined
    void chat.send(value, {
      sessionId: session?.id,
      database: activeTab?.database ?? session?.info.currentDatabase,
      editorContext: editorSql
    })
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Bot size={15} className="text-accent" />
        <DropdownMenu
          items={[
            ...conversations.slice(0, 40).map((c) => ({ label: c.title, checked: c.id === activeId, onSelect: () => void chat.select(c.id) })),
            ...(conversations.length ? [{ separator: true }] : []),
            { label: t('chat.newChat'), icon: <Plus size={14} />, onSelect: () => chat.newConversation() }
          ]}
          trigger={
            <button type="button" className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-[13px] font-medium hover:bg-hover">
              {conversation?.title ?? t('chat.title')}
            </button>
          }
        />
        <IconButton label={t('chat.newChat')} onClick={() => chat.newConversation()}>
          <Plus size={15} />
        </IconButton>
        {conversation && (
          <IconButton label={t('chat.deleteConversation')} onClick={() => void chat.remove(conversation.id)}>
            <Trash2 size={14} />
          </IconButton>
        )}
        <IconButton label={t('common.close')} onClick={() => chat.toggle(false)}>
          <X size={15} />
        </IconButton>
      </div>

      {anyKey && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
          <Select
            className="h-7 min-w-0 flex-1 text-xs"
            value={model}
            onChange={(e) => {
              const m = AI_MODELS.find((x) => x.id === e.target.value)
              if (m) void chat.setModel(m.provider, m.id)
            }}
          >
            {(['anthropic', 'openai'] as const).map((p) => (
              <optgroup key={p} label={p === 'anthropic' ? 'Anthropic' : 'OpenAI'}>
                {AI_MODELS.filter((m) => m.provider === p).map((m) => (
                  <option key={m.id} value={m.id} disabled={!chat.hasKey[p]}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
      )}

      <div ref={scrollRef} className="selectable min-h-0 flex-1 overflow-auto px-3 py-3">
        {!anyKey ? (
          <Empty icon={<Bot size={28} />} title={t('chat.title')}>
            <p className="text-xs">{t('chat.noKey')}</p>
            <Button size="sm" className="mt-2" onClick={() => useUi.getState().openDialog({ kind: 'settings', section: 'ai' })}>
              {t('menu.settings')}
            </Button>
          </Empty>
        ) : !messages.length && !live.running ? (
          <Empty icon={<Bot size={28} />} title={t('chat.title')}>
            <p className="max-w-64 text-xs">{t('chat.empty')}</p>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <Message key={m.id} message={m} results={results} sessionId={session?.id} database={activeTab?.database} />
            ))}
            {live.running && live.streamingText && (
              <div className="flex gap-2">
                <Avatar role="assistant" />
                <div className="min-w-0 flex-1">
                  <Markdown text={live.streamingText} sessionId={session?.id} database={activeTab?.database} />
                </div>
              </div>
            )}
            {Object.values(live.tools)
              .filter((tc) => tc.output === undefined)
              .map((tc) => (
                <div key={tc.callId} className="ml-8 flex items-center gap-2 text-xs text-muted">
                  <Spinner size={12} /> {t('chat.toolCall', { name: tc.name })}
                </div>
              ))}
            {live.approvals.map((a) => (
              <Approval key={a.callId} approval={a} />
            ))}
            {live.running && !live.streamingText && !Object.values(live.tools).some((x) => x.output === undefined) && (
              <div className="ml-8 flex items-center gap-2 text-xs text-muted">
                <Spinner size={12} />
                {live.thinking && (
                  <>
                    <Brain size={12} /> {t('chat.thinking')}
                  </>
                )}
              </div>
            )}
            {live.error && <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{live.error}</div>}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
          {session ? <Badge tone="accent">{t('chat.context', { label: `${session.profile.name}${activeTab?.database ? ' · ' + activeTab.database : ''}` })}</Badge> : <Badge>{t('chat.noSession')}</Badge>}
          {activeTab?.kind === 'query' && <Checkbox checked={attachEditor} onChange={setAttachEditor} label={<span className="text-[11px]">{t('chat.attachEditor')}</span>} />}
        </div>
        <div className="flex items-end gap-1.5 rounded-lg border border-border bg-sunken p-1.5 focus-within:border-accent">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={3}
            placeholder={t('chat.placeholder')}
            disabled={!anyKey}
            className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-1 text-[13px] outline-none! placeholder:text-subtle"
          />
          {live.running ? (
            <IconButton label={t('chat.stop')} onClick={() => void chat.stop()}>
              <Square size={14} className="text-danger" />
            </IconButton>
          ) : (
            <IconButton label={t('chat.send')} onClick={send} disabled={!text.trim() || !anyKey}>
              <Send size={15} className="text-accent" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  )
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', role === 'user' ? 'bg-hover text-muted' : 'bg-accent-soft text-accent')}>
      {role === 'user' ? <User size={13} /> : <Bot size={13} />}
    </div>
  )
}

function Message({ message, results, sessionId, database }: { message: ChatMessage; results: Map<string, Extract<ChatPart, { type: 'tool_result' }>>; sessionId?: string; database?: string }) {
  const { t } = useTranslation()
  // User messages that only carry tool results are rendered next to the calls.
  if (message.role === 'user') {
    const texts = message.parts.filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text' && !p.text.startsWith('<context>'))
    if (!texts.length) return null
    return (
      <div className="flex gap-2">
        <Avatar role="user" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap rounded-lg bg-hover px-3 py-2 text-[13px]">{texts.map((p) => p.text).join('\n')}</div>
      </div>
    )
  }
  // Reasoning is never shown; skip turns that only reasoned.
  if (!message.parts.some((p) => p.type === 'text' || p.type === 'tool_call')) return null
  return (
    <div className="flex gap-2">
      <Avatar role="assistant" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {message.parts.map((p, i) => {
          if (p.type === 'text') return <Markdown key={i} text={p.text} sessionId={sessionId} database={database} />
          if (p.type === 'tool_call') {
            const r = results.get(p.id)
            return (
              <details key={i} className="group rounded-md border border-border bg-sunken text-xs">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-muted">
                  <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
                  <Wrench size={12} />
                  {t('chat.toolCall', { name: p.name })}
                  {r?.isError && <Badge tone="danger">{t('common.error')}</Badge>}
                </summary>
                <pre className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 font-mono text-[11px] text-fg/80">{JSON.stringify(p.input, null, 2)}</pre>
                {r && <pre className="max-h-64 overflow-auto border-t border-border px-2 py-1.5 font-mono text-[11px] text-muted">{r.output}</pre>}
              </details>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

function Markdown({ text, sessionId, database }: { text: string; sessionId?: string; database?: string }) {
  const { t } = useTranslation()
  return (
    <div className="prose-chat text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const code = String(children).replace(/\n$/, '')
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            if (!lang && !code.includes('\n')) return <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px]">{children}</code>
            return (
              <div className="my-2 overflow-hidden rounded-md border border-border">
                <div className="flex h-7 items-center gap-1 border-b border-border bg-panel-2 px-2 text-[11px] text-muted">
                  <span className="flex-1">{lang ?? 'code'}</span>
                  <IconButton label={t('common.copy')} size={22} onClick={() => void navigator.clipboard.writeText(code)}>
                    <Copy size={12} />
                  </IconButton>
                  {(lang === 'sql' || !lang) && sessionId && (
                    <IconButton label={t('chat.insertSql')} size={22} onClick={() => useWorkspace.getState().newQueryTab(sessionId, code, database)}>
                      <SquareTerminal size={12} />
                    </IconButton>
                  )}
                </div>
                <pre className="overflow-auto bg-sunken p-2 font-mono text-[12px]">{code}</pre>
              </div>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function Approval({ approval }: { approval: PendingApproval }) {
  const { t } = useTranslation()
  const chat = useChat()
  return (
    <div className={cx('ml-8 rounded-lg border p-3', approval.decided ? 'border-border opacity-70' : 'border-warning/50 bg-warning/5')}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-warning">
        <ShieldAlert size={14} /> {t('chat.approvalTitle')}
      </div>
      {approval.reason && <div className="mb-2 text-xs text-muted">{approval.reason}</div>}
      <pre className="max-h-56 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11.5px]">{approval.sql}</pre>
      <div className="mt-2 flex justify-end gap-2">
        {approval.decided ? (
          <Badge tone={approval.approved ? 'success' : 'danger'}>{approval.approved ? t('chat.approved') : t('chat.declined')}</Badge>
        ) : (
          <>
            <Button size="sm" onClick={() => void chat.approve(approval.callId, false)}>
              {t('chat.decline')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void chat.approve(approval.callId, true)}>
              {t('chat.approve')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
