import * as http from 'http'
import { isLoopbackReadinessCaller } from '@standardnotes/api-gateway'
import type { Request } from 'express'

/**
 * Standard Red Notes: auth's INTERNAL health routes — `/healthcheck/diagnostics`
 * and `/healthcheck/readiness` — served on the ONE topology where auth has no
 * HTTP port of its own.
 *
 * *** THE PROBLEM ***
 * `AdminController` reaches both over HTTP at `${SERVICE_PROBE_URLS.auth}/...`,
 * and that map defaults to the supervisord sibling port (`AUTH_SERVER_PORT`,
 * 3103). On the single container there is one process on one port and nothing at
 * all listens on 3103, so neither probe got an answer:
 *
 *   - `probeAuthRuntime` lost THREE whole blocks of the admin Diagnostics pane —
 *     the auth half of `runtime`, the entire `datastore` block and the
 *     dead-outbox census;
 *   - `probeAuthReadiness` lost `health.auth` and the whole `auth` entry of the
 *     `services` array, so the pane reported auth as `down` / `unreachable` with
 *     no `probeDepth` while auth was running in the very same process, and the
 *     "Auth readiness round trip" and "Auth database round trip" rows had
 *     nothing to print.
 *
 * *** WHY NOT MOUNT AUTH'S ANNOTATED CONTROLLER ***
 * Because auth's annotated controllers declare UNPREFIXED bases — `/auth`,
 * `/sessions`, `/users`, `/internal` (auth's cross-service-token API) — on the
 * assumption that a gateway sits in front of them. On this topology every
 * bundled service shares one Express app on one port, and the front-door nginx
 * proxies `^/(v1|v2|auth|subscription|healthcheck)(/|$)` straight to it, so
 * mounting them would publish auth's internal surface to the public internet
 * and bypass the gateway's middleware. Their absence from the home-server graph
 * (auth's package barrel exports no annotated controller) is deliberate.
 *
 * Nor is pointing the probe at this app's own `:3000` an option, however gated
 * the route: `serviceProbeUrls.auth` feeds BOTH auth probes, so the gateway's
 * own aggregate readiness would then be displayed as auth's `{db, redis}`
 * verdict — a reading that is not auth's at all, and one that is "ready"
 * whenever the deployment as a whole is.
 *
 * *** THE EXPOSURE BOUNDARY ***
 * On multi-container both routes answer on auth's internal port and 404 at the
 * public front door, and that property is load-bearing. This listener keeps it
 * EXACTLY, in two independent ways:
 *
 *   1. Neither route is registered on the public :3000 app at all, so the front
 *      door 404s by ROUTE ABSENCE — the strongest form, and one no middleware
 *      ordering mistake can undo.
 *   2. This socket is bound to loopback only, and a request is additionally
 *      refused unless its TCP PEER is loopback and it carries no
 *      `x-forwarded-for`. Both halves come from the gateway's own, already
 *      tested `isLoopbackReadinessCaller`, which exists for this exact
 *      question: the decision is made on the peer address, never on
 *      `request.ip`, because `TRUST_PROXY` makes `request.ip` answerable to a
 *      caller-supplied `X-Forwarded-For`. NOTHING a caller can send grants
 *      access — a request that presents a forwarding header is refused, not
 *      admitted, so the header can only ever cost a caller access.
 *
 * A refusal is byte-identical to the no-such-route answer, so a caller cannot
 * learn from the response that either route exists at all.
 */

/** The diagnostics path the gateway's runtime probe asks for. */
export const INTERNAL_DIAGNOSTICS_PATH = '/healthcheck/diagnostics'

/**
 * The readiness path the gateway's auth readiness probe asks for. Note that the
 * gateway accepts only a 200 or a 503 here and reads `{ status, checks }` out of
 * either, which is why a served route must answer in that vocabulary even when
 * it fails — see `InternalRoute.onFailure`.
 */
export const INTERNAL_READINESS_PATH = '/healthcheck/readiness'

/**
 * The port the gateway's probe map defaults to for auth. Mirrors
 * `probePort('AUTH_SERVER_PORT', 3103)` in the api-gateway container and the
 * single-container entrypoint's `AUTH_SERVER_PORT=3103`, so the listener and
 * the probe cannot drift apart.
 */
export const DEFAULT_AUTH_PROBE_PORT = 3103

/** The loopback interface. Never an operator-supplied bind address: see above. */
export const INTERNAL_DIAGNOSTICS_BIND_ADDRESS = '127.0.0.1'

/** The answer a refused or unmatched request gets, matching the app's error shape. */
const NOT_FOUND_BODY = JSON.stringify({ error: { message: 'Not Found' } })

/**
 * Resolve the listener port from `AUTH_SERVER_PORT`.
 *
 * A value that is not a whole port number falls back to the default rather than
 * producing a `listen(NaN)` (which binds a RANDOM port — a listener the probe
 * could never find, reported as a success). The same function derives the probe
 * URL in `buildHomeServerEnvironmentOverrides`, so the two always agree.
 */
export function parseInternalDiagnosticsPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_AUTH_PROBE_PORT
  }

  const parsed = Number(value.trim())
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return DEFAULT_AUTH_PROBE_PORT
  }

  return parsed
}

/** The path of a request URL, with any query string and trailing slash removed. */
export function readRequestPath(url: string | undefined): string {
  const path = (url ?? '').split('?')[0].split('#')[0]
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }

  return path
}

/** A status code and a JSON body: everything a served route decides. */
export type InternalRouteAnswer = {
  status: number
  body: unknown
}

/** One served route. */
export type InternalRoute = {
  /** Produce the answer. */
  answer: () => Promise<InternalRouteAnswer>
  /**
   * The answer to serve when `answer()` rejects.
   *
   * IT BELONGS TO THE ROUTE, NOT TO THIS LISTENER, because a fallback in the
   * wrong vocabulary is read as a verdict rather than as a failure. Concretely:
   * the gateway's auth readiness probe accepts a 503 and then reads `status` and
   * `checks` out of the body, and a body carrying neither — a generic
   * `{ error: { message } }`, say — leaves it with `status: undefined` and
   * `checks: {}`, which `authServiceEntry` scores as `'ok'`. A generic failure
   * answer here would therefore publish a crashed readiness probe as a HEALTHY
   * auth service. Each route states its own, in its own vocabulary.
   *
   * It is a value rather than a second thunk on purpose: whatever it is, it must
   * be producible without running any of the code that just failed.
   */
  onFailure: InternalRouteAnswer
}

/**
 * The served routes, keyed by EXACT path.
 *
 * A `Map` rather than an object literal because the key is caller-supplied: an
 * object lookup for `__proto__`, `constructor` or `toString` returns an
 * inherited member, and `routes['constructor']` would hand this handler
 * `Object` — a callable whose result has neither a status nor a body. A `Map`
 * has no inherited keys, so an unmatched path is unmatched whatever it spells.
 */
export type InternalRouteTable = ReadonlyMap<string, InternalRoute>

export type InternalDiagnosticsRequest = Pick<http.IncomingMessage, 'method' | 'url' | 'headers' | 'socket'>

export type InternalDiagnosticsResponse = {
  writeHead(statusCode: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

export type InternalDiagnosticsLogger = {
  info(message: string, metadata?: Record<string, unknown>): void
  warn(message: string, metadata?: Record<string, unknown>): void
}

/**
 * Serve one request.
 *
 * Exported separately from the server so the gate and the routing are testable
 * without opening a socket. Never throws: a route whose answer rejects serves
 * that route's own `onFailure`, because an admin probe must not be able to take
 * this listener down and a stack trace must never reach a response.
 */
export async function handleInternalDiagnosticsRequest(
  request: InternalDiagnosticsRequest,
  response: InternalDiagnosticsResponse,
  routes: InternalRouteTable,
): Promise<void> {
  const notFound = (): void => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(NOT_FOUND_BODY)
  }

  const route = request.method === 'GET' ? routes.get(readRequestPath(request.url)) : undefined
  if (route === undefined) {
    notFound()

    return
  }

  // The gate. Identical answer to an unmatched path, so a refused caller cannot
  // tell a served route apart from one that does not exist.
  if (!isLoopbackReadinessCaller(request as unknown as Pick<Request, 'socket' | 'headers'>)) {
    notFound()

    return
  }

  let answer: InternalRouteAnswer
  try {
    answer = await route.answer()
  } catch {
    // Deliberately blind: a probe rejection is exactly where a driver puts a
    // host, a port and a database name, so nothing from it is read or echoed.
    answer = route.onFailure
  }

  response.writeHead(answer.status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(answer.body))
}

export type InternalDiagnosticsListenerOptions = {
  port: number
  routes: InternalRouteTable
  logger: InternalDiagnosticsLogger
  /** Test seam. Defaults to a real `http.Server`. */
  createServer?: (handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) => http.Server
}

/**
 * Open the loopback listener, or report that it could not be opened.
 *
 * `undefined` on ANY listen failure (a port already taken by a co-located
 * process is the realistic one), logged as a warning. An internal health
 * listener must never be able to fail a boot: the pane simply keeps reporting
 * the auth probes as unreachable, which is what it reported before this
 * listener existed.
 */
export async function startInternalDiagnosticsListener(
  options: InternalDiagnosticsListenerOptions,
): Promise<http.Server | undefined> {
  const createServer = options.createServer ?? http.createServer

  const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
    void handleInternalDiagnosticsRequest(request, response, options.routes)
  })

  return new Promise<http.Server | undefined>((resolve) => {
    let settled = false
    const settle = (value: http.Server | undefined): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }

    server.once('error', (error: NodeJS.ErrnoException) => {
      options.logger.warn(
        'Internal auth diagnostics listener could not be opened; the admin Diagnostics pane will keep reporting the auth runtime and readiness probes as unreachable.',
        { port: options.port, code: error.code },
      )
      // A server that failed to listen holds no handle, and closing one that
      // never listened throws ERR_SERVER_NOT_RUNNING.
      settle(undefined)
    })

    server.listen(options.port, INTERNAL_DIAGNOSTICS_BIND_ADDRESS, () => {
      options.logger.info(
        `Internal auth diagnostics listener bound on ${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:${
          options.port
        } (${[...options.routes.keys()].join(', ')}; loopback callers only, never the public front door).`,
      )
      settle(server)
    })
  })
}
