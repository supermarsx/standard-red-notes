/**
 * Standard Red Notes: PROVIDER CREDIT / BALANCE — shared client core.
 *
 * Serves BOTH connection modes, which keep their keys in different places:
 *
 *   - Direct mode  — the key is the user's own, in their encrypted synced
 *     preferences, and the browser already talks to the provider on every turn.
 *     The lookup is a plain client-side fetch; nothing new is exposed. Routing it
 *     through the server would be strictly worse, pushing a key the server has no
 *     business holding onto the server.
 *   - Server proxy — the key is server-held and admin-configured. The browser
 *     never sees it; it reads the SAME result shape back from the admin-gated
 *     `GET /v1/assistant/credits`.
 *
 * Only TWO of the sixteen catalog providers publish a balance an ordinary
 * inference key can read, so `unsupported` is the COMMON case and must read as
 * deliberate rather than broken.
 *
 * Every parser extracts a NAMED ALLOWLIST of scalars and discards the rest, so a
 * field a vendor adds later cannot leak through by default — OpenRouter's key
 * endpoint returns a `label` holding the key's user-chosen name.
 *
 * keep in sync with server providers/credits.ts
 */

export type CreditsProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'

export type CreditsFailureReason = 'unauthorized' | 'rate-limited' | 'network' | 'timeout' | 'unreadable'

/** The only shape that crosses the wire, and the only shape the UI renders. */
export type CreditsResult =
  | { status: 'unsupported'; provider: string }
  | { status: 'not-configured'; provider: string }
  | { status: 'unavailable'; provider: string; reason: CreditsFailureReason }
  | {
      status: 'ok'
      provider: string
      remaining: number | null
      usage: number | null
      currency: string
      note?: string
      fetchedAt: string
    }

/** Bounded timeout: a slow provider must never delay the preferences pane. */
export const CREDITS_TIMEOUT_MS = 8_000

export interface ParsedCredits {
  remaining: number | null
  usage: number | null
  currency: string
  note?: string
}

interface CreditsEndpoint {
  path: string
  parse: (payload: unknown) => ParsedCredits | null
}

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

const hostnameOf = (baseUrl: string | undefined): string | null => {
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

/** Human label used in EVERY result, so `unsupported` names its provider. */
export const creditsProviderLabel = (kind: CreditsProviderKind, baseUrl?: string): string => {
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
        return 'OpenAI'
      }
      if (LOOPBACK_HOSTS.has(hostname)) {
        return 'Local server'
      }
      return HOST_LABELS[hostname] ?? hostname
    }
  }
}

const finiteNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const finiteNumericString = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const currencyCode = (value: unknown, fallback: string): string => {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : fallback
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * OpenRouter `GET /api/v1/key`. ALLOWLIST: limit_remaining, limit, usage.
 * `limit_remaining` is nullable and null means "no per-key cap is set" — NOT a
 * zero balance. Reporting 0 would tell an uncapped user they have nothing left.
 */
export const parseOpenRouterKeyPayload = (payload: unknown): ParsedCredits | null => {
  const root = asRecord(payload)
  const data = root && asRecord(root.data)
  if (!data) {
    return null
  }

  const remaining = finiteNumber(data.limit_remaining)
  const usage = finiteNumber(data.usage)
  const limit = finiteNumber(data.limit)

  if (remaining === null && usage === null && limit === null) {
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
 * DeepSeek `GET /user/balance`. ALLOWLIST: is_available, plus currency and
 * total_balance from the first entry. Amounts arrive as STRINGS.
 */
export const parseDeepSeekBalancePayload = (payload: unknown): ParsedCredits | null => {
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

  return {
    remaining,
    usage: null,
    currency: currencyCode(first.currency, 'USD'),
    ...(root.is_available === true
      ? {}
      : { note: 'DeepSeek reports this balance as insufficient for further API calls.' }),
  }
}

/**
 * The providers publishing a balance an inference key can read. Absent by
 * verification, not oversight: Anthropic has no such endpoint (the request was
 * closed as not planned); OpenAI's is undocumented and wants a browser session
 * key; xAI's needs a management key on another host; OpenRouter's `/credits`
 * needs a management key and 403s for an inference key, hence `/key` here.
 */
const CREDITS_ENDPOINTS: Record<string, CreditsEndpoint> = {
  'openrouter.ai': { path: '/api/v1/key', parse: parseOpenRouterKeyPayload },
  'api.deepseek.com': { path: '/user/balance', parse: parseDeepSeekBalancePayload },
}

const creditsEndpointFor = (kind: CreditsProviderKind, baseUrl?: string): CreditsEndpoint | null => {
  if (kind !== 'openai-compatible') {
    return null
  }
  const hostname = hostnameOf(baseUrl)
  return hostname ? (CREDITS_ENDPOINTS[hostname] ?? null) : null
}

/** Whether this provider publishes a readable balance at all. Pure. */
export const supportsCreditsLookup = (kind: CreditsProviderKind, baseUrl?: string): boolean =>
  creditsEndpointFor(kind, baseUrl) !== null

/**
 * Absolute lookup URL, built from the base URL's ORIGIN rather than its path:
 * DeepSeek's balance route sits at the root while its base URL ends in `/v1`.
 */
export const creditsEndpointUrl = (kind: CreditsProviderKind, baseUrl?: string): string | null => {
  const endpoint = creditsEndpointFor(kind, baseUrl)
  if (!endpoint) {
    return null
  }
  try {
    return `${new URL((baseUrl ?? '').trim()).origin}${endpoint.path}`
  } catch {
    return null
  }
}

export const creditsFailureReasonForStatus = (status: number): CreditsFailureReason => {
  if (status === 401 || status === 403) {
    return 'unauthorized'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  return 'unreadable'
}

const reasonForThrown = (error: unknown): CreditsFailureReason => {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
}

export interface DirectCreditsDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
}

/**
 * DIRECT MODE lookup: the browser asks the provider straight out, with the key
 * that already lives in this browser and already goes to this host every turn.
 * NEVER throws — every outcome is one of the four result states, including a
 * CORS rejection, which surfaces as the ordinary `network` failure.
 */
export const fetchDirectProviderCredits = async (
  input: { kind: CreditsProviderKind; baseUrl?: string; apiKey?: string },
  deps: DirectCreditsDeps = {},
): Promise<CreditsResult> => {
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

/**
 * Narrows an unknown server payload to a CreditsResult. The admin pane reads
 * this back over HTTP, so an older or misbehaving server must degrade to a
 * typed failure rather than rendering `undefined`.
 */
export const asCreditsResult = (payload: unknown): CreditsResult | null => {
  const root = asRecord(payload)
  const status = root?.status
  const provider = typeof root?.provider === 'string' ? root.provider : ''
  if (!root || !provider) {
    return null
  }

  if (status === 'unsupported' || status === 'not-configured') {
    return { status, provider }
  }
  if (status === 'unavailable') {
    const reasons: CreditsFailureReason[] = ['unauthorized', 'rate-limited', 'network', 'timeout', 'unreadable']
    const reason = reasons.find((candidate) => candidate === root.reason) ?? 'unreadable'
    return { status, provider, reason }
  }
  if (status === 'ok') {
    return {
      status,
      provider,
      remaining: finiteNumber(root.remaining),
      usage: finiteNumber(root.usage),
      currency: currencyCode(root.currency, 'USD'),
      ...(typeof root.note === 'string' && root.note ? { note: root.note } : {}),
      fetchedAt: typeof root.fetchedAt === 'string' ? root.fetchedAt : '',
    }
  }
  return null
}

/** Formats an amount, falling back when the runtime rejects the currency code. */
export const formatCreditsAmount = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * How long ago the figure was read. A number with no statement of its age is a
 * trap, so every successful result is rendered with this alongside it.
 */
export const formatCreditsAge = (fetchedAt: string, now: Date = new Date()): string => {
  const stamp = Date.parse(fetchedAt)
  if (!Number.isFinite(stamp)) {
    return 'checked just now'
  }
  const seconds = Math.max(0, Math.round((now.getTime() - stamp) / 1000))
  if (seconds < 60) {
    return 'checked just now'
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `checked ${minutes} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `checked ${hours} h ago`
  }
  return `checked on ${new Date(stamp).toLocaleDateString()}`
}

/**
 * The single sentence the UI shows. Each of the four states reads differently on
 * purpose: "this provider has no such API", "no key is configured" and "the
 * lookup failed" must never collapse into one blank or one wrong claim.
 */
export const describeCreditsResult = (result: CreditsResult, now: Date = new Date()): string => {
  switch (result.status) {
    case 'unsupported':
      return `${result.provider} does not publish a credit balance that an API key can read.`
    case 'not-configured':
      return `No API key is configured for ${result.provider}, so there is no balance to check.`
    case 'unavailable':
      switch (result.reason) {
        case 'unauthorized':
          return `${result.provider} rejected the configured API key.`
        case 'rate-limited':
          return `${result.provider} is rate-limiting this lookup. Try again shortly.`
        case 'timeout':
          return `${result.provider} did not respond in time.`
        case 'network':
          return `Could not reach ${result.provider}.`
        case 'unreadable':
        default:
          return `${result.provider} returned a balance in an unexpected format.`
      }
    case 'ok':
    default: {
      const age = formatCreditsAge(result.fetchedAt, now)
      if (result.remaining === null) {
        const spent =
          result.usage === null ? '' : ` ${formatCreditsAmount(result.usage, result.currency)} used to date.`
        const note = result.note ?? `${result.provider} reports no remaining balance for this key.`
        return `${note}${spent} (${age})`
      }
      const spent = result.usage === null ? '' : ` · ${formatCreditsAmount(result.usage, result.currency)} used`
      const note = result.note ? ` ${result.note}` : ''
      return `${formatCreditsAmount(result.remaining, result.currency)} remaining on ${result.provider}${spent} (${age})${note}`
    }
  }
}
