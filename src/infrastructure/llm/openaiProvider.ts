import OpenAI from 'openai'
import type { ChatMessage, ChatPart } from '@shared/model'
import type { LlmProvider, LlmTool, LlmTurnRequest, LlmTurnResult } from '@domain/ports/llm'

type InputItem = OpenAI.Responses.ResponseInputItem
type FunctionTool = OpenAI.Responses.FunctionTool

function toInput(messages: ChatMessage[]): InputItem[] {
  const out: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      // Replay output items verbatim (reasoning with encrypted content, function calls).
      if (m.provider === 'openai' && Array.isArray(m.providerData)) {
        out.push(...(m.providerData as InputItem[]))
        continue
      }
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) out.push({ role: 'assistant', content: p.text })
        else if (p.type === 'tool_call') out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) })
      }
      continue
    }
    const texts = m.parts.filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    if (texts.length) out.push({ role: 'user', content: texts.map((t) => ({ type: 'input_text' as const, text: t.text })) })
    for (const p of m.parts) {
      if (p.type === 'tool_result') out.push({ type: 'function_call_output', call_id: p.callId, output: p.output })
    }
  }
  return out
}

function toTools(tools: LlmTool[]): FunctionTool[] {
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }))
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult> {
    const stream = this.client.responses.stream(
      {
        model: req.model,
        instructions: req.system,
        input: toInput(req.messages),
        tools: req.tools.length ? toTools(req.tools) : undefined,
        reasoning: { effort: req.effort, summary: 'auto' },
        // Stateless: history is replayed each turn, reasoning travels encrypted.
        store: false,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: req.maxTokens
      },
      { signal: req.signal }
    )

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') req.onEvent({ type: 'text-delta', text: event.delta })
      else if (event.type === 'response.reasoning_summary_text.delta') req.onEvent({ type: 'thinking-delta', text: event.delta })
    }
    const response = await stream.finalResponse()

    const parts: ChatPart[] = []
    let refused = false
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const c of item.content) {
          if (c.type === 'output_text') parts.push({ type: 'text', text: c.text })
          else if (c.type === 'refusal') {
            refused = true
            parts.push({ type: 'text', text: c.refusal })
          }
        }
      } else if (item.type === 'reasoning') {
        const summary = (item.summary ?? []).map((s) => s.text).join('\n')
        if (summary) parts.push({ type: 'thinking', text: summary })
      } else if (item.type === 'function_call') {
        let input: unknown = {}
        try {
          input = item.arguments ? JSON.parse(item.arguments) : {}
        } catch {
          input = { __invalid_json: item.arguments }
        }
        parts.push({ type: 'tool_call', id: item.call_id, name: item.name, input })
        req.onEvent({ type: 'tool-call', id: item.call_id, name: item.name, input })
      }
    }

    const hasCalls = parts.some((p) => p.type === 'tool_call')
    const incomplete = response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
    const stopReason: LlmTurnResult['stopReason'] = refused ? 'refusal' : incomplete ? 'max_tokens' : hasCalls ? 'tool_use' : 'end'

    return {
      message: {
        id: response.id,
        role: 'assistant',
        parts,
        createdAt: new Date().toISOString(),
        provider: 'openai',
        model: response.model,
        providerData: response.output
      },
      stopReason,
      usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }
    }
  }
}
