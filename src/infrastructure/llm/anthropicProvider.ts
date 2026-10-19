import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ChatPart } from '@shared/model'
import type { LlmProvider, LlmTool, LlmTurnRequest, LlmTurnResult } from '@domain/ports/llm'

type BetaMessageParam = Anthropic.Beta.BetaMessageParam
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type BetaToolUnion = Anthropic.Beta.BetaToolUnion

/** Models that accept the server-side refusal fallback ("default" routing). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

function toAnthropicMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      // Replay the exact content (thinking signatures, fallback blocks) when it came from Anthropic.
      if (m.provider === 'anthropic' && Array.isArray(m.providerData)) {
        out.push({ role: 'assistant', content: m.providerData as BetaContentBlockParam[] })
        continue
      }
      const content: BetaContentBlockParam[] = []
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
        else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name, input: (p.input ?? {}) as Record<string, unknown> })
      }
      if (content.length) out.push({ role: 'assistant', content })
      continue
    }
    const content: BetaContentBlockParam[] = []
    for (const p of m.parts) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text })
      else if (p.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: p.callId, content: p.output, is_error: p.isError || undefined })
    }
    if (content.length) out.push({ role: 'user', content })
  }
  return out
}

function toAnthropicTools(tools: LlmTool[]): BetaToolUnion[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    // Stream tool inputs as generated; inputs are validated with zod before running.
    eager_input_streaming: true
  }))
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult> {
    const useFallback = FALLBACK_MODELS.has(req.model)
    const stream = this.client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.length ? toAnthropicTools(req.tools) : undefined,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: req.effort },
        // Automatic prompt caching of the stable prefix (tools + system + history).
        cache_control: { type: 'ephemeral' },
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      },
      { signal: req.signal }
    )

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') req.onEvent({ type: 'text-delta', text: event.delta.text })
        else if (event.delta.type === 'thinking_delta') req.onEvent({ type: 'thinking-delta', text: event.delta.thinking })
      }
    }
    const message = await stream.finalMessage()

    const parts: ChatPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'thinking') {
        if (block.thinking) parts.push({ type: 'thinking', text: block.thinking, signature: block.signature })
      } else if (block.type === 'tool_use') {
        parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input })
        req.onEvent({ type: 'tool-call', id: block.id, name: block.name, input: block.input })
      }
    }

    const stop = message.stop_reason
    const stopReason: LlmTurnResult['stopReason'] =
      stop === 'end_turn' ? 'end' : stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'other'

    return {
      message: {
        id: message.id,
        role: 'assistant',
        parts,
        createdAt: new Date().toISOString(),
        provider: 'anthropic',
        model: message.model,
        providerData: message.content
      },
      // A tool input cut off at max_tokens must not run: report max_tokens.
      stopReason,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
    }
  }
}
