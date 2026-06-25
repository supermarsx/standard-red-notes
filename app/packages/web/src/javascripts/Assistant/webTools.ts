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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Map a non-OK HTTP status to a human/model-readable error string. 404/501 are
 * treated as "the operator hasn't configured web tools" so the model can tell the
 * user rather than retrying forever.
 */
function describeHttpError(status: number, data: { error?: unknown; message?: unknown }): string {
  const serverMessage = asString(data.error) || asString(data.message)
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

  try {
    const { ok, status, data } = await application.serverJsonRequest<RawSearchData>(
      WEB_SEARCH_ROUTE,
      { query: trimmed, ...(typeof options.limit === 'number' ? { limit: options.limit } : {}) },
      options.signal,
    )

    if (!ok) {
      return { error: describeHttpError(status, data) }
    }

    const rawResults = Array.isArray(data.results) ? data.results : []
    const results: WebSearchResult[] = rawResults.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>
      return {
        title: asString(item.title),
        url: asString(item.url),
        snippet: asString(item.snippet),
      }
    })

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
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: 'The "url" must be an absolute http(s) URL.' }
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

    return {
      title: asString(data.title),
      text: asString(data.text),
    }
  } catch (error) {
    return { error: `Web fetch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
