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

export type WebFetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    signal?: AbortSignal
    redirect?: 'follow' | 'manual' | 'error'
  },
) => Promise<{
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
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
  // Max bytes to read from a fetched page before truncating (protects memory).
  maxFetchBytes?: number
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
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000
const USER_AGENT = 'standard-red-notes-web-proxy'

export class WebService {
  private readonly maxContentChars: number
  private readonly maxFetchBytes: number
  private readonly fetchTimeoutMs: number
  private readonly searchTimeoutMs: number

  constructor(
    private readonly fetchFn: WebFetchLike,
    private readonly config: WebServiceConfig = {},
    // DNS resolver injectable for tests; defaults to the real resolver.
    private readonly resolveHost: (host: string) => Promise<string[]> = defaultResolveHost,
  ) {
    this.maxContentChars = config.maxContentChars && config.maxContentChars > 0 ? config.maxContentChars : DEFAULT_MAX_CONTENT_CHARS
    this.maxFetchBytes = config.maxFetchBytes && config.maxFetchBytes > 0 ? config.maxFetchBytes : DEFAULT_MAX_FETCH_BYTES
    this.fetchTimeoutMs = config.fetchTimeoutMs && config.fetchTimeoutMs > 0 ? config.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
    this.searchTimeoutMs = config.searchTimeoutMs && config.searchTimeoutMs > 0 ? config.searchTimeoutMs : DEFAULT_SEARCH_TIMEOUT_MS
  }

  /**
   * Fetch a URL server-side and return the readable plain text. Throws
   * {@link WebValidationError} (safe message) for bad/blocked URLs.
   */
  async fetch(rawUrl: string): Promise<WebFetchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
    let response
    try {
      response = await this.fetchFollowingRedirects(rawUrl, controller.signal)
    } catch (error) {
      // Preserve validation errors (blocked host / bad redirect) verbatim.
      if (error instanceof WebValidationError) {
        throw error
      }
      const message = (error as Error).name === 'AbortError' ? 'The request timed out.' : 'Failed to fetch the URL.'
      throw new WebValidationError(message, 'fetch-failed')
    } finally {
      clearTimeout(timer)
    }

    const contentType = response.headers.get('content-type') || ''
    const rawBody = await response.text()
    const body = rawBody.length > this.maxFetchBytes ? rawBody.slice(0, this.maxFetchBytes) : rawBody

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
          return await this.searchSearxng(trimmed, controller.signal)
        case 'brave':
          return await this.searchBrave(trimmed, controller.signal)
        case 'serper':
          return await this.searchSerper(trimmed, controller.signal)
        default:
          return { results: [], error: `unsupported search provider '${provider}'` }
      }
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? 'web search timed out' : 'web search failed'
      return { results: [], error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  // SearXNG JSON endpoint: GET {apiUrl}?q=...&format=json -> { results: [{ title, url, content }] }
  private async searchSearxng(query: string, signal: AbortSignal): Promise<WebSearchResult> {
    const url = appendQuery(this.config.searchApiUrl as string, { q: query, format: 'json' })
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (this.config.searchApiKey) {
      headers['Authorization'] = `Bearer ${this.config.searchApiKey}`
    }
    const response = await this.fetchFn(url, { method: 'GET', headers, signal })
    if (!response.ok) {
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await response.text())
    const rawResults = (parsed?.results as unknown[]) || []
    const results = rawResults
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({
        title: asString(r.title),
        url: asString(r.url),
        snippet: asString(r.content ?? r.snippet),
      }))
      .filter((r) => r.url.length > 0)
    return { results }
  }

  // Brave Search API: GET {apiUrl}?q=... with X-Subscription-Token header ->
  // { web: { results: [{ title, url, description }] } }
  private async searchBrave(query: string, signal: AbortSignal): Promise<WebSearchResult> {
    const url = appendQuery(this.config.searchApiUrl as string, { q: query })
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (this.config.searchApiKey) {
      headers['X-Subscription-Token'] = this.config.searchApiKey
    }
    const response = await this.fetchFn(url, { method: 'GET', headers, signal })
    if (!response.ok) {
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await response.text())
    const web = (parsed?.web as Record<string, unknown>) || {}
    const rawResults = (web.results as unknown[]) || []
    const results = rawResults
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({
        title: asString(r.title),
        url: asString(r.url),
        snippet: asString(r.description ?? r.snippet),
      }))
      .filter((r) => r.url.length > 0)
    return { results }
  }

  // Serper.dev (Google SERP API): POST {apiUrl} { q } with X-API-KEY header ->
  // { organic: [{ title, link, snippet }] }
  private async searchSerper(query: string, signal: AbortSignal): Promise<WebSearchResult> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (this.config.searchApiKey) {
      headers['X-API-KEY'] = this.config.searchApiKey
    }
    const response = await this.fetchFn(this.config.searchApiUrl as string, {
      method: 'POST',
      headers,
      signal,
      // body unsupported by the minimal shape's typing; cast through unknown.
      ...({ body: JSON.stringify({ q: query }) } as unknown as object),
    })
    if (!response.ok) {
      return { results: [], error: `search upstream error (status ${response.status})` }
    }
    const parsed = safeParseJson(await response.text())
    const rawResults = (parsed?.organic as unknown[]) || []
    const results = rawResults
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({
        title: asString(r.title),
        url: asString(r.link ?? r.url),
        snippet: asString(r.snippet),
      }))
      .filter((r) => r.url.length > 0)
    return { results }
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
    let current = await this.assertPublicHttpUrl(rawUrl)

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.fetchFn(current.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        },
        signal,
        redirect: 'manual',
      })

      const isRedirect = response.status >= 300 && response.status < 400
      const location = isRedirect ? response.headers.get('location') : null
      if (!location) {
        return response
      }

      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new WebValidationError('The redirect target is malformed.', 'invalid-redirect')
      }
      // Re-run the full SSRF guard against the redirect target before following.
      current = await this.assertPublicHttpUrl(next.toString())
    }

    throw new WebValidationError('Too many redirects.', 'too-many-redirects')
  }

  /**
   * Parse + validate a URL for server-side fetch. Rejects non-http(s) schemes
   * and any host literal or DNS-resolved address that is private / loopback /
   * link-local / unique-local / cloud-metadata. Throws {@link WebValidationError}.
   *
   * Residual: a DNS-rebinding TOCTOU window remains between this resolution and
   * the socket connect (the OS re-resolves). Operators should also restrict
   * egress at the network layer; connection-time IP pinning is a future hardening.
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

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

// Hostname-level blocks (before/independent of IP resolution).
export function isBlockedHostname(host: string): boolean {
  if (host.length === 0) {
    return true
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }
  // RFC 6761 / common internal TLDs and cloud metadata names.
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata' || host.endsWith('.metadata')) {
    return true
  }
  return false
}

/**
 * Returns true if an IP literal is private, loopback, link-local (incl. the
 * 169.254.169.254 cloud metadata address), unique-local, or otherwise not a
 * routable public address.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    return isBlockedIpv4(ip)
  }
  if (family === 6) {
    return isBlockedIpv6(ip)
  }
  // Not a parseable IP -> treat as blocked (fail closed).
  return true
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  // "this" network 0.0.0.0/8
  if (a === 0) {
    return true
  }
  // private 10.0.0.0/8
  if (a === 10) {
    return true
  }
  // loopback 127.0.0.0/8
  if (a === 127) {
    return true
  }
  // link-local 169.254.0.0/16 (includes the 169.254.169.254 cloud metadata IP)
  if (a === 169 && b === 254) {
    return true
  }
  // private 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  // private 192.168.0.0/16
  if (a === 192 && b === 168) {
    return true
  }
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) {
    return true
  }
  // multicast + reserved 224.0.0.0/3
  if (a >= 224) {
    return true
  }
  return false
}

const hextetsToIpv4 = (high: number, low: number): string =>
  `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // loopback ::1 / unspecified ::
  if (lower === '::1' || lower === '::') {
    return true
  }
  // IPv4-mapped (::ffff:…) and NAT64 (64:ff9b::…) embed an IPv4 address that can
  // point at a private/loopback host — extract and validate it. Both the dotted
  // (a.b.c.d) and the non-dotted hextet (HHHH:HHHH) encodings are handled.
  const dotted = lower.match(/(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    return isBlockedIpv4(dotted[1])
  }
  const hex = lower.match(/(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    return isBlockedIpv4(hextetsToIpv4(parseInt(hex[1], 16), parseInt(hex[2], 16)))
  }
  // Any other address in the NAT64 well-known prefix — fail closed.
  if (lower.startsWith('64:ff9b:')) {
    return true
  }
  // link-local fe80::/10
  if (lower.startsWith('fe80')) {
    return true
  }
  // unique-local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  }
  // multicast ff00::/8
  if (lower.startsWith('ff')) {
    return true
  }
  return false
}

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

function safeParseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
