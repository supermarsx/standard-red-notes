import type { Request } from 'express'

/**
 * Everything a direct-call caller may state about the request it is standing in
 * for. Each field has a correct default, so a caller supplies only what its lane
 * genuinely knows; nothing here is optional in the OBJECT that comes out.
 */
export interface DirectCallRequestInit {
  /** An existing request to start from. Read field-by-field, never spread. */
  from?: Request
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  params?: Record<string, string>
  query?: Record<string, unknown>
  body?: unknown
  ip?: string
}

/**
 * The Express `Request` a controller (or a service proxy) is handed when a
 * caller enters it DIRECTLY -- no HTTP server, no socket, no middleware. The
 * REQUEST-side twin of `createDirectCallResponse`, and it exists for the same
 * reason: `{ headers: { ... } } as unknown as Request` type-checks, so every
 * gate in the tree is blind to the fields it does not carry.
 *
 * WHAT THE BARE LITERAL ALREADY COST, before anyone read `request.method` in a
 * controller. `SyncWebSocketCommandAdapter.httpContext` fabricated
 * `{ headers: { 'x-snjs-version': api } }`, and the COLLABORATION_AUTHORIZE
 * lane hands that object to `ServiceProxy.callSyncingServer`. On a
 * multi-container deployment that is `HttpServiceProxy.getServerResponse`,
 * which reads
 *
 *   headers['x-origin-url']    = request.url      // undefined
 *   headers['x-origin-method'] = request.method   // undefined
 *   ...
 *   this.httpClient.request({ method: request.method as Method, ... })
 *
 * An axios config with `method: undefined` is dispatched as **GET**, so the
 * `POST items/collaboration-authorization` call left the gateway as a GET, the
 * syncing server had no such route, and `checkAccessWithSyncingServer` read the
 * non-2xx as `{ authorized: false }` -- every socket collaboration
 * authorization denied, with no error anywhere, on every deployment whose
 * service proxy is not the in-process one. (The gRPC proxy funnels this payload
 * to the same `callServer`; only `DirectCallServiceProxy` ignores the two
 * fields, which is why the single container never showed it.)
 *
 * This is the identical shape as the `DirectCallResponse.setHeader` incident:
 * one missing member of a cast object, 100 % of one lane failing, every build
 * green. So the fix is the same shape too -- a real object with every member a
 * caller downstream might read, in a LEAF module with no runtime import, so a
 * caller outside this package can reach it without dragging the
 * inversify-decorated Bootstrap graph behind it.
 *
 * TWO PROPERTIES OF THIS OBJECT ARE LOAD-BEARING, and a "tidier" rewrite breaks
 * them silently:
 *
 *  1. `get`/`header`/`is` are OWN ENUMERABLE properties, not prototype methods.
 *     `DirectCallSyncCommandPort` used to re-shape its request with
 *     `{ ...request, body, headers }`, and an object spread copies own
 *     enumerable properties only -- a prototype-based fake would have arrived
 *     at the controller with its methods stripped off. (That port now rebuilds
 *     through this factory instead, but the next caller to spread one of these
 *     must still get a working object.)
 *  2. `headers` keys are LOWERCASED. Node lowercases incoming header names, and
 *     every reader in this tree indexes with a lowercase literal
 *     (`request.headers['x-snjs-version']`), so a caller that passes
 *     `X-Snjs-Version` must not produce a header nobody can find.
 */
export function createDirectCallRequest(init: DirectCallRequestInit = {}): Request {
  const from = init.from
  const headers = lowercaseHeaders({ ...(from?.headers ?? {}), ...(init.headers ?? {}) })
  const method = (init.method ?? from?.method ?? 'POST').toUpperCase()
  const url = init.url ?? from?.url ?? '/'
  const path = url.split('?')[0] ?? '/'
  const ip = init.ip ?? from?.ip ?? ''
  const request: Record<string, unknown> = {
    method,
    url,
    originalUrl: from?.originalUrl ?? url,
    baseUrl: from?.baseUrl ?? '',
    path,
    protocol: from?.protocol ?? 'http',
    secure: from?.secure ?? false,
    hostname: from?.hostname ?? 'localhost',
    ip,
    ips: ip === '' ? [] : [ip],
    headers,
    params: init.params ?? from?.params ?? {},
    query: init.query ?? from?.query ?? {},
    body: init.body !== undefined ? init.body : (from?.body ?? {}),
    cookies: from?.cookies ?? {},
    signedCookies: from?.signedCookies ?? {},
    // `resolveClientIpFromRequest` falls back to `socket.remoteAddress` when a
    // request carries no `ip`, with optional chaining -- so an absent socket is
    // merely an empty address. It is present anyway: the next reader to want a
    // peer address should find one field, not two spellings of none.
    socket: { remoteAddress: ip === '' ? undefined : ip },
  }
  const readHeader = (name: string): string | string[] | undefined => {
    const key = String(name).toLowerCase()
    // Express's own `get` aliases these two, and a caller that asks for the
    // alias must not be told the header is unset.
    if (key === 'referer' || key === 'referrer') {
      return headers.referer ?? headers.referrer
    }
    return headers[key]
  }
  request.get = readHeader
  request.header = readHeader
  request.is = (type: string): string | false | null => {
    const contentType = headers['content-type']
    const value = Array.isArray(contentType) ? contentType[0] : contentType
    if (value === undefined || value.length === 0) {
      return null
    }
    return value.toLowerCase().includes(String(type).toLowerCase()) ? type : false
  }
  return request as unknown as Request
}

/**
 * Header names as Node would have delivered them. An `undefined` VALUE is kept:
 * `HttpServiceProxy` iterates `Object.keys(request.headers)` and a caller that
 * states "this header is unset" must not have the key invented for it either.
 */
function lowercaseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const lowercased: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    lowercased[name.toLowerCase()] = value
  }
  return lowercased
}
