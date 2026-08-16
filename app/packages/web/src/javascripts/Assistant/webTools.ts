import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: the assistant's WEB tools (`web.search` / `web.fetch`).
 *
 * These are the ONLY assistant tools that leave the device: each one POSTs to a
 * server-mediated route using the app's authenticated request mechanism
 * (`WebApplication.serverJsonRequest`, which attaches the session access token as
 * a Bearer header exactly like the AI proxy / GitHub-publish integrations). The
 * server actually performs the search/fetch (so the provider key + any upstream
 * web API key stay server-side); the browser only ever sees the JSON results.
 *
 * PRIVACY: the `query` (for search) or `url` (for fetch) the model passes leaves
 * end-to-end encryption — it is sent to the server in plaintext, like every other
 * server-mediated assistant feature. The model is told this in the system prompt.
 *
 * Robustness contract: these helpers NEVER throw. A non-OK response, a
 * not-configured server (e.g. no SEARCH_API_KEY), a network error, or malformed
 * JSON all resolve to an `{ error }` object whose string the model can read and
 * react to. The server routes are built separately; we just call them and assume
 * the documented JSON shape on success.
 */

/** The route the assistant POSTs to for a web search. */
export const WEB_SEARCH_ROUTE = '/v1/web/search'
/** The route the assistant POSTs to for fetching a single URL. */
export const WEB_FETCH_ROUTE = '/v1/web/fetch'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResponse {
  results: WebSearchResult[]
}

export interface WebFetchResponse {
  title: string
  text: string
}

/** Shape of an error the model can read instead of a thrown exception. */
export interface WebToolError {
  error: string
}

interface RawSearchData {
  results?: unknown
  error?: unknown
  message?: unknown
}

interface RawFetchData {
  title?: unknown
  text?: unknown
  error?: unknown
  message?: unknown
}

const MAX_RESULT_TITLE_CHARS = 500
const MAX_RESULT_URL_CHARS = 2_048
const MAX_RESULT_SNIPPET_CHARS = 4_000
const MAX_SEARCH_QUERY_CHARS = 1_000
const DEFAULT_SEARCH_RESULT_LIMIT = 10
const MAX_SEARCH_RESULT_LIMIT = 20

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/** Keep an upstream error useful to the model without letting untrusted text flood its context. */
function asSafeErrorMessage(value: unknown): string {
  const message =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string'
        ? (value as { message: string }).message
        : ''
  return collapseUntrustedText(message, 500)
}

function normalizeResultUrl(value: unknown): string | undefined {
  const raw = asString(value).trim()
  if (!raw || raw.length > MAX_RESULT_URL_CHARS) {
    return undefined
  }
  if (containsControlCharacter(raw)) {
    return undefined
  }

  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined
    }
    return raw
  } catch {
    return undefined
  }
}

function normalizeResultText(value: unknown, maxLength: number): string {
  return collapseUntrustedText(asString(value), maxLength)
}

function collapseUntrustedText(value: string, maxLength: number): string {
  let sanitized = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/**
 * Map a non-OK HTTP status to a human/model-readable error string. 404/501 are
 * treated as "the operator hasn't configured web tools" so the model can tell the
 * user rather than retrying forever.
 */
function describeHttpError(status: number, data: { error?: unknown; message?: unknown }): string {
  const serverMessage = asSafeErrorMessage(data.error) || asSafeErrorMessage(data.message)
  if (serverMessage) {
    return serverMessage
  }
  if (status === 404 || status === 501) {
    return 'Web tools are not configured on this server.'
  }
  if (status === 401 || status === 403) {
    return 'Not authorized to use web tools (sign in may be required).'
  }
  return `Web request failed (HTTP ${status}).`
}

/**
 * `web.search({ query })` -> `{ results: [{ title, url, snippet }] }`.
 * On any failure resolves to `{ error }` (never throws).
 */
export async function webSearch(
  application: WebApplication,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WebSearchResponse | WebToolError> {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) {
    return { error: 'A non-empty "query" string is required.' }
  }
  if (trimmed.length > MAX_SEARCH_QUERY_CHARS) {
    return { error: `The search query must be ${MAX_SEARCH_QUERY_CHARS.toLocaleString()} characters or fewer.` }
  }
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.max(1, Math.min(MAX_SEARCH_RESULT_LIMIT, Math.floor(options.limit)))
      : DEFAULT_SEARCH_RESULT_LIMIT

  try {
    const { ok, status, data } = await application.serverJsonRequest<RawSearchData>(
      WEB_SEARCH_ROUTE,
      { query: trimmed, limit },
      options.signal,
    )

    if (!ok) {
      return { error: describeHttpError(status, data) }
    }

    const serverError = asSafeErrorMessage(data.error) || asSafeErrorMessage(data.message)
    if (serverError) {
      return { error: `Web search is unavailable: ${serverError}` }
    }
    if (!Array.isArray(data.results)) {
      return { error: 'Web search returned an invalid response. Please try again later.' }
    }

    const results: WebSearchResult[] = []
    for (const entry of data.results) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const item = entry as Record<string, unknown>
      const url = normalizeResultUrl(item.url)
      if (!url) {
        continue
      }
      results.push({
        title: normalizeResultText(item.title, MAX_RESULT_TITLE_CHARS),
        url,
        snippet: normalizeResultText(item.snippet, MAX_RESULT_SNIPPET_CHARS),
      })
      if (results.length >= limit) {
        break
      }
    }

    if (data.results.length > 0 && results.length === 0) {
      return { error: 'Web search returned no usable result URLs. Please refine the query or try again later.' }
    }

    return { results }
  } catch (error) {
    return { error: `Web search failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * `web.fetch({ url })` -> `{ title, text }`.
 * On any failure resolves to `{ error }` (never throws).
 */
export async function webFetch(
  application: WebApplication,
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<WebFetchResponse | WebToolError> {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) {
    return { error: 'A non-empty "url" string is required.' }
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    return { error: 'The "url" must be an absolute http(s) URL.' }
  }
  if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password) {
    return { error: 'The "url" must be an absolute http(s) URL without credentials.' }
  }

  try {
    const { ok, status, data } = await application.serverJsonRequest<RawFetchData>(
      WEB_FETCH_ROUTE,
      { url: trimmed },
      options.signal,
    )

    if (!ok) {
      return { error: describeHttpError(status, data) }
    }

    const serverError = asSafeErrorMessage(data.error) || asSafeErrorMessage(data.message)
    if (serverError) {
      return { error: `Web fetch is unavailable: ${serverError}` }
    }

    return {
      title: asString(data.title),
      text: asString(data.text),
    }
  } catch (error) {
    return { error: `Web fetch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
