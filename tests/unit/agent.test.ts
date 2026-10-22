import { describe, expect, it } from 'vitest'
import type { ChatConversation, ChatEvent, ChatMessage, MaterializedResult } from '@shared/model'
import { DEFAULT_SETTINGS, resolveAiModel } from '@shared/model'
import type { LlmProvider, LlmTurnRequest, LlmTurnResult } from '@domain/ports/llm'
import type { ChatRepository } from '@domain/ports/repositories'
import { AgentService } from '@application/chat/agentService'
import type { DatabaseToolGateway } from '@application/chat/agentTools'

class MemoryRepo implements ChatRepository {
  conversations = new Map<string, ChatConversation>()
  messages = new Map<string, ChatMessage[]>()
  listConversations = () => [...this.conversations.values()]
  getConversation = (id: string) => this.conversations.get(id)
  saveConversation = (c: ChatConversation) => void this.conversations.set(c.id, c)
  deleteConversation = (id: string) => void this.conversations.delete(id)
  listMessages = (id: string) => [...(this.messages.get(id) ?? [])]
  addMessage = (id: string, m: ChatMessage) => void this.messages.set(id, [...(this.messages.get(id) ?? []), m])
}

/** Replays scripted turns: each turn is a list of tool calls or a final text. */
function scriptedProvider(turns: ({ calls: { name: string; input: unknown }[] } | { text: string })[]): LlmProvider & { requests: LlmTurnRequest[] } {
  const requests: LlmTurnRequest[] = []
  let i = 0
  return {
    id: 'anthropic',
    requests,
    async streamTurn(req): Promise<LlmTurnResult> {
      requests.push(req)
      const turn = turns[i++]
      if ('text' in turn) {
        req.onEvent({ type: 'text-delta', text: turn.text })
        return { message: { id: '', role: 'assistant', parts: [{ type: 'text', text: turn.text }], createdAt: '' }, stopReason: 'end' }
      }
      return {
        message: { id: '', role: 'assistant', parts: turn.calls.map((c, n) => ({ type: 'tool_call' as const, id: `call${i}_${n}`, name: c.name, input: c.input })), createdAt: '' },
        stopReason: 'tool_use'
      }
    }
  }
}

const result = (rows: (string | number)[][]): MaterializedResult => ({
  columns: [{ name: 'n', type: 'INT', category: 'integer' }],
  rows,
  durationMs: 1
})

function gateway(log: string[]): DatabaseToolGateway {
  return {
    serverInfo: async () => ({ engine: 'mysql', versionString: '8.4.12', version: 80412, label: 'MySQL 8.4.12', capabilities: [], currentUser: 'root@%' }),
    currentDatabase: () => 'app',
    listDatabases: async () => ['app'],
    listSchemas: async () => [],
    listObjects: async () => [{ name: 'items', kind: 'table', rows: 3 }],
    getTableStructure: async () => ({ ref: { name: 'items', kind: 'table' }, columns: [], indexes: [], foreignKeys: [], checks: [], options: {} }),
    getObjectDDL: async () => 'CREATE TABLE items (id int)',
    readQuery: async (sql) => {
      log.push(`read:${sql}`)
      return result([[3]])
    },
    writeQuery: async (sql) => {
      log.push(`write:${sql}`)
      return { ...result([]), columns: [], affectedRows: 1 }
    },
    openInEditor: (sql) => log.push(`editor:${sql}`)
  }
}

function setup(turns: Parameters<typeof scriptedProvider>[0], approve: boolean) {
  const repo = new MemoryRepo()
  const events: ChatEvent[] = []
  const log: string[] = []
  const provider = scriptedProvider(turns)
  let agent: AgentService
  agent = new AgentService({
    repo,
    provider: async () => provider,
    gateway: () => gateway(log),
    settings: () => DEFAULT_SETTINGS,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval-required') setTimeout(() => agent.approve(e.callId, approve), 0)
    }
  })
  const conv = agent.createConversation({ provider: 'anthropic', model: 'claude-opus-5-5' })
  return { agent, conv, repo, events, log, provider }
}

describe('AgentService', () => {
  it('runs read tools freely and loops until the final answer', async () => {
    const { agent, conv, repo, log, provider, events } = setup(
      [{ calls: [{ name: 'run_select', input: { sql: 'SELECT COUNT(*) FROM items' } }] }, { text: 'There are 3 items.' }],
      true
    )
    await agent.send({ conversationId: conv.id, text: 'How many items?', sessionId: 's1' })
    expect(log).toEqual(['read:SELECT COUNT(*) FROM items'])
    expect(provider.requests).toHaveLength(2)
    // The second request carries the tool result back to the model.
    const last = provider.requests[1].messages.at(-1)!
    expect(last.parts[0]).toMatchObject({ type: 'tool_result', isError: undefined })
    expect(repo.listMessages(conv.id).at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'There are 3 items.' })
    expect(events.some((e) => e.type === 'done')).toBe(true)
    expect(repo.getConversation(conv.id)?.title).toBe('How many items?')
  })

  it('refuses writes through run_select', async () => {
    const { agent, conv, log, provider } = setup([{ calls: [{ name: 'run_select', input: { sql: 'DELETE FROM items' } }] }, { text: 'ok' }], true)
    await agent.send({ conversationId: conv.id, text: 'x', sessionId: 's1' })
    expect(log).toEqual([])
    expect(provider.requests[1].messages.at(-1)!.parts[0]).toMatchObject({ type: 'tool_result', isError: true })
  })

  it('runs execute_sql only after approval', async () => {
    const approved = setup([{ calls: [{ name: 'execute_sql', input: { sql: 'DELETE FROM items WHERE id = 1', reason: 'cleanup' } }] }, { text: 'done' }], true)
    await approved.agent.send({ conversationId: approved.conv.id, text: 'delete 1', sessionId: 's1' })
    expect(approved.log).toEqual(['write:DELETE FROM items WHERE id = 1'])
    expect(approved.events.some((e) => e.type === 'approval-required')).toBe(true)

    const declined = setup([{ calls: [{ name: 'execute_sql', input: { sql: 'DROP TABLE items', reason: 'x' } }] }, { text: 'ok' }], false)
    await declined.agent.send({ conversationId: declined.conv.id, text: 'drop it', sessionId: 's1' })
    expect(declined.log).toEqual([])
    expect(declined.provider.requests[1].messages.at(-1)!.parts[0]).toMatchObject({ type: 'tool_result', isError: true })
  })

  it('validates tool input', async () => {
    const { agent, conv, provider } = setup([{ calls: [{ name: 'describe_table', input: { nope: 1 } }] }, { text: 'ok' }], true)
    await agent.send({ conversationId: conv.id, text: 'x', sessionId: 's1' })
    const r = provider.requests[1].messages.at(-1)!.parts[0] as { output: string; isError?: boolean }
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/Invalid input/)
  })
})

describe('supported AI models', () => {
  it('keeps supported models and falls back to the provider default otherwise', () => {
    expect(resolveAiModel('anthropic', 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(resolveAiModel('openai', 'gpt-6-luna')).toBe('gpt-6-luna')
    expect(resolveAiModel('openai', 'gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveAiModel('openai', 'gpt-6-astra')).toBe('gpt-6.1-sol')
    expect(resolveAiModel('anthropic', 'gpt-6.1-sol')).toBe('claude-opus-5-5')
    expect(resolveAiModel('anthropic', undefined)).toBe('claude-opus-5-5')
  })
})
