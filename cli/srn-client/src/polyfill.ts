// snjs and @standardnotes/sncrypto-web are built for the browser and reference a
// few browser globals at module-load time (`self`, occasionally `window`). Import
// this module FIRST (before any @standardnotes/* import) so those globals exist
// when their bundles evaluate. Node already provides global `crypto` (WebCrypto),
// `fetch`, and `WebSocket`, so only `self`/`window` need shimming for headless use.
//
// On top of the browser shims this installs a fetch wrapper that:
//   1. Persists cookies per-origin (the SN server uses HttpOnly cookie sessions,
//      which Node's fetch does NOT persist on its own).
//   2. Attaches the optional `X-Shared-Server-Key` header (the self-hosted
//      "obfuscation gate") to requests so a CLI can pass a gated instance.

const g = globalThis as unknown as Record<string, unknown>

// snjs occasionally schedules a session-refresh timer with an already-past
// expiry, which Node surfaces as a noisy "TimeoutNegativeWarning". It is benign
// (the timer just fires immediately), so suppress only that one warning to keep
// CLI output clean. Replace Node's default warning printer with a filtered one
// so all OTHER warnings remain visible on stderr.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name !== 'TimeoutNegativeWarning') {
    process.stderr.write(`${warning.name}: ${warning.message}\n`)
  }
})

if (g.self === undefined) {
  g.self = globalThis
}
if (g.window === undefined) {
  g.window = globalThis
}
if (g.document === undefined) {
  g.document = {}
}
if (g.navigator === undefined) {
  g.navigator = { userAgent: 'node' }
}

// The shared-server-key value is set at runtime (after we read config). A single
// module-scoped holder keyed by origin lets the fetch wrapper attach the header
// only to the configured server origin — never leaking it to other hosts.
const sharedKeyByOrigin = new Map<string, string>()

/**
 * Register the X-Shared-Server-Key to send to a given server URL's origin. Call
 * before any snjs sign-in/sync so gated requests carry the header. A no-op when
 * `key` is empty.
 */
export function configureSharedServerKey(serverUrl: string, key: string | undefined): void {
  if (!key) {
    return
  }
  try {
    sharedKeyByOrigin.set(new URL(serverUrl).origin, key)
  } catch {
    // Invalid URL: nothing to scope the key to; skip silently.
  }
}

// Cookies are scoped PER ORIGIN (scheme://host:port) so a host's session cookies
// never replay to a different host (redirect, proxy, second account).
const jarByOrigin = new Map<string, Map<string, string>>()

// The SN server uses cookie-based sessions (HttpOnly access/refresh cookies). A
// one-shot CLI invocation must therefore persist the cookie jar to disk between
// commands, or every command after `login` would 401. configureCookieJar points
// the jar at a per-profile file and loads any previously-saved cookies.
let cookieJarPath: string | undefined

/** Load the persisted cookie jar from disk and route future writes back to it. */
export function configureCookieJar(filePath: string): void {
  cookieJarPath = filePath
  try {
    // Synchronous read on purpose: this runs once at startup before any fetch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>
    for (const [origin, cookies] of Object.entries(parsed)) {
      jarByOrigin.set(origin, new Map(Object.entries(cookies)))
    }
  } catch {
    // No saved jar yet (first run) or unreadable: start empty.
  }
}

function persistCookieJar(): void {
  if (!cookieJarPath) {
    return
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    const obj: Record<string, Record<string, string>> = {}
    for (const [origin, store] of jarByOrigin) {
      obj[origin] = Object.fromEntries(store)
    }
    fs.writeFileSync(cookieJarPath, JSON.stringify(obj), { mode: 0o600 })
  } catch {
    // Best-effort; a failed persist just means the next command re-auths.
  }
}

if (!g.__srnCliFetchInstalled) {
  g.__srnCliFetchInstalled = true

  const originalFetch = globalThis.fetch.bind(globalThis)

  type FetchInput = Parameters<typeof fetch>[0]
  const originOf = (input: FetchInput): string | undefined => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return new URL(url).origin
    } catch {
      return undefined
    }
  }

  globalThis.fetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const origin = originOf(input)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

    // Attach the shared-server-key gate header for the configured origin.
    if (origin) {
      const sharedKey = sharedKeyByOrigin.get(origin)
      if (sharedKey && !headers.has('x-shared-server-key')) {
        headers.set('X-Shared-Server-Key', sharedKey)
      }
    }

    // Replay stored cookies for this origin.
    const jar = origin ? jarByOrigin.get(origin) : undefined
    if (jar && jar.size > 0 && !headers.has('cookie')) {
      headers.set(
        'cookie',
        Array.from(jar.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      )
    }

    const response = await originalFetch(input, { ...init, headers })

    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    if (origin && setCookies.length > 0) {
      let store = jarByOrigin.get(origin)
      if (!store) {
        store = new Map<string, string>()
        jarByOrigin.set(origin, store)
      }
      for (const cookie of setCookies) {
        const parts = cookie.split(';')
        const pair = parts[0]
        const eq = pair.indexOf('=')
        if (eq <= 0) {
          continue
        }
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        // Honor cookie DELETION (logout / rotation) so a cleared session cookie
        // is not replayed forever.
        let isDeletion = value === ''
        for (const attr of parts.slice(1)) {
          const a = attr.trim().toLowerCase()
          if (a.startsWith('max-age=')) {
            const n = Number(a.slice('max-age='.length))
            if (!Number.isNaN(n) && n <= 0) {
              isDeletion = true
            }
          } else if (a.startsWith('expires=')) {
            const exp = Date.parse(a.slice('expires='.length))
            if (!Number.isNaN(exp) && exp <= Date.now()) {
              isDeletion = true
            }
          }
        }
        if (isDeletion) {
          store.delete(name)
        } else {
          store.set(name, value)
        }
      }
      // Persist after every session-cookie update so the next CLI invocation
      // restores the authenticated session.
      persistCookieJar()
    }
    return response
  }
}
