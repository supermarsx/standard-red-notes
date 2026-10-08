import * as http from 'http'
import { isLoopbackReadinessCaller } from '@standardnotes/api-gateway'
import type { Request } from 'express'

/**
 * Standard Red Notes: the auth `/healthcheck/diagnostics` route, served on the
 * ONE topology where auth has no HTTP port of its own.
 *
 * *** THE PROBLEM ***
 * `AdminController.probeAuthRuntime()` fetches
 * `${SERVICE_PROBE_URLS.auth}/healthcheck/diagnostics` over HTTP, and that map
 * defaults to the supervisord sibling port (`AUTH_SERVER_PORT`, 3103). On the
 * single container there is one process on one port and nothing at all listens
 * on 3103, so the probe failed and THREE whole blocks of the admin Diagnostics
 * pane — the auth half of `runtime`, the entire `datastore` block and the
 * dead-outbox census — read as unreachable on the shape most self-hosters
 * deploy.
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
 * *** THE EXPOSURE BOUNDARY ***
 * On multi-container the route answers on auth's internal port and 404s at the
 * public front door, and that property is load-bearing. This listener keeps it
 * EXACTLY, in two independent ways:
 *
 *   1. The route is not registered on the public :3000 app at all, so the front
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
 * learn from the response that the route exists at all.
 */

/** The path the gateway's probe asks for, and the only one served here. */
export const INTERNAL_DIAGNOSTICS_PATH = '/healthcheck/diagnostics'

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
 * without opening a socket. Never throws: a report that rejects answers 503
 * with the same bounded body shape, because an admin probe must not be able to
 * take this listener down and a stack trace must never reach a response.
 */
export async function handleInternalDiagnosticsRequest(
  request: InternalDiagnosticsRequest,
  response: InternalDiagnosticsResponse,
  report: () => Promise<unknown>,
): Promise<void> {
  const notFound = (): void => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(NOT_FOUND_BODY)
  }

  if (request.method !== 'GET' || readRequestPath(request.url) !== INTERNAL_DIAGNOSTICS_PATH) {
    notFound()

    return
  }

  // The gate. Identical answer to an unmatched path, so a refused caller cannot
  // tell the route apart from one that does not exist.
  if (!isLoopbackReadinessCaller(request as unknown as Pick<Request, 'socket' | 'headers'>)) {
    notFound()

    return
  }

  let body: string
  try {
    body = JSON.stringify(await report())
  } catch {
    // Deliberately blind: a probe rejection is exactly where a driver puts a
    // host, a port and a database name, so nothing from it is read or echoed.
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Diagnostics unavailable' } }))

    return
  }

  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(body)
}

export type InternalDiagnosticsListenerOptions = {
  port: number
  report: () => Promise<unknown>
  logger: InternalDiagnosticsLogger
  /** Test seam. Defaults to a real `http.Server`. */
  createServer?: (handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) => http.Server
}

/**
 * Open the loopback listener, or report that it could not be opened.
 *
 * `undefined` on ANY listen failure (a port already taken by a co-located
 * process is the realistic one), logged as a warning. A diagnostics listener
 * must never be able to fail a boot: the pane simply keeps reporting the probe
 * as unreachable, which is what it reported before this listener existed.
 */
export async function startInternalDiagnosticsListener(
  options: InternalDiagnosticsListenerOptions,
): Promise<http.Server | undefined> {
  const createServer = options.createServer ?? http.createServer

  const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
    void handleInternalDiagnosticsRequest(request, response, options.report)
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
        'Internal auth diagnostics listener could not be opened; the admin Diagnostics pane will keep reporting the auth runtime probe as unreachable.',
        { port: options.port, code: error.code },
      )
      // A server that failed to listen holds no handle, and closing one that
      // never listened throws ERR_SERVER_NOT_RUNNING.
      settle(undefined)
    })

    server.listen(options.port, INTERNAL_DIAGNOSTICS_BIND_ADDRESS, () => {
      options.logger.info(
        `Internal auth diagnostics listener bound on ${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:${options.port} (${INTERNAL_DIAGNOSTICS_PATH}; loopback callers only, never the public front door).`,
      )
      settle(server)
    })
  })
}
