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
const OPENAI_ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/models'] as const

export type OpenAiAuthMode = 'api-key' | 'subscription'
const MAX_SUBSCRIPTION_BEARER_LENGTH = 256 * 1024
const MAX_UPSTREAM_HEADER_VALUE_LENGTH = 8 * 1024

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

/**
 * Accept a configured API root or a pasted full OpenAI endpoint, but always
 * hand the SDK one canonical base. Otherwise the SDK appends its route to the
 * pasted route and produces paths such as `/chat/completions/chat/completions`.
 */
function canonicalOpenAiUpstreamBaseUrl(raw: string, bareOriginPath: '/' | '/v1'): string {
  const url = new URL(raw)
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('The OpenAI-compatible base URL cannot contain a query string or fragment.')
  }
  let path = url.pathname.replace(/\/+$/, '')
  const lowerPath = path.toLowerCase()
  const endpointSuffix = OPENAI_ENDPOINT_SUFFIXES.find((suffix) => lowerPath.endsWith(suffix))
  if (endpointSuffix) {
    path = path.slice(0, -endpointSuffix.length).replace(/\/+$/, '')
  }
  if (!path) {
    // A bare origin conventionally means /v1. A full endpoint mounted directly
    // at the origin must instead canonicalize back to that origin; adding /v1
    // would silently route /responses to the wrong API.
    path = endpointSuffix ? '/' : bareOriginPath
  }
  url.pathname = path
  return url.toString().replace(/\/$/, '')
}

export function normalizeOpenAiUpstreamBaseUrl(raw: string): string {
  return canonicalOpenAiUpstreamBaseUrl(raw, '/v1')
}

function normalizeMode(raw: string | undefined): OpenAiAuthMode {
  return raw === 'subscription' ? 'subscription' : 'api-key'
}

function isHeaderSafeValue(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isRealSubscriptionBearer(value: unknown): value is string {
  return isHeaderSafeValue(value, MAX_SUBSCRIPTION_BEARER_LENGTH) && !/^\s*$/.test(value)
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function hasUnambiguousNetworkUrlSyntax(raw: string): boolean {
  if (raw.trim() !== raw) {
    return false
  }
  for (const character of raw) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      character === '\\' ||
      /\s/u.test(character) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false
    }
  }
  const authority = /^(?:https?):\/\/([^/?#]+)/i.exec(raw)?.[1]
  return Boolean(authority && !authority.includes('@'))
}

function hasExplicitRawLoopbackAuthority(raw: string): boolean {
  const authority = /^(?:http):\/\/([^/?#]+)/i.exec(raw)?.[1]
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(authority ?? '')
}

/**
 * Subscription credentials are more privileged than ordinary API keys. Never
 * transport them to URL userinfo/query/fragment components or cleartext remote
 * HTTP. Paths are allowed because the observed Codex backend uses one.
 */
export function safeSubscriptionBaseUrl(raw: string): string | null {
  if (!hasUnambiguousNetworkUrlSyntax(raw)) {
    return null
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const safeProtocol =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHost(url.hostname) && hasExplicitRawLoopbackAuthority(raw))
  if (!safeProtocol || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    return null
  }
  // Subscription/Codex backends do not conventionally imply `/v1` when an
  // operator configures a bare origin, but pasted full endpoints still need
  // their route suffix removed to avoid double-appending `/responses`.
  return canonicalOpenAiUpstreamBaseUrl(url.toString(), '/')
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
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
        const stringValue = v == null ? '' : `${v}`
        if (isHeaderName(k) && isHeaderSafeValue(stringValue, MAX_UPSTREAM_HEADER_VALUE_LENGTH)) {
          out[k] = stringValue
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
    if (isHeaderName(key) && isHeaderSafeValue(value, MAX_UPSTREAM_HEADER_VALUE_LENGTH)) {
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
    if (!isRealSubscriptionBearer(config.openaiSubscriptionToken)) {
      throw new Error('ChatGPT/Codex subscription credential is unavailable or invalid.')
    }
    const baseURL = safeSubscriptionBaseUrl(
      config.openaiSubscriptionBaseURL || config.openaiBaseURL || DEFAULT_CODEX_SUBSCRIPTION_BASE_URL,
    )
    if (!baseURL) {
      throw new Error('ChatGPT/Codex subscription endpoint is unsafe or invalid.')
    }

    // Preserve the opaque, control-free bearer exactly. Trimming would mutate a
    // credential returned by the provider.
    const apiKey = config.openaiSubscriptionToken

    const defaultHeaders: Record<string, string> = {
      ...parseExtraHeaders(config.openaiExtraHeaders),
    }
    if (config.openaiAccountId !== undefined) {
      if (!isHeaderSafeValue(config.openaiAccountId, MAX_UPSTREAM_HEADER_VALUE_LENGTH)) {
        throw new Error('ChatGPT/Codex account id is unsafe or invalid.')
      }
      // Header name is configurable upstream-contract detail; this is the
      // commonly-observed name. Override via ASSISTANT_OPENAI_EXTRA_HEADERS if the
      // live backend expects a different one.
      defaultHeaders['ChatGPT-Account-Id'] = config.openaiAccountId
    }
    if (config.openaiBeta !== undefined) {
      if (!isHeaderSafeValue(config.openaiBeta, MAX_UPSTREAM_HEADER_VALUE_LENGTH)) {
        throw new Error('ChatGPT/Codex beta header is unsafe or invalid.')
      }
      defaultHeaders['OpenAI-Beta'] = config.openaiBeta
    }

    return { baseURL, apiKey, defaultHeaders, mode }
  }

  // api-key mode (default, unchanged).
  const baseURL = normalizeOpenAiUpstreamBaseUrl(config.openaiBaseURL || DEFAULT_OPENAI_BASE_URL)
  // Local servers (LM Studio / Ollama) accept any non-empty key; send a
  // placeholder when none is configured so the SDK does not reject it.
  const apiKey = config.openaiApiKey || 'not-required'
  const defaultHeaders = parseExtraHeaders(config.openaiExtraHeaders)

  return { baseURL, apiKey, defaultHeaders, mode }
}

/**
 * Whether the OpenAI-compatible provider has enough config to be advertised.
 * Subscription mode requires both a real bearer and a safe credential
 * destination; API-key mode requires an API key or an explicit base URL.
 */
export function openAiCompatibleConfigured(config: AssistantProviderConfig): boolean {
  if (normalizeMode(config.openaiAuthMode) === 'subscription') {
    return (
      isRealSubscriptionBearer(config.openaiSubscriptionToken) &&
      safeSubscriptionBaseUrl(
        config.openaiSubscriptionBaseURL || config.openaiBaseURL || DEFAULT_CODEX_SUBSCRIPTION_BASE_URL,
      ) !== null
    )
  }
  return Boolean(config.openaiBaseURL || config.openaiApiKey)
}
