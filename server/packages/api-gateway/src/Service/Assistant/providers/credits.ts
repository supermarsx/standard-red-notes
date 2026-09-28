// Standard Red Notes: PROVIDER CREDIT / BALANCE lookup.
//
// Reports how much credit remains on the SERVER-HELD key of an assistant
// profile, for the small number of providers that actually publish such a thing.
//
// Design constraints this module exists to hold:
//
//   1. The API key is used ONLY to authenticate the upstream call. It is never
//      returned, never logged, and never echoed back in any shape.
//   2. The provider's raw response body NEVER leaves this module. Every parser
//      extracts a NAMED ALLOWLIST of scalars and discards everything else, so a
//      field a vendor adds next year cannot leak through by default. This is not
//      hypothetical: OpenRouter's key endpoint returns a `label` holding the
//      key's user-chosen name, and DeepSeek's 401 body echoes a masked fragment
//      of the key itself.
//   3. Nothing here ever throws. Every failure becomes a typed `unavailable`
//      result with a specific reason, mirroring the `catch { return [] }`
//      discipline of listProviderModels/listPresetModels.
//
// Only TWO of the sixteen catalog providers expose a balance readable with the
// ordinary inference key that a profile stores, so `unsupported` is the COMMON
// case and is a first-class result rather than an error.
//
// keep in sync with web Assistant/providerCredits.ts

/** Provider kinds an assistant profile can target (mirrors profiles.ts). */
export type CreditsProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'

/** Why a lookup could not produce a number. Distinct from "unsupported". */
export type CreditsFailureReason = 'unauthorized' | 'rate-limited' | 'network' | 'timeout' | 'unreadable'

/**
 * The ONLY shape that crosses the wire. Four mutually-exclusive states so the
 * client can say precisely which of "this provider has no such API", "no key is
 * configured" and "the lookup failed" happened, rather than rendering a blank.
 */
export type CreditsResult =
  | { status: 'unsupported'; provider: string }
  | { status: 'not-configured'; provider: string }
  | { status: 'unavailable'; provider: string; reason: CreditsFailureReason }
  | {
      status: 'ok'
      provider: string
      /** Remaining credit, or null when the provider reports no cap/limit. */
      remaining: number | null
      /** Spend to date where the provider reports it, else null. */
      usage: number | null
      /** ISO-4217-shaped code, validated to three uppercase letters. */
      currency: string
      /** Non-secret explanation when `remaining` is null or otherwise qualified. */
      note?: string
      /** When this was fetched, so the client can age the number honestly. */
      fetchedAt: string
    }

/** Bounded upstream timeout. A slow provider must never delay the settings pane. */
export const CREDITS_TIMEOUT_MS = 8_000

/** Parsed, allowlisted balance figures — the most any parser may return. */
export interface ParsedCredits {
  remaining: number | null
  usage: number | null
  currency: string
  note?: string
}

/** A provider that publishes a readable balance. */
interface CreditsEndpoint {
  /** Path appended to the base URL's ORIGIN (not its versioned path). */
  path: string
  parse: (payload: unknown) => ParsedCredits | null
}

/** Hostname -> human label, used for every result including `unsupported`. */
const HOST_LABELS: Record<string, string> = {
  'openrouter.ai': 'OpenRouter',
  'api.deepseek.com': 'DeepSeek',
  'api.openai.com': 'OpenAI',
  'api.groq.com': 'Groq',
  'api.together.xyz': 'Together',
  'api.together.ai': 'Together',
  'api.mistral.ai': 'Mistral',
  'api.perplexity.ai': 'Perplexity',
  'api.x.ai': 'xAI (Grok)',
  'api.fireworks.ai': 'Fireworks',
  'generativelanguage.googleapis.com': 'Google Gemini',
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/** Parses a base URL into its lowercase hostname; null when unparseable. */
function hostnameOf(baseUrl: string | undefined): string | null {
  const value = (baseUrl ?? '').trim()
  if (!value) {
    return null
  }
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Human label for a profile, used in EVERY result so that an `unsupported`
 * answer names which provider it is about — someone switching from Anthropic to
 * OpenRouter has to be able to see why the button suddenly does something.
 */
export function creditsProviderLabel(kind: CreditsProviderKind, baseUrl?: string): string {
  switch (kind) {
    case 'anthropic':
      return 'Anthropic'
    case 'ollama':
      return 'Ollama'
    case 'codex-subscription':
      return 'ChatGPT / Codex subscription'
    case 'openai-compatible':
    default: {
      const hostname = hostnameOf(baseUrl)
      if (!hostname) {
        // An openai-compatible profile with no base URL defaults to OpenAI's API.
        return 'OpenAI'
      }
      if (LOOPBACK_HOSTS.has(hostname)) {
        return 'Local server'
      }
      return HOST_LABELS[hostname] ?? hostname
    }
  }
}

/** Reads a finite number, else null. Rejects NaN/Infinity and non-numbers. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Reads a numeric STRING (DeepSeek returns amounts as strings), else null. */
function finiteNumericString(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Accepts only a three-letter uppercase currency code — never free text. */
function currencyCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * OpenRouter `GET /api/v1/key`.
 *
 * ALLOWLIST: `data.limit_remaining`, `data.limit`, `data.usage`. Everything else
 * in the response — notably `label`, which holds the key's user-chosen name — is
 * dropped here and never reaches a caller.
 *
 * `limit_remaining` is NULLABLE, and null means "no per-key credit cap is set",
 * which is emphatically NOT a zero balance. Reporting 0 there would tell someone
 * with unlimited credit that they have none.
 */
export function parseOpenRouterKeyPayload(payload: unknown): ParsedCredits | null {
  const root = asRecord(payload)
  const data = root && asRecord(root.data)
  if (!data) {
    return null
  }

  const remaining = finiteNumber(data.limit_remaining)
  const usage = finiteNumber(data.usage)
  const limit = finiteNumber(data.limit)

  if (remaining === null && usage === null && limit === null) {
    // Nothing numeric at all — treat as an unreadable shape rather than "ok".
    return null
  }

  return {
    remaining,
    usage,
    currency: 'USD',
    ...(remaining === null ? { note: 'This key has no credit limit set, so no remaining balance is reported.' } : {}),
  }
}

/**
 * DeepSeek `GET /user/balance`.
 *
 * ALLOWLIST: `is_available`, and from the FIRST `balance_infos` entry only
 * `currency` and `total_balance`. Amounts arrive as STRINGS.
 */
export function parseDeepSeekBalancePayload(payload: unknown): ParsedCredits | null {
  const root = asRecord(payload)
  if (!root) {
    return null
  }

  const balances = Array.isArray(root.balance_infos) ? root.balance_infos : []
  const first = balances.length > 0 ? asRecord(balances[0]) : null
  if (!first) {
    return null
  }

  const remaining = finiteNumericString(first.total_balance)
  if (remaining === null) {
    return null
  }

  const available = root.is_available === true

  return {
    remaining,
    usage: null,
    currency: currencyCode(first.currency, 'USD'),
    ...(available ? {} : { note: 'DeepSeek reports this balance as insufficient for further API calls.' }),
  }
}

/**
 * The providers that publish a balance readable with the ordinary inference key
 * a profile stores, keyed by hostname.
 *
 * Deliberately ABSENT, each verified against vendor documentation rather than
 * assumed:
 *   - Anthropic — no balance endpoint exists; the request for one was closed as
 *     not planned. The Admin API reports spend, not remaining, and needs a
 *     separate admin key.
 *   - OpenAI — no documented endpoint. The dashboard billing route is
 *     undocumented and wants a browser session key, not an `sk-` API key.
 *   - xAI — balance lives on a different host behind a management key.
 *   - OpenRouter `/api/v1/credits` — account-wide, but requires a MANAGEMENT key
 *     and returns 403 for an inference key, so `/api/v1/key` is used instead.
 *   - Groq, Mistral, Together, Fireworks, Perplexity, Cohere, Gemini, Azure —
 *     nothing an inference key can read.
 *   - Ollama / LM Studio / custom — local; no billing concept.
 */
const CREDITS_ENDPOINTS: Record<string, CreditsEndpoint> = {
  'openrouter.ai': { path: '/api/v1/key', parse: parseOpenRouterKeyPayload },
  'api.deepseek.com': { path: '/user/balance', parse: parseDeepSeekBalancePayload },
}

/**
 * Whether this profile's provider publishes a readable balance at all. Pure.
 * Only `openai-compatible` profiles can qualify — the other kinds are either
 * documented as having no such API, or are local servers with no billing.
 */
export function supportsCreditsLookup(kind: CreditsProviderKind, baseUrl?: string): boolean {
  return creditsEndpointFor(kind, baseUrl) !== null
}

/** Resolves the absolute lookup URL for a profile, or null when unsupported. */
export function creditsEndpointUrl(kind: CreditsProviderKind, baseUrl?: string): string | null {
  const endpoint = creditsEndpointFor(kind, baseUrl)
  if (!endpoint) {
    return null
  }
  const value = (baseUrl ?? '').trim()
  try {
    // Built from the ORIGIN, never the versioned path: DeepSeek's balance route
    // sits at the root while its base URL ends in `/v1`, so appending to the
    // base URL would produce a mystifying 404.
    return `${new URL(value).origin}${endpoint.path}`
  } catch {
    return null
  }
}

function creditsEndpointFor(kind: CreditsProviderKind, baseUrl?: string): CreditsEndpoint | null {
  if (kind !== 'openai-compatible') {
    return null
  }
  const hostname = hostnameOf(baseUrl)
  return hostname ? (CREDITS_ENDPOINTS[hostname] ?? null) : null
}

/** Maps an upstream HTTP status onto a specific, non-leaking failure reason. */
export function creditsFailureReasonForStatus(status: number): CreditsFailureReason {
  if (status === 401 || status === 403) {
    return 'unauthorized'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  return 'unreadable'
}

/** Distinguishes an abort/timeout from a transport failure. */
function reasonForThrown(error: unknown): CreditsFailureReason {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
}

export interface CreditsLookupInput {
  kind: CreditsProviderKind
  baseUrl?: string
  /** Server-held key. Used ONLY as a bearer; never returned or logged. */
  apiKey?: string
}

export interface CreditsLookupDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
}

/**
 * Looks up the remaining credit for one profile. NEVER throws and never blocks
 * on an unbounded upstream — every outcome is one of the four result states.
 */
export async function fetchProviderCredits(
  input: CreditsLookupInput,
  deps: CreditsLookupDeps = {},
): Promise<CreditsResult> {
  const provider = creditsProviderLabel(input.kind, input.baseUrl)
  const endpoint = creditsEndpointFor(input.kind, input.baseUrl)
  if (!endpoint) {
    return { status: 'unsupported', provider }
  }

  const apiKey = (input.apiKey ?? '').trim()
  if (!apiKey) {
    return { status: 'not-configured', provider }
  }

  const url = creditsEndpointUrl(input.kind, input.baseUrl)
  if (!url) {
    return { status: 'unsupported', provider }
  }

  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())

  let response: Response
  try {
    response = await doFetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    return { status: 'unavailable', provider, reason: reasonForThrown(error) }
  }

  if (!response.ok) {
    return { status: 'unavailable', provider, reason: creditsFailureReasonForStatus(response.status) }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { status: 'unavailable', provider, reason: 'unreadable' }
  }

  const parsed = endpoint.parse(payload)
  if (!parsed) {
    return { status: 'unavailable', provider, reason: 'unreadable' }
  }

  return {
    status: 'ok',
    provider,
    remaining: parsed.remaining,
    usage: parsed.usage,
    currency: parsed.currency,
    ...(parsed.note ? { note: parsed.note } : {}),
    fetchedAt: now().toISOString(),
  }
}
