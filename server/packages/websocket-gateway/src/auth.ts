import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { isSyncDeviceId } from './syncProtocol.js'

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
export interface VerifiedRoomCapability {
  expiresAt: number
  collaborationAuthorizationIssuedAt: number
  serverUpdatedAtTimestamp: number
  collaborationProtocolVersion: 3
  roomEpoch: string
  collaborationSecurityEpoch: string
  leaseRequestId?: string
  bootstrapChallenge?: string
}

/**
 * Verify a room capability and return the exact epoch-millisecond expiry that
 * the room registry must enforce for the lifetime of the membership.
 */
export function verifyRoomCapabilityWithExpiry(
  capability: string | undefined,
  secret: string,
  expectedUserUuid: string,
  expectedRoom: string,
): VerifiedRoomCapability | undefined {
  if (typeof capability !== 'string' || capability.length === 0) {
    return undefined
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    // No secret configured => cannot verify => deny.
    return undefined
  }
  if (typeof expectedUserUuid !== 'string' || expectedUserUuid.length === 0) {
    return undefined
  }
  if (typeof expectedRoom !== 'string' || expectedRoom.length === 0) {
    return undefined
  }

  try {
    const decoded = jwt.verify(capability, secret, { algorithms: ['HS256'], clockTolerance: 10 })
    if (typeof decoded !== 'object' || decoded === null) {
      return undefined
    }
    const payload = decoded as Record<string, unknown>
    if (payload.purpose !== 'collab-room') {
      return undefined
    }
    if (payload.userUuid !== expectedUserUuid) {
      return undefined
    }
    if (payload.room !== expectedRoom) {
      return undefined
    }
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= 0) {
      return undefined
    }
    if (
      payload.collaborationProtocolVersion !== 3 ||
      !Number.isSafeInteger(payload.collaborationAuthorizationIssuedAt) ||
      Number(payload.collaborationAuthorizationIssuedAt) <= 0 ||
      !Number.isSafeInteger(payload.serverUpdatedAtTimestamp) ||
      Number(payload.serverUpdatedAtTimestamp) <= 0 ||
      !isValidCollaborationEpoch(payload.roomEpoch) ||
      !isValidCollaborationEpoch(payload.collaborationSecurityEpoch)
    ) {
      return undefined
    }
    const leaseRequestId = payload.leaseRequestId
    const bootstrapChallenge = payload.bootstrapChallenge
    if (
      (leaseRequestId !== undefined &&
        (typeof leaseRequestId !== 'string' || leaseRequestId.length === 0 || leaseRequestId.length > 128)) ||
      (bootstrapChallenge !== undefined &&
        (typeof bootstrapChallenge !== 'string' ||
          bootstrapChallenge.length === 0 ||
          bootstrapChallenge.length > 128)) ||
      (bootstrapChallenge !== undefined && leaseRequestId === undefined)
    ) {
      return undefined
    }
    return {
      expiresAt: payload.exp * 1_000,
      collaborationAuthorizationIssuedAt: Number(payload.collaborationAuthorizationIssuedAt),
      serverUpdatedAtTimestamp: Number(payload.serverUpdatedAtTimestamp),
      collaborationProtocolVersion: 3,
      roomEpoch: payload.roomEpoch,
      collaborationSecurityEpoch: payload.collaborationSecurityEpoch,
      ...(leaseRequestId ? { leaseRequestId } : {}),
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
    }
  } catch {
    return undefined
  }
}

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

export function verifyRoomCapability(
  capability: string | undefined,
  secret: string,
  expectedUserUuid: string,
  expectedRoom: string,
): boolean {
  return verifyRoomCapabilityWithExpiry(capability, secret, expectedUserUuid, expectedRoom) !== undefined
}

export const DEFAULT_SYNC_TICKET_TTL_MS = 30_000

export interface SyncTicketIdentity {
  userUuid: string
  sessionUuid: string
  deviceId: string
  /** Server-side only bearer credential used for live per-command revalidation. */
  authorization?: string
}

export interface IssuedSyncTicket {
  ticket: string
  expiresAt: number
}

export interface SyncAuthTicketStore {
  /** Shared stores are safe across gateway replicas; process stores are test/dev only. */
  readonly distribution: 'process' | 'shared'
  issue(identity: SyncTicketIdentity, ttlMs?: number): Promise<IssuedSyncTicket>
  consume(ticket: string, signal?: AbortSignal): Promise<SyncTicketIdentity | undefined>
  ready(): boolean
  clear?(): void | Promise<void>
}

interface StoredSyncTicket {
  digest: Buffer
  identity: SyncTicketIdentity
  expiresAt: number
}

function ticketDigest(ticket: string): Buffer {
  return createHash('sha256').update(ticket, 'utf8').digest()
}

export function isValidSyncTicketIdentity(identity: SyncTicketIdentity): boolean {
  return (
    typeof identity.userUuid === 'string' &&
    identity.userUuid.length > 0 &&
    identity.userUuid.length <= 128 &&
    typeof identity.sessionUuid === 'string' &&
    identity.sessionUuid.length > 0 &&
    identity.sessionUuid.length <= 128 &&
    isSyncDeviceId(identity.deviceId) &&
    (identity.authorization === undefined ||
      (typeof identity.authorization === 'string' &&
        identity.authorization.length > 0 &&
        identity.authorization.length <= 16_384))
  )
}

/**
 * One-use opaque ticket store. Deployments with multiple gateway replicas can
 * inject a shared implementation; tests deliberately share one instance across
 * replicas to exercise atomic consume semantics. No identity data is encoded in
 * the browser-visible ticket.
 */
export class InMemorySyncAuthTicketStore implements SyncAuthTicketStore {
  readonly distribution = 'process' as const
  private readonly tickets = new Map<string, StoredSyncTicket>()

  constructor(private readonly now: () => number = Date.now) {}

  ready(): boolean {
    return true
  }

  async issue(identity: SyncTicketIdentity, ttlMs = DEFAULT_SYNC_TICKET_TTL_MS): Promise<IssuedSyncTicket> {
    if (!isValidSyncTicketIdentity(identity)) {
      throw new Error('Invalid sync ticket identity.')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) {
      throw new Error('Invalid sync ticket TTL.')
    }
    this.sweepExpired()
    const ticket = randomBytes(32).toString('base64url')
    const digest = ticketDigest(ticket)
    const expiresAt = this.now() + ttlMs
    this.tickets.set(digest.toString('hex'), { digest, identity: { ...identity }, expiresAt })
    return { ticket, expiresAt }
  }

  async consume(ticket: string): Promise<SyncTicketIdentity | undefined> {
    if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 256) {
      return undefined
    }
    const providedDigest = ticketDigest(ticket)
    const key = providedDigest.toString('hex')
    const stored = this.tickets.get(key)
    if (!stored) {
      return undefined
    }
    // Delete before checking expiry/returning identity: even an expired or
    // concurrently replayed ticket can never be revived or consumed twice.
    this.tickets.delete(key)
    if (!timingSafeEqual(providedDigest, stored.digest) || stored.expiresAt <= this.now()) {
      return undefined
    }
    return { ...stored.identity }
  }

  clear(): void {
    this.tickets.clear()
  }

  private sweepExpired(): void {
    const now = this.now()
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(key)
      }
    }
  }
}
