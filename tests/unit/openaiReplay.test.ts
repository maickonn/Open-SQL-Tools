import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import { toInput } from '@infrastructure/llm/openaiProvider'

describe('OpenAI history replay', () => {
  it('drops SDK-only fields from replayed output items', () => {
    const assistant: ChatMessage = {
      id: 'resp_1',
      role: 'assistant',
      parts: [],
      createdAt: '2026-10-20T00:00:00Z',
      provider: 'openai',
      model: 'gpt-6-luna',
      providerData: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'describe_table', arguments: '{"table":"PEDIDOS"}', parsed_arguments: { table: 'PEDIDOS' }, status: 'completed' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [], parsed: null }] }
      ]
    }
    const input = toInput([assistant]) as unknown as Record<string, unknown>[]
    expect(input).toHaveLength(3)
    expect(input[0]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' })
    expect(input[1]).not.toHaveProperty('parsed_arguments')
    expect(input[1]).toMatchObject({ call_id: 'call_1', arguments: '{"table":"PEDIDOS"}' })
    expect((input[2].content as Record<string, unknown>[])[0]).toEqual({ type: 'output_text', text: 'Hi', annotations: [] })
  })
})
