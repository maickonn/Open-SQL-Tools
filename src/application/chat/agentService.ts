import { randomUUID } from 'node:crypto'
import type { AiProviderId, AppSettings, ChatConversation, ChatEvent, ChatMessage, ChatPart } from '@shared/model'
import { resolveAiModel } from '@shared/model'
import type { LlmProvider } from '@domain/ports/llm'
import type { ChatRepository } from '@domain/ports/repositories'
import { agentToolDefinitions, executeAgentTool, type DatabaseToolGateway } from './agentTools'

export const AGENT_SYSTEM_PROMPT = `You are the database assistant built into Open SQL Tools, a desktop SQL client for MySQL, MariaDB, PostgreSQL, Firebird and SQLite.

You help the user understand and work with the database they have open: explore the schema, explain data, write and optimize SQL, and diagnose errors.

Working with the database:
- Inspect before answering. Use list_objects, describe_table and get_ddl to learn the real schema instead of guessing table or column names.
- Use run_select for anything that only reads. It runs in a read-only transaction and returns a truncated sample, so add WHERE, ORDER BY and aggregates rather than pulling whole tables.
- Use execute_sql only for changes the user asked for. The user sees the exact statements and approves or declines them. Explain the effect in the reason field. If they decline, do not try again unless asked.
- When the user would rather run something themselves, or it is long or risky, use open_in_editor.
- Write SQL in the dialect and version of the connected server (given in the context block). Quote identifiers the way that engine expects.

Answering:
- Reply in the language the user writes in.
- Be concise. Show SQL in fenced code blocks tagged sql.
- When results matter, summarize what they show; mention when a result was truncated.
- Never invent data. If a tool fails, say what failed and what you will try instead.`

const MAX_ITERATIONS = 30

export interface AgentDeps {
  repo: ChatRepository
  provider(id: AiProviderId): Promise<LlmProvider>
  /** Builds a tool gateway for the session the user picked, or null when none is open. */
  gateway(sessionId: string | undefined, database: string | undefined): DatabaseToolGateway | null
  settings(): AppSettings
  emit(event: ChatEvent): void
}

interface PendingApproval {
  conversationId: string
  resolve: (approved: boolean) => void
}

export class AgentService {
  private readonly running = new Map<string, AbortController>()
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(private readonly deps: AgentDeps) {}

  createConversation(init: { provider: AiProviderId; model: string; connectionId?: string }): ChatConversation {
    const now = new Date().toISOString()
    const c: ChatConversation = { id: randomUUID(), title: 'New chat', provider: init.provider, model: resolveAiModel(init.provider, init.model), connectionId: init.connectionId, createdAt: now, updatedAt: now }
    this.deps.repo.saveConversation(c)
    return c
  }

  approve(callId: string, approved: boolean): void {
    const p = this.approvals.get(callId)
    if (!p) return
    this.approvals.delete(callId)
    p.resolve(approved)
  }

  cancel(conversationId: string): void {
    this.running.get(conversationId)?.abort()
    for (const [id, p] of this.approvals) {
      if (p.conversationId === conversationId) {
        this.approvals.delete(id)
        p.resolve(false)
      }
    }
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  private save(conversationId: string, message: ChatMessage): void {
    this.deps.repo.addMessage(conversationId, message)
    this.deps.emit({ type: 'message-saved', conversationId, message })
  }

  /** Runs one user turn: streams the model, executes tools, loops until the model stops. */
  async send(p: { conversationId: string; text: string; sessionId?: string; database?: string; editorContext?: string }): Promise<void> {
    const conversation = this.deps.repo.getConversation(p.conversationId)
    if (!conversation) throw new Error('Conversation not found')
    if (this.running.has(p.conversationId)) throw new Error('This conversation is already running')
    const controller = new AbortController()
    this.running.set(p.conversationId, controller)
    const settings = this.deps.settings()
    const gw = this.deps.gateway(p.sessionId, p.database)

    try {
      const context = await this.contextBlock(gw, p.database, p.editorContext)
      const userParts: ChatPart[] = []
      if (context) userParts.push({ type: 'text', text: context })
      userParts.push({ type: 'text', text: p.text })
      this.save(p.conversationId, { id: randomUUID(), role: 'user', parts: userParts, createdAt: new Date().toISOString() })

      if (conversation.title === 'New chat') {
        conversation.title = p.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat'
      }
      conversation.updatedAt = new Date().toISOString()
      this.deps.repo.saveConversation(conversation)

      const provider = await this.deps.provider(conversation.provider)
      const tools = gw ? agentToolDefinitions() : []
      let usageIn = 0
      let usageOut = 0

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (controller.signal.aborted) break
        const messageId = randomUUID()
        this.deps.emit({ type: 'start', conversationId: p.conversationId, messageId })
        const turn = await provider.streamTurn({
          // Older conversations may point at a model that is no longer offered.
          model: resolveAiModel(conversation.provider, conversation.model),
          system: AGENT_SYSTEM_PROMPT,
          messages: this.deps.repo.listMessages(p.conversationId),
          tools,
          effort: settings.ai.effort,
          maxTokens: 64_000,
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'text-delta') this.deps.emit({ type: 'text-delta', conversationId: p.conversationId, text: e.text })
            else if (e.type === 'thinking-delta') this.deps.emit({ type: 'thinking-delta', conversationId: p.conversationId, text: e.text })
          }
        })
        usageIn += turn.usage?.inputTokens ?? 0
        usageOut += turn.usage?.outputTokens ?? 0
        turn.message.id = messageId
        this.save(p.conversationId, turn.message)

        const calls = turn.message.parts.filter((x): x is Extract<ChatPart, { type: 'tool_call' }> => x.type === 'tool_call')
        if (turn.stopReason === 'refusal') {
          this.deps.emit({ type: 'error', conversationId: p.conversationId, error: 'The model declined this request.' })
          break
        }
        if (turn.stopReason !== 'tool_use' || !calls.length) {
          if (turn.stopReason === 'max_tokens') {
            this.deps.emit({ type: 'error', conversationId: p.conversationId, error: 'The response hit the output token limit and was cut off.' })
          }
          break
        }

        const results: ChatPart[] = []
        for (const call of calls) {
          this.deps.emit({ type: 'tool-call', conversationId: p.conversationId, callId: call.id, name: call.name, input: call.input })
          const exec = gw
            ? await executeAgentTool(call.name, call.input, gw, {
                maxRows: settings.ai.maxRowsToModel,
                approve: (req) =>
                  new Promise<boolean>((resolve) => {
                    if (controller.signal.aborted) return resolve(false)
                    this.approvals.set(call.id, { conversationId: p.conversationId, resolve })
                    this.deps.emit({ type: 'approval-required', conversationId: p.conversationId, callId: call.id, name: call.name, sql: req.sql, reason: req.reason })
                  })
              })
            : { output: 'No database session is open. Ask the user to connect first.', isError: true }
          this.deps.emit({ type: 'tool-result', conversationId: p.conversationId, callId: call.id, output: exec.output, isError: exec.isError })
          results.push({ type: 'tool_result', callId: call.id, output: exec.output, isError: exec.isError })
        }
        // All tool results of a turn go back in a single user message.
        this.save(p.conversationId, { id: randomUUID(), role: 'user', parts: results, createdAt: new Date().toISOString() })
      }
      this.deps.emit({ type: 'done', conversationId: p.conversationId, usage: { inputTokens: usageIn, outputTokens: usageOut } })
    } catch (err) {
      const aborted = controller.signal.aborted
      this.deps.emit({
        type: aborted ? 'done' : 'error',
        conversationId: p.conversationId,
        ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) })
      } as ChatEvent)
    } finally {
      this.running.delete(p.conversationId)
    }
  }

  private async contextBlock(gw: DatabaseToolGateway | null, database: string | undefined, editor: string | undefined): Promise<string> {
    const lines: string[] = []
    if (gw) {
      const info = await gw.serverInfo()
      lines.push(`Connected server: ${info.label} (${info.engine}), user ${info.currentUser ?? 'unknown'}.`)
      const db = database ?? gw.currentDatabase()
      if (db) lines.push(`Current database: ${db}.`)
    } else lines.push('No database connection is open.')
    if (editor?.trim()) lines.push(`SQL currently in the user's editor:\n\`\`\`sql\n${editor.trim().slice(0, 20_000)}\n\`\`\``)
    return `<context>\n${lines.join('\n')}\n</context>`
  }
}
