// snjs and @standardnotes/sncrypto-web are built for the browser and reference
// a few browser globals at module-load time (`self`, occasionally `window`).
// Import this module FIRST (before any @standardnotes/* import) so those
// globals exist when their bundles evaluate. Node 22 already provides global
// `crypto` (WebCrypto), `fetch`, and `WebSocket`, so only `self`/`window` need
// shimming for headless use.

const g = globalThis as unknown as Record<string, unknown>

if (g.self === undefined) {
  g.self = globalThis
}
if (g.window === undefined) {
  g.window = globalThis
}
// snjs probes `document.documentMode` and `navigator.userAgent` when detecting
// WebCrypto support. A minimal stub is enough; we never touch the DOM.
if (g.document === undefined) {
  g.document = {}
}
if (g.navigator === undefined) {
  g.navigator = { userAgent: 'node' }
}

// Cookie jar around fetch. The Standard Notes server uses COOKIE-BASED sessions
// (HttpOnly access/refresh cookies set on sign-in). A browser persists these
// automatically; Node's fetch does not, so authenticated requests (e.g. sync to
// /v1/items) would fail with "No cookies provided for cookie-based session
// token." We capture Set-Cookie and replay Cookie on subsequent requests so the
// headless bridge authenticates exactly like a browser.
if (!g.__srnCookieJarInstalled) {
  g.__srnCookieJarInstalled = true
  const jar = new Map<string, string>()
  const originalFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set(
        'cookie',
        Array.from(jar.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      )
    }
    const response = await originalFetch(input, { ...init, headers })
    const setCookies =
      (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const cookie of setCookies) {
      const pair = cookie.split(';', 1)[0]
      const eq = pair.indexOf('=')
      if (eq > 0) {
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
    }
    return response
  }
}

export {}
