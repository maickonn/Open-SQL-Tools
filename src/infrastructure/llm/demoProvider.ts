import { randomUUID } from 'node:crypto'
import type { AiProviderId, ChatMessage, ChatPart } from '@shared/model'
import type { LlmProvider, LlmTurnRequest, LlmTurnResult } from '@domain/ports/llm'

/**
 * Scripted provider used to record the README demo (OST_DEMO_AI=1): asks the database
 * through run_select, then answers from the real tool result. No network, deterministic.
 */
export class DemoProvider implements LlmProvider {
  constructor(readonly id: AiProviderId) {}

  async streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult> {
    const last = req.messages.at(-1)
    const result = last?.parts.find((p): p is Extract<ChatPart, { type: 'tool_result' }> => p.type === 'tool_result')
    if (!result) {
      const call: ChatPart = {
        type: 'tool_call',
        id: randomUUID(),
        name: 'run_select',
        input: {
          sql: [
            'SELECT c.customer_name, SUM(o.total_amount) AS revenue',
            'FROM orders AS o',
            'INNER JOIN customers AS c',
            '    ON c.customer_id = o.customer_id',
            "WHERE o.created_at >= '2026-01-01'",
            'GROUP BY c.customer_name',
            'ORDER BY revenue DESC',
            'LIMIT 5'
          ].join('\n')
        }
      }
      const text = "I'll add up this year's orders per customer."
      await this.stream(req, text)
      req.onEvent({ type: 'tool-call', id: call.id, name: call.name, input: call.input })
      return this.turn([{ type: 'text', text }, call], 'tool_use')
    }
    const rows = result.output
      .split('\n')
      .slice(1)
      .filter((l) => l.includes('\t'))
      .map((l) => l.split('\t'))
    const money = (v: string): string => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    const text = rows.length
      ? [
          'Top 5 customers by revenue in 2026:',
          '',
          '| # | Customer | Revenue |',
          '|---|---|---:|',
          ...rows.map(([name, revenue], i) => `| ${i + 1} | ${name} | ${money(revenue)} |`),
          '',
          `**${rows[0][0]}** leads with ${money(rows[0][1])}.`
        ].join('\n')
      : 'There are no orders this year yet.'
    await this.stream(req, text)
    return this.turn([{ type: 'text', text }], 'end')
  }

  /** Emits the text in small chunks, like a real model stream. */
  private async stream(req: LlmTurnRequest, text: string): Promise<void> {
    for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
      if (req.signal.aborted) throw new Error('aborted')
      req.onEvent({ type: 'text-delta', text: chunk })
      await new Promise((r) => setTimeout(r, 28))
    }
  }

  private turn(parts: ChatPart[], stopReason: LlmTurnResult['stopReason']): LlmTurnResult {
    const message: ChatMessage = { id: randomUUID(), role: 'assistant', parts, createdAt: new Date().toISOString(), provider: this.id, model: 'demo' }
    return { message, stopReason }
  }
}
