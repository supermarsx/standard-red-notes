/**
 * Standard Red Notes: server-side WEB proxy for the in-browser AI agent.
 *
 * WHY THIS EXISTS: the AI agent runs entirely in the browser (notes are E2E
 * encrypted, so the agent loop + tools execute client-side). To do "web
 * research" the agent needs to (a) fetch arbitrary pages without tripping CORS
 * and (b) run a web search without shipping a search API key to every client.
 * This service performs both server-side so the search key stays on the server
 * and cross-origin fetches succeed.
 *
 * SECURITY: `/v1/web/fetch` is a server-side fetcher and therefore an SSRF
 * target. `assertPublicHttpUrl` rejects non-http(s) schemes and any host that
 * resolves to (or is literally) a private / loopback / link-local / cloud
 * metadata address. The controller layer additionally requires a valid user
 * session so this is never an open proxy.
 */

import { lookup } from 'dns/promises'
import { isIP } from 'net'
import {
  isBlockedHostname as isSharedBlockedHostname,
  isBlockedIp as isSharedBlockedIp,
} from '@standardnotes/domain-core'

export type WebFetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
    redirect?: 'follow' | 'manual' | 'error'
  },
) => Promise<{
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(reason?: unknown): Promise<void> | void
      releaseLock?(): void
    }
    cancel?(reason?: unknown): Promise<void> | void
  } | null
  text: () => Promise<string>
}>

export interface WebServiceConfig {
  // Search backend selection + credentials. All optional; when unconfigured,
  // search returns an empty result set with an `error` marker (never a 500).
  searchProvider?: string
  searchApiUrl?: string
  searchApiKey?: string
  // Caps, with safe defaults applied in the constructor.
  maxContentChars?: number
  // Maximum decoded response bytes accepted from a fetched page.
  maxFetchBytes?: number
  // Maximum decoded JSON bytes accepted from the configured search backend.
  maxSearchBytes?: number
  // Per-request fetch timeout (ms).
  fetchTimeoutMs?: number
  // Per-request search timeout (ms).
  searchTimeoutMs?: number
}

export interface WebFetchResult {
  status: number
  contentType: string
  title: string
  text: string
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  results: WebSearchResultItem[]
  // Present (and `results` empty) when search is unconfigured or upstream failed.
  error?: string
}

export class WebValidationError extends Error {
  constructor(
    message: string,
    readonly tag: string = 'invalid-input',
  ) {
    super(message)
    this.name = 'WebValidationError'
  }
}

const DEFAULT_MAX_CONTENT_CHARS = 100_000
const DEFAULT_MAX_FETCH_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_SEARCH_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_QUERY_CHARS = 1_000
const MAX_SEARCH_RESULTS = 20
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000
const USER_AGENT = 'standard-red-notes-web-proxy'

export class WebService {
  private readonly maxContentChars: number
  private readonly maxFetchBytes: number
  private readonly maxSearchBytes: number
  private readonly fetchTimeoutMs: number
  private readonly searchTimeoutMs: number

  constructor(
    private readonly fetchFn: WebFetchLike,
    private readonly config: WebServiceConfig = {},
    // DNS resolver injectable for tests; defaults to the real resolver.
    private readonly resolveHost: (host: string) => Promise<string[]> = defaultResolveHost,
    // Search is an operator-configured trust path, separate from arbitrary
    // public-only URLs supplied to fetch().
    private readonly searchFetchFn: WebFetchLike = fetchFn,
  ) {
    this.maxContentChars =
      config.maxContentChars && config.maxContentChars > 0 ? config.maxContentChars : DEFAULT_MAX_CONTENT_CHARS
    this.maxFetchBytes =
      config.maxFetchBytes && config.maxFetchBytes > 0 ? config.maxFetchBytes : DEFAULT_MAX_FETCH_BYTES
    this.maxSearchBytes =
      config.maxSearchBytes && config.maxSearchBytes > 0 ? config.maxSearchBytes : DEFAULT_MAX_SEARCH_BYTES
    this.fetchTimeoutMs =
      config.fetchTimeoutMs && config.fetchTimeoutMs > 0 ? config.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
    this.searchTimeoutMs =
      config.searchTimeoutMs && config.searchTimeoutMs > 0 ? config.searchTimeoutMs : DEFAULT_SEARCH_TIMEOUT_MS
  }

  /**
   * Fetch a URL server-side and return the readable plain text. Throws
   * {@link WebValidationError} (safe message) for bad/blocked URLs.
   */
  async fetch(rawUrl: string): Promise<WebFetchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

    try {
      const response = await this.fetchFollowingRedirects(rawUrl, controller.signal)
      const contentType = response.headers.get('content-type') || ''
      const body = await this.readBoundedBody(response, controller)

      const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(body)
      const title = isHtml ? extractTitle(body) : ''
      const text = isHtml ? htmlToText(body) : body
      const cappedText = text.length > this.maxContentChars ? text.slice(0, this.maxContentChars) : text

      return {
        status: response.status,
        contentType,
        title,
        text: cappedText,
      }
    } catch (error) {
      // Preserve URL validation and bounded-response errors verbatim.
      if (error instanceof WebValidationError) {
        throw error
      }
      if (controller.signal.aborted || (error as Error).name === 'AbortError') {
        throw new WebValidationError('The request timed out.', 'fetch-timeout')
      }
      throw new WebValidationError('Failed to fetch the URL.', 'fetch-failed')
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Consume the decoded response stream under a strict byte ceiling. Node's
   * fetch exposes decompressed bytes here, so compressed expansion is bounded
   * as well. Content-Length is deliberately not trusted: it can be absent,
   * forged, or describe the encoded representation.
   */
  private async readBoundedBody(
    response: Awaited<ReturnType<WebFetchLike>>,
    controller: AbortController,
    options: {
      maxBytes: number
      allowTextFallback: boolean
      tooLargeMessage: string
      tooLargeTag: string
    } = {
      maxBytes: this.maxFetchBytes,
      allowTextFallback: true,
      tooLargeMessage: 'The fetched response exceeds the allowed size.',
      tooLargeTag: 'response-too-large',
    },
  ): Promise<string> {
    const stream = response.body
    if (!stream || typeof stream.getReader !== 'function') {
      if (!options.allowTextFallback) {
        throw new WebValidationError(
          'The search backend response could not be streamed.',
          'search-response-unavailable',
        )
      }
      // Compatibility path for fetch doubles and responses without a body.
      // Production fetch responses expose a stream, which is the path that
      // prevents an oversized body from being buffered before enforcement.
      const text = await awaitWithAbort(response.text(), controller.signal)
      if (Buffer.byteLength(text, 'utf8') > options.maxBytes) {
        controller.abort()
        throw new WebValidationError(options.tooLargeMessage, options.tooLargeTag)
      }
      return text
    }

    const reader = stream.getReader()
    const chunks: Buffer[] = []
    let totalBytes = 0
    let cancelled = false
    const cancel = (): void => {
      if (cancelled) {
        return
      }
      cancelled = true
      try {
        void Promise.resolve(reader.cancel()).catch(() => undefined)
      } catch {
        // Best-effort teardown; aborting the request also stops the transfer.
      }
    }

    try {
      for (;;) {
        const { done, value } = await awaitWithAbort(reader.read(), controller.signal)
        if (done) {
          break
        }
        if (!value || value.byteLength === 0) {
          continue
        }

        totalBytes += value.byteLength
        if (totalBytes > options.maxBytes) {
          controller.abort()
          cancel()
          throw new WebValidationError(options.tooLargeMessage, options.tooLargeTag)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      cancel()
      throw error
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // The stream may still have a pending read while cancellation settles.
      }
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8')
  }

  /**
   * Run a web search against the configured backend. Returns
   * `{ results: [], error }` (never throws) when unconfigured or upstream fails,
   * so the controller can answer 200 in those cases.
   */
  async search(query: string): Promise<WebSearchResult> {
    const trimmed = typeof query === 'string' ? query.trim() : ''
    if (trimmed.length === 0) {
      return { results: [], error: 'empty query' }
    }
    if (trimmed.length > MAX_SEARCH_QUERY_CHARS) {
      return { results: [], error: 'search query too long' }
    }

    const provider = (this.config.searchProvider || '').toLowerCase()
    const apiUrl = this.config.searchApiUrl || ''

    if (!provider || !apiUrl) {
      return { results: [], error: 'web search not configured' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.searchTimeoutMs)
    try {
      switch (provider) {
        case 'searxng':
          return await this.searchSearxng(trimmed, controller)
        case 'brave':
          return await this.searchBrave(trimmed, controller)
        case 'serper':
          return await this.searchSerper(trimmed, controller)
        default:
          return { results: [], error: `unsupported search provider '${provider}'` }
      }
    } catch (error) {
      if (error instanceof WebValidationError && error.tag === 'search-response-too-large') {
        return { results: [], error: 'search response too large' }
      }
      const message = (error as Error).name === 'AbortError' ? 'web search timed out' : 'web search failed'
      return { results: [], error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  // SearXNG JSON endpoint: GET {apiUrl}?q=...&format=json -> { results: [{ title, url, content }] }
  private async searchSearxng(query: string, controller: AbortController): Promise<WebSearchResult> {
    const url = appendQuery(this.config.searchApiUrl as string, { q: query, format: 'json' })
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (this.config.searchApiKey) {
      headers['Authorization'] = `Bearer ${this.config.searchApiKey}`
    }
    const response = await this.fetchSearchBackend(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      cancelResponseBody(response)
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await this.readBoundedSearchBody(response, controller))
    const rawResults = arrayAt(parsed, 'results')
    if (!rawResults) {
      return { results: [], error: 'search upstream returned an invalid response' }
    }
    return mapSearchResultResponse(rawResults, (result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content ?? result.snippet,
    }))
  }

  // Brave Search API: GET {apiUrl}?q=... with X-Subscription-Token header ->
  // { web: { results: [{ title, url, description }] } }
  private async searchBrave(query: string, controller: AbortController): Promise<WebSearchResult> {
    const url = appendQuery(this.config.searchApiUrl as string, { q: query })
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (this.config.searchApiKey) {
      headers['X-Subscription-Token'] = this.config.searchApiKey
    }
    const response = await this.fetchSearchBackend(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      cancelResponseBody(response)
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await this.readBoundedSearchBody(response, controller))
    const rawResults = arrayAt(parsed, 'web', 'results')
    if (!rawResults) {
      return { results: [], error: 'search upstream returned an invalid response' }
    }
    return mapSearchResultResponse(rawResults, (result) => ({
      title: result.title,
      url: result.url,
      snippet: result.description ?? result.snippet,
    }))
  }

  // Serper.dev (Google SERP API): POST {apiUrl} { q } with X-API-KEY header ->
  // { organic: [{ title, link, snippet }] }
  private async searchSerper(query: string, controller: AbortController): Promise<WebSearchResult> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (this.config.searchApiKey) {
      headers['X-API-KEY'] = this.config.searchApiKey
    }
    const response = await this.fetchSearchBackend(this.config.searchApiUrl as string, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: query }),
      signal: controller.signal,
    })
    if (!response.ok) {
      cancelResponseBody(response)
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await this.readBoundedSearchBody(response, controller))
    const rawResults = arrayAt(parsed, 'organic')
    if (!rawResults) {
      return { results: [], error: 'search upstream returned an invalid response' }
    }
    return mapSearchResultResponse(rawResults, (result) => ({
      title: result.title,
      url: result.link ?? result.url,
      snippet: result.snippet,
    }))
  }

  /**
   * Search URLs come only from SEARCH_API_URL. They use a separately injected
   * transport because operators commonly run SearXNG on a private service
   * network. The configured origin is the complete trust boundary: requests
   * cannot switch origins, and redirects are rejected before credentials can
   * be forwarded.
   */
  private fetchSearchBackend(
    rawUrl: string,
    init: Parameters<WebFetchLike>[1],
  ): Promise<Awaited<ReturnType<WebFetchLike>>> {
    const configured = new URL(this.config.searchApiUrl as string)
    const requested = new URL(rawUrl)
    if (
      (configured.protocol !== 'http:' && configured.protocol !== 'https:') ||
      requested.origin !== configured.origin
    ) {
      throw new WebValidationError('The search backend URL is not allowed.', 'invalid-search-origin')
    }
    return this.searchFetchFn(requested.toString(), { ...init, redirect: 'error' })
  }

  private readBoundedSearchBody(
    response: Awaited<ReturnType<WebFetchLike>>,
    controller: AbortController,
  ): Promise<string> {
    return this.readBoundedBody(response, controller, {
      maxBytes: this.maxSearchBytes,
      allowTextFallback: false,
      tooLargeMessage: 'The search backend response exceeds the allowed size.',
      tooLargeTag: 'search-response-too-large',
    })
  }

  /**
   * GET `rawUrl`, validating the SSRF guard against the initial URL AND every
   * redirect hop. `fetch` is told NOT to auto-follow (redirect: 'manual'); we
   * follow 3xx ourselves so a redirect to a private/metadata host (the classic
   * SSRF-filter bypass) is rejected instead of silently followed.
   */
  private async fetchFollowingRedirects(
    rawUrl: string,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<WebFetchLike>>> {
    const MAX_REDIRECTS = 5
    let current = await awaitWithAbort(this.assertPublicHttpUrl(rawUrl), signal)

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await awaitWithAbort(
        this.fetchFn(current.toString(), {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          },
          signal,
          redirect: 'manual',
        }),
        signal,
      )

      const isRedirect = response.status >= 300 && response.status < 400
      const location = isRedirect ? response.headers.get('location') : null
      if (!location) {
        return response
      }

      cancelResponseBody(response)

      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new WebValidationError('The redirect target is malformed.', 'invalid-redirect')
      }
      // Re-run the full SSRF guard against the redirect target before following.
      current = await awaitWithAbort(this.assertPublicHttpUrl(next.toString()), signal)
    }

    throw new WebValidationError('Too many redirects.', 'too-many-redirects')
  }

  /**
   * Parse + validate a URL for server-side fetch. Rejects non-http(s) schemes
   * and any host literal or DNS-resolved address that is private / loopback /
   * link-local / unique-local / cloud-metadata. Throws {@link WebValidationError}.
   *
   * Production injects PinnedHttpTransport, so the later socket connection uses
   * a freshly validated address without re-resolving. This local check remains
   * defense in depth and supports deterministic service-level tests.
   */
  private async assertPublicHttpUrl(rawUrl: string): Promise<URL> {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    if (value.length === 0) {
      throw new WebValidationError('A URL is required.', 'missing-url')
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new WebValidationError('The URL is malformed.', 'invalid-url')
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebValidationError('Only http(s) URLs are allowed.', 'invalid-scheme')
    }

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (isBlockedHostname(host)) {
      throw new WebValidationError('The requested host is not allowed.', 'blocked-host')
    }

    // Literal IPs are checked directly; hostnames are resolved and EVERY
    // resolved address must be public (defends against DNS-rebinding to a
    // private address and against names that resolve to metadata IPs).
    if (isIP(host)) {
      if (isBlockedIp(host)) {
        throw new WebValidationError('The requested host is not allowed.', 'blocked-host')
      }
    } else {
      let addresses: string[]
      try {
        addresses = await this.resolveHost(host)
      } catch {
        throw new WebValidationError('The host could not be resolved.', 'unresolvable-host')
      }
      if (addresses.length === 0 || addresses.some((address) => isBlockedIp(address))) {
        throw new WebValidationError('The requested host is not allowed.', 'blocked-host')
      }
    }

    return url
  }
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return Promise.reject(abortError())
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('The request was aborted.')
  error.name = 'AbortError'
  return error
}

function cancelResponseBody(response: Awaited<ReturnType<WebFetchLike>>): void {
  const stream = response.body
  if (!stream) {
    return
  }

  try {
    if (stream.cancel) {
      void Promise.resolve(stream.cancel()).catch(() => undefined)
      return
    }
    const reader = stream.getReader()
    void Promise.resolve(reader.cancel()).catch(() => undefined)
  } catch {
    // Redirect bodies are discarded; cancellation is best-effort.
  }
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

// Keep the gateway's legacy exports while using the one shared SSRF policy.
export const isBlockedHostname = isSharedBlockedHostname
export const isBlockedIp = isSharedBlockedIp

// --- HTML / text helpers (no external dependency) -------------------------

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) {
    return ''
  }
  return decodeEntities(match[1].replace(/\s+/g, ' ').trim()).slice(0, 500)
}

/**
 * Strip scripts/styles/markup and collapse whitespace to produce readable plain
 * text. Intentionally dependency-free: removes non-content elements, drops all
 * tags, decodes a handful of common entities, and normalizes blank lines.
 */
export function htmlToText(html: string): string {
  let text = html
  // Remove whole non-content elements including their contents.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  text = text.replace(/<template[\s\S]*?<\/template>/gi, ' ')
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  // Turn block-level boundaries into newlines so structure survives.
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  // Normalize whitespace: collapse runs of spaces/tabs, cap consecutive blank lines.
  text = text.replace(/[ \t\f\v]+/g, ' ')
  text = text.replace(/ *\n */g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => safeFromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => safeFromCharCode(parseInt(code, 16)))
}

function safeFromCharCode(code: number): string {
  if (Number.isNaN(code) || code < 0 || code > 0x10ffff) {
    return ''
  }
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function appendQuery(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

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

function arrayAt(value: Record<string, unknown> | null, ...path: string[]): unknown[] | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return Array.isArray(current) ? current : undefined
}

/**
 * Search results are untrusted upstream data that will be shown to a model and
 * eventually offered to a user. Accept only absolute, credential-free HTTP(S)
 * links, and bound text fields before they leave the server.
 */
function mapSearchResultResponse(
  rawResults: unknown[],
  map: (result: Record<string, unknown>) => { title: unknown; url: unknown; snippet: unknown },
): WebSearchResult {
  const results: WebSearchResultItem[] = []
  for (const value of rawResults) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const item = map(value as Record<string, unknown>)
    const url = normalizeSearchResultUrl(item.url)
    if (!url) {
      continue
    }
    results.push({
      title: normalizeSearchResultText(item.title, 500),
      url,
      snippet: normalizeSearchResultText(item.snippet, 4_000),
    })
    if (results.length >= MAX_SEARCH_RESULTS) {
      break
    }
  }
  if (rawResults.length > 0 && results.length === 0) {
    return { results: [], error: 'search upstream returned no usable results' }
  }
  return { results }
}

function normalizeSearchResultUrl(value: unknown): string | undefined {
  const raw = asString(value).trim()
  if (!raw || raw.length > 2_048) {
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

function normalizeSearchResultText(value: unknown, maxLength: number): string {
  let sanitized = ''
  for (const character of asString(value)) {
    const code = character.charCodeAt(0)
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function safeParseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
