import * as crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'

/**
 * Standard Red Notes: server-wide shared access key ("obfuscation gate").
 *
 * SECURITY MODEL — READ THIS FIRST:
 * This is an OBFUSCATION / ACCESS-GATING layer, NOT end-to-end security and NOT
 * a replacement for the account password. Real confidentiality of note content
 * is provided by the existing client-side E2E encryption. This gate only makes a
 * self-hosted instance refuse to talk to clients that do not present a shared
 * secret configured by the operator — analogous to a reverse-proxy "basic auth"
 * gate, but built into the gateway so the official clients can pass it by sending
 * the key as a header. A determined attacker who already has the key (or can read
 * it from a client device) is not stopped by this; it only deters casual scanners
 * that stumble onto the server.
 *
 * The gate is COMPLETELY OFF by default. When SHARED_SERVER_ACCESS_KEY is empty or
 * unset (or the mode resolves to `off`), the middleware is a pure pass-through and
 * there is ZERO behavior change for existing installs.
 *
 * Modes:
 *   off          - pass everything through (default).
 *   all          - every request must present a matching key header, except an
 *                  allowlist (e.g. the container healthcheck) so the container
 *                  stays healthy.
 *   registration - only account-registration requests must present the key, so an
 *                  operator can block unknown sign-ups while leaving existing users
 *                  (sync, sign-in, etc.) completely unaffected.
 */

export const SHARED_SERVER_ACCESS_KEY_HEADER = 'x-shared-server-key'

export enum SharedServerAccessKeyMode {
  Off = 'off',
  All = 'all',
  Registration = 'registration',
}

export type SharedServerAccessKeyConfig = {
  /** The configured shared key. Empty/undefined disables the gate entirely. */
  key: string | undefined
  /** Resolved enforcement mode. Anything unrecognized resolves to `off`. */
  mode: SharedServerAccessKeyMode
}

/**
 * Resolve raw env strings into a normalized config. Reading env here keeps the
 * middleware itself free of process.env so it stays trivially unit-testable.
 *
 * Default behavior: if no key is set, the mode is forced to `off` regardless of
 * the mode var, guaranteeing zero behavior change unless the operator opts in.
 */
export const resolveSharedServerAccessKeyConfig = (
  rawKey: string | undefined,
  rawMode: string | undefined,
): SharedServerAccessKeyConfig => {
  const key = rawKey && rawKey.length > 0 ? rawKey : undefined

  if (key === undefined) {
    return { key: undefined, mode: SharedServerAccessKeyMode.Off }
  }

  let mode: SharedServerAccessKeyMode
  switch ((rawMode ?? '').trim().toLowerCase()) {
    case SharedServerAccessKeyMode.All:
      mode = SharedServerAccessKeyMode.All
      break
    case SharedServerAccessKeyMode.Registration:
      mode = SharedServerAccessKeyMode.Registration
      break
    case SharedServerAccessKeyMode.Off:
      mode = SharedServerAccessKeyMode.Off
      break
    default:
      // A key is set but the mode is missing/unknown: default to gating all
      // requests, the safest interpretation of "I configured a key".
      mode = SharedServerAccessKeyMode.All
  }

  return { key, mode }
}

/**
 * Constant-time comparison that does not leak length or content via timing.
 * Returns false for any missing/mismatched input. The key is never logged.
 */
const keysMatch = (provided: string | undefined, expected: string): boolean => {
  if (typeof provided !== 'string' || provided.length === 0) {
    return false
  }

  const providedBuffer = Buffer.from(provided, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  // timingSafeEqual throws if lengths differ, which itself leaks length. Hash
  // both sides to fixed-length digests first so the comparison is always over
  // equal-length buffers regardless of the supplied value.
  const providedDigest = crypto.createHash('sha256').update(providedBuffer).digest()
  const expectedDigest = crypto.createHash('sha256').update(expectedBuffer).digest()

  return crypto.timingSafeEqual(providedDigest, expectedDigest)
}

const readHeaderKey = (request: Request): string | undefined => {
  const value = request.headers[SHARED_SERVER_ACCESS_KEY_HEADER]
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

/**
 * Paths exempt from the gate even in `all` mode, so container/orchestrator
 * healthchecks keep passing. Matched against the request path (without query).
 */
const DEFAULT_HEALTHCHECK_PATHS = ['/healthcheck']

const isHealthcheckPath = (path: string, healthcheckPaths: string[]): boolean => {
  return healthcheckPaths.some((healthcheckPath) => {
    return path === healthcheckPath || path === `${healthcheckPath}/` || path.startsWith(`${healthcheckPath}/`)
  })
}

/**
 * Decide whether a request targets account registration. Registration is exposed
 * via the modern `POST /v1/users` route and the legacy `POST /auth` route. We
 * intentionally do NOT gate the parametrized credential-change routes — only the
 * initial account creation.
 */
const isRegistrationRequest = (request: Request): boolean => {
  if (request.method.toUpperCase() !== 'POST') {
    return false
  }
  const path = request.path.replace(/\/+$/, '') || '/'
  return path === '/v1/users' || path === '/auth'
}

const rejectionMessage = {
  error: {
    // Deliberately generic so a scanner cannot tell whether the key, the route,
    // or something else was wrong.
    message: 'Access to this server is restricted.',
  },
}

export type CreateSharedServerAccessKeyMiddlewareOptions = {
  healthcheckPaths?: string[]
}

/**
 * Build the Express middleware enforcing the shared-key gate for the given
 * config. Returns a no-op pass-through when the gate is off so installing it
 * unconditionally is safe.
 */
export const createSharedServerAccessKeyMiddleware = (
  config: SharedServerAccessKeyConfig,
  options: CreateSharedServerAccessKeyMiddlewareOptions = {},
): ((request: Request, response: Response, next: NextFunction) => void) => {
  const healthcheckPaths = options.healthcheckPaths ?? DEFAULT_HEALTHCHECK_PATHS

  if (config.mode === SharedServerAccessKeyMode.Off || config.key === undefined) {
    return (_request: Request, _response: Response, next: NextFunction): void => {
      next()
    }
  }

  const expectedKey = config.key

  return (request: Request, response: Response, next: NextFunction): void => {
    // Healthchecks are always exempt so the container stays alive.
    if (isHealthcheckPath(request.path, healthcheckPaths)) {
      next()
      return
    }

    if (config.mode === SharedServerAccessKeyMode.Registration && !isRegistrationRequest(request)) {
      next()
      return
    }

    if (keysMatch(readHeaderKey(request), expectedKey)) {
      next()
      return
    }

    response.status(401).send(rejectionMessage)
  }
}
