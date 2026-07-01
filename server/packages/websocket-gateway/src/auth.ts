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
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 10 })

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
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 10 })
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

/**
 * Standard Red Notes: verify a collaboration-room capability minted by the
 * api-gateway (`POST /v1/collaboration/authorize`) and presented by the client on
 * `room-join`. The capability is an HS256 JWT signed with the SAME secret the
 * connection token uses, with payload `{ purpose: 'collab-room', userUuid, room }`.
 *
 * Returns true ONLY when the capability:
 *   - is a non-empty string,
 *   - verifies under `secret` with alg HS256 (signature + not-expired),
 *   - has purpose === 'collab-room',
 *   - was issued for THIS user (payload.userUuid === expectedUserUuid), and
 *   - was issued for THIS room (payload.room === expectedRoom).
 *
 * ANY deviation (missing/empty, bad signature, expired, wrong alg, wrong purpose,
 * wrong user, wrong room, malformed payload, thrown error) returns false. There
 * is NO branch that returns true on uncertainty — this is the fail-closed core.
 */
export function verifyRoomCapability(
  capability: string | undefined,
  secret: string,
  expectedUserUuid: string,
  expectedRoom: string,
): boolean {
  if (typeof capability !== 'string' || capability.length === 0) {
    return false
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    // No secret configured => cannot verify => deny.
    return false
  }
  if (typeof expectedUserUuid !== 'string' || expectedUserUuid.length === 0) {
    return false
  }
  if (typeof expectedRoom !== 'string' || expectedRoom.length === 0) {
    return false
  }

  try {
    const decoded = jwt.verify(capability, secret, { algorithms: ['HS256'], clockTolerance: 10 })
    if (typeof decoded !== 'object' || decoded === null) {
      return false
    }
    const payload = decoded as Record<string, unknown>
    if (payload.purpose !== 'collab-room') {
      return false
    }
    if (payload.userUuid !== expectedUserUuid) {
      return false
    }
    if (payload.room !== expectedRoom) {
      return false
    }
    return true
  } catch {
    return false
  }
}
