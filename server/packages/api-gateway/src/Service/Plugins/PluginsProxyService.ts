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
export function resolveWithinBase(base: string, requestedPath: string): string | null {
  if (typeof requestedPath !== 'string') {
    return null
  }
  // Reject anything that looks like an absolute URL / scheme-relative host.
  const trimmed = requestedPath.trim()
  if (trimmed.length === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }

  let baseUrl: URL
  try {
    baseUrl = new URL(base)
  } catch {
    return null
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    return null
  }

  // The base as a DIRECTORY (trailing slash) so relative resolution and the
  // prefix check both treat it as a folder, not a file.
  const baseDir = new URL(baseUrl.href.replace(/\/+$/, '') + '/')

  let resolved: URL
  try {
    resolved = new URL(trimmed.replace(/^\/+/, ''), baseDir)
  } catch {
    return null
  }

  if (resolved.protocol !== baseDir.protocol || resolved.host !== baseDir.host) {
    return null
  }
  // Path-prefix containment: `..` in the input normalizes before this check, so
  // a climb above the base directory fails here.
  if (!resolved.pathname.startsWith(baseDir.pathname)) {
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

    return this.fetchUrl(url)
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

    return this.fetchUrl(url)
  }

  private async fetchUrl(url: string): Promise<PluginsProxyResult | PluginsProxyError> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'User-Agent': 'standard-red-notes-plugins-proxy',
        },
        signal: controller.signal,
        redirect: 'follow',
      })

      if (!response.ok) {
        return { error: 'upstream', status: response.status }
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > this.maxBytes) {
        return { error: 'too-large' }
      }

      return {
        status: 200,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        body: buffer,
      }
    } catch {
      return { error: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }
}
