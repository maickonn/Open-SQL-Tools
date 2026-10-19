import type { AiProviderId } from '@shared/model'
import type { LlmProvider } from '@domain/ports/llm'
import { secretKeys, type SecretStore } from '@domain/ports/repositories'
import { AnthropicProvider } from '@infrastructure/llm/anthropicProvider'
import { OpenAIProvider } from '@infrastructure/llm/openaiProvider'

/** Lazily builds provider clients from the API keys in the secret store. */
export class ProviderRegistry {
  private readonly cache = new Map<AiProviderId, LlmProvider>()

  constructor(private readonly secrets: SecretStore) {}

  async get(id: AiProviderId): Promise<LlmProvider> {
    const cached = this.cache.get(id)
    if (cached) return cached
    const key = await this.secrets.get(secretKeys.aiKey(id))
    if (!key) throw new Error(id === 'anthropic' ? 'Set your Anthropic API key in Settings → AI.' : 'Set your OpenAI API key in Settings → AI.')
    const provider = id === 'anthropic' ? new AnthropicProvider(key) : new OpenAIProvider(key)
    this.cache.set(id, provider)
    return provider
  }

  invalidate(id: AiProviderId): void {
    this.cache.delete(id)
  }
}
