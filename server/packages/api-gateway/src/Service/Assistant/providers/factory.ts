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
 * Lists the model identifiers a configured provider offers, queried with the
 * server-held credentials. Returns an empty array if the provider is not
 * configured or the upstream query fails — model discovery is best-effort and
 * never throws, so the client can still fall back to a free-text model field.
 * API keys are used only to authenticate the upstream call and are never
 * returned.
 */
export async function listProviderModels(provider: string, config: AssistantProviderConfig): Promise<string[]> {
  try {
    switch (provider) {
      case 'anthropic': {
        if (!config.anthropicApiKey) {
          return []
        }
        const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
          headers: { 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        })
        if (!res.ok) {
          return []
        }
        const json = (await res.json()) as { data?: Array<{ id?: string }> }
        return (json.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
      }
      case 'openai':
      case 'openai-compatible': {
        if (!openAiCompatibleConfigured(config)) {
          return []
        }
        const baseURL = config.openaiBaseURL || DEFAULT_OPENAI_BASE_URL
        const apiKey = config.openaiApiKey || 'not-required'
        const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (!res.ok) {
          return []
        }
        const json = (await res.json()) as { data?: Array<{ id?: string }> }
        return (json.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
      }
      case 'ollama': {
        if (!config.ollamaUrl) {
          return []
        }
        const res = await fetch(`${config.ollamaUrl.replace(/\/$/, '')}/api/tags`)
        if (!res.ok) {
          return []
        }
        const json = (await res.json()) as { models?: Array<{ name?: string }> }
        return (json.models ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name))
      }
      default:
        return []
    }
  } catch {
    return []
  }
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
