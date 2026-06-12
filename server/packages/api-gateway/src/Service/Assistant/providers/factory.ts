import { Provider } from './types'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'
import { OllamaProvider } from './ollama'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Server-held Assistant provider configuration.
 *
 * The "openai" provider is treated as the general OpenAI-compatible case: it is
 * driven by a configurable base URL so the same code path serves OpenAI itself,
 * LM Studio (http://localhost:1234/v1), Ollama's OpenAI-compatible endpoint
 * (http://localhost:11434/v1), OpenRouter (https://openrouter.ai/api/v1) and any
 * other OpenAI-compatible server. Local servers (LM Studio / Ollama) usually do
 * not require an API key, so the provider is considered configured whenever a
 * base URL is present even without a key.
 *
 * A native "ollama" provider (using Ollama's /api/chat protocol) and "anthropic"
 * remain available as dedicated options.
 */
export interface AssistantProviderConfig {
  anthropicApiKey?: string
  /** API key for the OpenAI-compatible endpoint (optional for local servers). */
  openaiApiKey?: string
  /** Base URL for the OpenAI-compatible endpoint. Defaults to OpenAI's API. */
  openaiBaseURL?: string
  /** Optional default model for the OpenAI-compatible endpoint. */
  openaiModel?: string
  /** Base URL for the native Ollama (/api/chat) provider. */
  ollamaUrl?: string
}

function openAiCompatibleConfigured(config: AssistantProviderConfig): boolean {
  // Configured when either an explicit base URL or an API key is provided. When
  // neither is set we still fall back to OpenAI's base URL but require a key, so
  // an empty config does not advertise a non-functional provider.
  return Boolean(config.openaiBaseURL || config.openaiApiKey)
}

/**
 * Returns the list of providers that have credentials configured on the
 * server. Keys themselves are NEVER exposed.
 */
export function configuredProviders(config: AssistantProviderConfig): string[] {
  const providers: string[] = []
  if (config.anthropicApiKey) {
    providers.push('anthropic')
  }
  if (openAiCompatibleConfigured(config)) {
    providers.push('openai')
  }
  if (config.ollamaUrl) {
    providers.push('ollama')
  }
  return providers
}

/**
 * Resolves a concrete provider for a given request using the server-held
 * credentials. Throws if the requested provider is not configured.
 */
export function resolveProvider(provider: string, model: string, config: AssistantProviderConfig): Provider {
  switch (provider) {
    case 'anthropic':
      if (!config.anthropicApiKey) {
        throw new Error('Anthropic provider is not configured on this server')
      }
      return new AnthropicProvider(model, config.anthropicApiKey)
    case 'openai':
    case 'openai-compatible': {
      if (!openAiCompatibleConfigured(config)) {
        throw new Error('OpenAI-compatible provider is not configured on this server')
      }
      const baseURL = config.openaiBaseURL || DEFAULT_OPENAI_BASE_URL
      // Local servers (LM Studio / Ollama) accept any non-empty key; send a
      // placeholder when none is configured so the SDK does not reject it.
      const apiKey = config.openaiApiKey || 'not-required'
      return new OpenAIProvider(model || config.openaiModel || '', apiKey, baseURL)
    }
    case 'ollama':
      if (!config.ollamaUrl) {
        throw new Error('Ollama provider is not configured on this server')
      }
      return new OllamaProvider(model, config.ollamaUrl)
    default:
      throw new Error(`Unknown assistant provider: ${provider}`)
  }
}
