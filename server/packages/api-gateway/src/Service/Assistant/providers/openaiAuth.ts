import { AssistantProviderConfig } from './factory'

/**
 * OpenAI-compatible upstream auth/endpoint construction.
 *
 * Two modes are supported:
 *
 *  - 'api-key' (DEFAULT, unchanged behavior): the proxy authenticates to an
 *    OpenAI-compatible Chat Completions endpoint with a plain OpenAI API key via
 *    `Authorization: Bearer <key>`. Base URL defaults to https://api.openai.com/v1.
 *
 *  - 'subscription' (OPT-IN): the proxy authenticates using a ChatGPT / Codex
 *    *subscription* credential — an OAuth access token / session token obtained
 *    from a ChatGPT account login — rather than an API key, and targets the
 *    ChatGPT/Codex backend base URL. The ChatGPT backend historically requires
 *    extra headers such as a `ChatGPT-Account-Id` and an `OpenAI-Beta` flag, so
 *    those are configurable here.
 *
 * IMPORTANT / UNVERIFIED: The ChatGPT/Codex backend contract is NOT a public,
 * stable API. The default subscription base URL and the extra-header names below
 * are best-effort placeholders based on the publicly-observed shape of the
 * ChatGPT backend. They are intentionally fully overridable via env so pointing
 * this at the real endpoint is a config change, not a code change. The actual
 * request/response wire format (whether the Codex backend speaks the standard
 * OpenAI `/chat/completions` SSE schema, or a `/responses`-style schema, and what
 * exact headers it rejects/requires) MUST be verified against a live ChatGPT/Codex
 * subscription before this can be claimed to work end-to-end. See the report.
 */

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Default base URL for the ChatGPT/Codex subscription backend. This is a
 * best-effort placeholder and is overridable via ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL.
 * The real value must be confirmed against a live subscription.
 */
export const DEFAULT_CODEX_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex'

export type OpenAiAuthMode = 'api-key' | 'subscription'

/**
 * Fully-resolved upstream connection parameters the OpenAI client/provider needs.
 * This is the single source of truth the OpenAIProvider is constructed from, so
 * the API-key vs subscription decision lives in one pure, testable place.
 */
export interface ResolvedOpenAiUpstream {
  baseURL: string
  /**
   * Value handed to the OpenAI SDK `apiKey`. In subscription mode this is the
   * subscription access token (the SDK still sends it as `Authorization: Bearer`).
   * In api-key mode it is the OpenAI API key (or a 'not-required' placeholder for
   * local servers that accept any non-empty key).
   */
  apiKey: string
  /** Extra headers merged onto every upstream request (account id / beta / custom). */
  defaultHeaders: Record<string, string>
  mode: OpenAiAuthMode
}

function normalizeMode(raw: string | undefined): OpenAiAuthMode {
  return raw === 'subscription' ? 'subscription' : 'api-key'
}

/**
 * Parses the optional ASSISTANT_OPENAI_EXTRA_HEADERS env value. Accepts either a
 * JSON object (`{"X-Foo":"bar"}`) or a comma-separated `Key: Value` list. Invalid
 * input yields no extra headers rather than throwing, so a malformed operator
 * config never takes the proxy down.
 */
export function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) {
    return {}
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v != null) {
          out[k] = `${v}`
        }
      }
      return out
    } catch {
      return {}
    }
  }

  const out: Record<string, string> = {}
  for (const pair of trimmed.split(',')) {
    const idx = pair.indexOf(':')
    if (idx === -1) {
      continue
    }
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) {
      out[key] = value
    }
  }
  return out
}

/**
 * The single decision point for OpenAI-compatible upstream auth + endpoint.
 * Pure function of config so it is trivially unit-testable. Defaults preserve the
 * pre-existing API-key behavior exactly when no subscription config is present.
 */
export function resolveOpenAiUpstream(config: AssistantProviderConfig): ResolvedOpenAiUpstream {
  const mode = normalizeMode(config.openaiAuthMode)

  if (mode === 'subscription') {
    const baseURL = config.openaiSubscriptionBaseURL || config.openaiBaseURL || DEFAULT_CODEX_SUBSCRIPTION_BASE_URL

    // The subscription token is the bearer credential. We deliberately do NOT
    // fall back to the API key here: subscription mode is an explicit opt-in and
    // mixing credentials silently would be surprising. A missing token surfaces
    // as an auth failure upstream rather than leaking the API key.
    const apiKey = (config.openaiSubscriptionToken || '').trim() || 'missing-subscription-token'

    const defaultHeaders: Record<string, string> = {
      ...parseExtraHeaders(config.openaiExtraHeaders),
    }
    if (config.openaiAccountId) {
      // Header name is configurable upstream-contract detail; this is the
      // commonly-observed name. Override via ASSISTANT_OPENAI_EXTRA_HEADERS if the
      // live backend expects a different one.
      defaultHeaders['ChatGPT-Account-Id'] = config.openaiAccountId
    }
    if (config.openaiBeta) {
      defaultHeaders['OpenAI-Beta'] = config.openaiBeta
    }

    return { baseURL, apiKey, defaultHeaders, mode }
  }

  // api-key mode (default, unchanged).
  const baseURL = config.openaiBaseURL || DEFAULT_OPENAI_BASE_URL
  // Local servers (LM Studio / Ollama) accept any non-empty key; send a
  // placeholder when none is configured so the SDK does not reject it.
  const apiKey = config.openaiApiKey || 'not-required'
  const defaultHeaders = parseExtraHeaders(config.openaiExtraHeaders)

  return { baseURL, apiKey, defaultHeaders, mode }
}

/**
 * Whether the OpenAI-compatible provider has enough config to be advertised.
 * In subscription mode a token (or base URL) is what makes it "configured"; in
 * api-key mode an API key or an explicit base URL does.
 */
export function openAiCompatibleConfigured(config: AssistantProviderConfig): boolean {
  if (normalizeMode(config.openaiAuthMode) === 'subscription') {
    return Boolean(config.openaiSubscriptionToken || config.openaiSubscriptionBaseURL || config.openaiBaseURL)
  }
  return Boolean(config.openaiBaseURL || config.openaiApiKey)
}
