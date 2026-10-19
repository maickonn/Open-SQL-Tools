import type { AiProviderId, ChatMessage } from '@shared/model'

/** JSON-schema tool definition, provider agnostic. */
export interface LlmTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type LlmStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }

export interface LlmTurnResult {
  /** Assistant message for this turn (text, thinking and tool calls). */
  message: ChatMessage
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface LlmTurnRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: LlmTool[]
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  signal: AbortSignal
  onEvent: (e: LlmStreamEvent) => void
}

/** One streaming model turn. The agent loop lives in the application layer. */
export interface LlmProvider {
  readonly id: AiProviderId
  streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult>
}
