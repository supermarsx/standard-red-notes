/**
 * Standard Red Notes: SAME-ORIGIN proxy for the plugins (extensions) gallery.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The web client historically fetched the plugins index
 * (`.../cdn/dist/packages.json`) DIRECTLY from raw.githubusercontent.com. The
 * SPA ships a strict Content-Security-Policy (`connect-src 'self' ws: wss:`),
 * so that cross-origin fetch is BLOCKED (`TypeError: NetworkError`) and the
 * browse-plugins gallery never loads. Rather than punch a hole in the CSP, the
 * GATEWAY fetches the repo server-side and returns it to the client from the
 * SAME origin, so `connect-src 'self'` is satisfied with NO CSP change.
 *
 * ---------------------------------------------------------------------------
 * SSRF GUARD (READ THIS)
 * ---------------------------------------------------------------------------
 * This must never become an open relay. Two mitigations, together:
 *   1. The remote base is OPERATOR-configured (PLUGINS_REPO_URL env / the admin
 *      `plugins.repoUrl` overlay), NOT client-supplied. The client can never
 *      name a host.
 *   2. The only client input is a RELATIVE path (the per-file download route).
 *      It is resolved against the configured base and the result MUST stay
 *      within that base (same origin AND path-prefixed by the base directory);
 *      `..` traversal, an absolute URL, or a different host is rejected. The
 *      index route takes no client input at all (it always fetches
 *      `<base>/packages.json`).
 * Outbound calls are additionally bounded by a short timeout and a response
 * size cap so a hostile/broken remote cannot hang or OOM the gateway.
 *
 * The trust model matches WORKFLOWS_N8N_URL: the operator points the base at a
 * host they trust (the Standard Notes CDN by default, or their own mirror), so
 * we do NOT block private/loopback targets — an internal mirror is legitimate.
 */

export type PluginsFetchLike = (
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
  arrayBuffer: () => Promise<ArrayBuffer>
  /**
   * The WHATWG streaming body (undici `Response.body`). Present on the real
   * `globalThis.fetch`; optional so lightweight test doubles can omit it and fall
   * back to `arrayBuffer`. Used to enforce the size cap WITHOUT buffering an
   * unbounded body first (see readCappedBody).
   */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
      releaseLock?(): void
    }
  } | null
}>

export interface PluginsProxyConfig {
  /**
   * Resolves the configured repo BASE url (persisted → env → default) per call.
   * MUST never throw and MUST always return a valid http(s) base (no trailing
   * slash). Wired to ServerSettingsResolver.resolvePluginsRepoUrl.
   */
  baseUrlResolver: () => Promise<string>
  /** Outbound fetch timeout. Default 8 seconds. */
  timeoutMs?: number
  /** Hard ceiling on a proxied response body. Default 16 MiB. */
  maxBytes?: number
}

export interface PluginsProxyResult {
  status: number
  contentType: string
  body: Buffer
}

export type PluginsProxyError =
  | { error: 'invalid-path' }
  | { error: 'outside-base' }
  | { error: 'unreachable' }
  | { error: 'too-large' }
  | { error: 'upstream'; status: number }

const DEFAULT_TIMEOUT_MS = 8 * 1000
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
/**
 * Redirects are NOT auto-followed (SSRF hardening); each 3xx hop is re-validated
 * against the configured base before we fetch it. This bounds a redirect chain
 * that stays within the base so a hostile/broken remote cannot loop us forever.
 */
const MAX_REDIRECTS = 5

/** Sentinel returned by readCappedBody when the streamed body exceeds the cap. */
const TOO_LARGE = Symbol('too-large')

/**
 * Resolve a client-supplied RELATIVE path against the configured base and prove
 * the result stays inside the base directory. Returns the absolute URL string to
 * fetch, or null when the request escapes the base (the SSRF guard). PURE +
 * exported so the guard is unit-testable in isolation.
 *
 * Rules:
 *   - `base` is a normalized http(s) directory URL (no trailing slash).
 *   - `requestedPath` is treated as RELATIVE to `<base>/`. A leading slash is
 *     stripped so it can only ever be relative (never host-absolute). We refuse
 *     an input that itself parses as an absolute URL (contains a scheme) so a
 *     caller cannot smuggle `http://evil/...`.
 *   - The resolved URL must share the base's origin AND its pathname must be
 *     prefixed by the base directory pathname (so `..` cannot climb out).
 */
/**
 * Normalize a configured base to its DIRECTORY URL (trailing slash) so relative
 * resolution and the prefix check both treat it as a folder, not a file. Returns
 * null when the base is not a valid http(s) URL.
 */
function baseDirectory(base: string): URL | null {
  let baseUrl: URL
  try {
    baseUrl = new URL(base)
  } catch {
    return null
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    return null
  }

  return new URL(baseUrl.href.replace(/\/+$/, '') + '/')
}

/**
 * Prove an ABSOLUTE url stays inside the configured base directory: same protocol
 * + host AND its pathname is prefixed by the base directory pathname. Exported +
 * reused both by {@link resolveWithinBase} (client path containment) and by the
 * redirect guard (a `Location` must not escape the base/host). PURE.
 */
export function isWithinBase(base: string, candidate: string): boolean {
  const baseDir = baseDirectory(base)
  if (!baseDir) {
    return false
  }

  let resolved: URL
  try {
    resolved = new URL(candidate)
  } catch {
    return false
  }

  if (resolved.protocol !== baseDir.protocol || resolved.host !== baseDir.host) {
    return false
  }

  return resolved.pathname.startsWith(baseDir.pathname)
}

export function resolveWithinBase(base: string, requestedPath: string): string | null {
  if (typeof requestedPath !== 'string') {
    return null
  }
  // Reject anything that looks like an absolute URL / scheme-relative host.
  const trimmed = requestedPath.trim()
  if (trimmed.length === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }
  // Reject percent-encoded dot/slash: the WHATWG URL parser does NOT decode `%2f`
  // / `%2e`, so `..%2f` would slip past the normalization + prefix check below and
  // could climb out of the base once the upstream server decodes it. Legitimate
  // component paths are plain (segments are encodeURIComponent'd client-side, which
  // never emits `%2e`/`%2f`), so this rejects only traversal attempts.
  if (/%2e/i.test(trimmed) || /%2f/i.test(trimmed)) {
    return null
  }

  const baseDir = baseDirectory(base)
  if (!baseDir) {
    return null
  }

  let resolved: URL
  try {
    resolved = new URL(trimmed.replace(/^\/+/, ''), baseDir)
  } catch {
    return null
  }

  // `..` in the input normalizes before this check, so a climb above the base
  // directory fails the host/prefix containment in isWithinBase.
  if (!isWithinBase(base, resolved.href)) {
    return null
  }

  return resolved.href
}

export class PluginsProxyService {
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(
    private fetchFn: PluginsFetchLike,
    private config: PluginsProxyConfig,
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Fetch the plugins INDEX (`<base>/packages.json`) server-side. Takes NO client
   * input — the URL is derived entirely from the operator-configured base, so
   * there is no SSRF surface here at all.
   */
  async fetchIndex(): Promise<PluginsProxyResult | PluginsProxyError> {
    const base = await this.config.baseUrlResolver()
    const url = `${base.replace(/\/+$/, '')}/packages.json`

    return this.fetchUrl(base, url)
  }

  /**
   * Fetch a single plugin package FILE under the configured base. The relative
   * path is resolved + SSRF-guarded by {@link resolveWithinBase}; a request that
   * escapes the base is rejected (never fetched).
   */
  async fetchFile(requestedPath: string): Promise<PluginsProxyResult | PluginsProxyError> {
    const base = await this.config.baseUrlResolver()
    const url = resolveWithinBase(base, requestedPath)
    if (!url) {
      return { error: 'outside-base' }
    }

    return this.fetchUrl(base, url)
  }

  private async fetchUrl(base: string, url: string): Promise<PluginsProxyResult | PluginsProxyError> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      let currentUrl = url
      for (let hop = 0; ; hop++) {
        const response = await this.fetchFn(currentUrl, {
          method: 'GET',
          headers: {
            Accept: '*/*',
            'User-Agent': 'standard-red-notes-plugins-proxy',
          },
          signal: controller.signal,
          // SSRF hardening: do NOT auto-follow. A redirect could send us to an
          // arbitrary host (or an internal address). We validate every hop against
          // the configured base below before fetching it.
          redirect: 'manual',
        })

        // A 3xx must stay within the operator-configured base/host or it is
        // rejected (never fetched). Resolve a relative Location against the current
        // URL, then re-run the containment guard.
        if (response.status >= 300 && response.status < 400) {
          if (hop >= MAX_REDIRECTS) {
            return { error: 'unreachable' }
          }
          const location = response.headers.get('location')
          if (!location) {
            return { error: 'upstream', status: response.status }
          }
          let next: string
          try {
            next = new URL(location, currentUrl).href
          } catch {
            return { error: 'outside-base' }
          }
          if (!isWithinBase(base, next)) {
            return { error: 'outside-base' }
          }
          currentUrl = next
          continue
        }

        if (!response.ok) {
          return { error: 'upstream', status: response.status }
        }

        // DoS guard, step 1: reject on a declared Content-Length over the cap
        // WITHOUT reading a single body byte.
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
          return { error: 'too-large' }
        }

        // DoS guard, step 2: stream the body with a running byte counter that
        // aborts the moment the cap is exceeded — never buffer an unbounded body.
        const body = await this.readCappedBody(response, controller)
        if (body === TOO_LARGE) {
          return { error: 'too-large' }
        }

        return {
          status: 200,
          contentType: response.headers.get('content-type') || 'application/octet-stream',
          body,
        }
      }
    } catch {
      return { error: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read the response body enforcing {@link maxBytes} WITHOUT first buffering an
   * unbounded body. Streams via the WHATWG reader, counting bytes as they arrive
   * and aborting (abort the request + cancel the stream) the instant the cap is
   * exceeded. Falls back to `arrayBuffer` (post-check) only when the fetch double
   * exposes no stream body.
   */
  private async readCappedBody(
    response: { arrayBuffer: () => Promise<ArrayBuffer>; body?: PluginsResponseBody | null },
    controller: AbortController,
  ): Promise<Buffer | typeof TOO_LARGE> {
    const stream = response.body
    if (!stream || typeof stream.getReader !== 'function') {
      const buffer = Buffer.from(await response.arrayBuffer())

      return buffer.length > this.maxBytes ? TOO_LARGE : buffer
    }

    const reader = stream.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        if (value && value.length > 0) {
          total += value.length
          if (total > this.maxBytes) {
            controller.abort()
            try {
              await reader.cancel()
            } catch {
              // best-effort teardown; the abort already stops the transfer.
            }

            return TOO_LARGE
          }
          chunks.push(Buffer.from(value))
        }
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // ignore — the stream is already fully consumed or cancelled.
      }
    }

    return Buffer.concat(chunks, total)
  }
}

type PluginsResponseBody = NonNullable<Awaited<ReturnType<PluginsFetchLike>>['body']>
