import jwt from 'jsonwebtoken'

/**
 * Payload carried by a connection token. The gateway only cares about
 * userUuid (routing key) and sessionUuid (exclusion key for echo
 * suppression). `iat`/`exp` are standard JWT claims set by the signer.
 */
export interface ConnectionTokenPayload {
  userUuid: string
  sessionUuid: string
  iat?: number
  exp?: number
}

/**
 * Verify a connection token (HS256, signed with
 * WEB_SOCKET_CONNECTION_TOKEN_SECRET).
 *
 * Throws on any verification failure (bad signature, expired, wrong alg,
 * malformed payload). Callers should catch and close the socket with 1008.
 */
export function verifyConnectionToken(token: string, secret: string): ConnectionTokenPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] })

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('connection token payload is not an object')
  }

  const payload = decoded as Record<string, unknown>

  if (typeof payload.userUuid !== 'string' || payload.userUuid.length === 0) {
    throw new Error('connection token missing userUuid')
  }
  if (typeof payload.sessionUuid !== 'string' || payload.sessionUuid.length === 0) {
    throw new Error('connection token missing sessionUuid')
  }

  return {
    userUuid: payload.userUuid,
    sessionUuid: payload.sessionUuid,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  }
}

/**
 * Mint a fresh connection token for the given identity. Used by the
 * POST /sockets/tokens endpoint, which trusted/internal callers (e.g. the
 * api-gateway) proxy to in order to hand a browser a short-lived WS token.
 *
 * @param ttl jsonwebtoken `expiresIn` string/number, e.g. '60s'.
 */
export function decodeCrossServiceToken(
  token: string,
  secret: string,
): { userUuid: string; sessionUuid: string } | undefined {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] })
    if (typeof decoded !== 'object' || decoded === null) {
      return undefined
    }
    const payload = decoded as { user?: { uuid?: unknown }; session?: { uuid?: unknown } }
    const userUuid = payload.user?.uuid
    const sessionUuid = payload.session?.uuid
    if (typeof userUuid !== 'string' || !userUuid || typeof sessionUuid !== 'string' || !sessionUuid) {
      return undefined
    }
    return { userUuid, sessionUuid }
  } catch {
    return undefined
  }
}

export function mintConnectionToken(
  identity: { userUuid: string; sessionUuid: string },
  secret: string,
  ttl: string | number,
): string {
  return jwt.sign({ userUuid: identity.userUuid, sessionUuid: identity.sessionUuid }, secret, {
    algorithm: 'HS256',
    // jsonwebtoken's typings are picky about the union; the value is a valid
    // `expiresIn` (number of seconds or a vercel/ms string like '60s').
    expiresIn: ttl as jwt.SignOptions['expiresIn'],
  })
}
