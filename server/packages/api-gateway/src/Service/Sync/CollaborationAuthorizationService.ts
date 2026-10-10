import { Request, Response } from 'express'
import { createHmac } from 'node:crypto'
import { sign } from 'jsonwebtoken'
import { Logger } from 'winston'

import { isValidCollaborationCapabilityTtlSeconds } from '../../Bootstrap/CollaborationCapabilityTtl'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { safeHttpErrorLogMetadata } from '../Logging/SafeLog'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'

export type CollaborationAuthorizationRequest =
  | {
      noteUuid: string
      collaborationProtocolVersion: 3
      epochDiscovery: true
    }
  | {
      noteUuid: string
      collaborationProtocolVersion: 3
      epochDiscovery?: false
      expectedRoomEpoch: string
      leaseRequestId?: string
      bootstrapChallenge?: string
    }

export type CollaborationAuthorizationGrant =
  | { authorized: false }
  | {
      authorized: true
      epochDiscovery: true
      room: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
    }
  | {
      authorized: true
      epochDiscovery: false
      capability: string
      room: string
      expiresIn: number
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
      leaseRequestId?: string
      bootstrapChallenge?: string
    }

const MAX_BOUND_IDENTIFIER_LENGTH = 128

/**
 * WHY a collaboration authorization was refused.
 *
 * Two silent defects in this one lane denied 100 % of collaboration -- on
 * multi-container deployments (`0a6897b3`: a fabricated request with no
 * `method`, which axios defaulted to GET, so the access-check route did not
 * exist) and on single-container ones (`6e18e3a5`:
 * `DirectCallServiceProxy.callSyncingServer` declared three parameters against
 * a four-parameter interface and discarded `payload`, the only place
 * `{ itemUuid }` existed). Both spent weeks looking like a permission setting,
 * because a fail-closed authorizer with no logger produced exactly one trace
 * for either cause: a `collaboration_authorization denied` counter.
 *
 * So a denial now says which it is, and the two kinds are deliberately
 * different LOG MESSAGES and not merely different field values:
 *
 *   policy      something decided, and the decision was no. Normal operation:
 *               a read-only session, a feature gate, a note this account may
 *               not edit. Logged at info.
 *   unreadable  nothing decided. The access check could not be reached, or
 *               answered something this service cannot read a decision out of.
 *               That is a PLUMBING fault wearing a permission refusal's
 *               clothes, and it is logged at ERROR.
 *
 * Honest about the limit: the single-container defect lands in `policy`, as
 * `access-check-refused`, because the syncing server really did answer a
 * well-formed `{ authorized: false }` -- it was answering about `undefined`
 * instead of the note, and no inspection of that answer can tell. What changes
 * is that the refusal is now VISIBLE, and visible with the note uuid this
 * service asked about, so "my own note, refused, every time" is a contradiction
 * an operator can see instead of silence. The multi-container defect lands in
 * `unreadable`, as `access-check-http-status`, which names the plumbing
 * directly. The structural guard against the signature half of it is
 * `ServiceProxyArity.spec.ts`.
 */
export const CollaborationDenial = {
  /** No signing secret / invalid capability TTL: this deployment cannot mint. */
  NotConfigured: 'authorizer-not-configured',
  ReadOnlySession: 'read-only-session',
  ReadScopedMcpSession: 'read-scoped-mcp-session',
  CollaborationDisabled: 'collaboration-disabled',
  UnidentifiedSession: 'unidentified-session',
  MalformedRequest: 'malformed-request',
  /** The access check answered, and its answer was `authorized: false`. */
  AccessCheckRefused: 'access-check-refused',
  /** The access-check call threw: no answer at all. */
  AccessCheckUnreachable: 'access-check-unreachable',
  /** The access check answered a non-2xx: the route or the service is wrong. */
  AccessCheckHttpStatus: 'access-check-http-status',
  /** A 2xx whose body carries no decision this service can read. */
  AccessCheckUnreadable: 'access-check-unreadable',
  /** `authorized: true` with no usable revision or security epoch. */
  AccessCheckIncompleteGrant: 'access-check-incomplete-grant',
  /** The caller stopped waiting. Not a verdict either way. */
  Abandoned: 'request-abandoned',
} as const

export type CollaborationDenialReason = (typeof CollaborationDenial)[keyof typeof CollaborationDenial]

export type CollaborationDenialCategory = 'policy' | 'unreadable' | 'abandoned'

/**
 * Typed as a total record, so a reason added without a category is a COMPILE
 * error rather than an `undefined` that quietly logs at the wrong level.
 */
const DENIAL_CATEGORIES: Record<CollaborationDenialReason, CollaborationDenialCategory> = {
  [CollaborationDenial.NotConfigured]: 'policy',
  [CollaborationDenial.ReadOnlySession]: 'policy',
  [CollaborationDenial.ReadScopedMcpSession]: 'policy',
  [CollaborationDenial.CollaborationDisabled]: 'policy',
  [CollaborationDenial.UnidentifiedSession]: 'policy',
  [CollaborationDenial.MalformedRequest]: 'policy',
  [CollaborationDenial.AccessCheckRefused]: 'policy',
  [CollaborationDenial.AccessCheckUnreachable]: 'unreadable',
  [CollaborationDenial.AccessCheckHttpStatus]: 'unreadable',
  [CollaborationDenial.AccessCheckUnreadable]: 'unreadable',
  [CollaborationDenial.AccessCheckIncompleteGrant]: 'unreadable',
  [CollaborationDenial.Abandoned]: 'abandoned',
}

export function collaborationDenialCategory(reason: CollaborationDenialReason): CollaborationDenialCategory {
  return DENIAL_CATEGORIES[reason]
}

/**
 * Shared fail-closed collaboration policy used by both the REST compatibility
 * endpoint and the authenticated WebSocket sync control plane. Keeping one
 * implementation prevents the two transports from drifting on read-only,
 * feature-gate, canonical-revision, or capability-binding semantics.
 */
export class CollaborationAuthorizationService {
  constructor(
    private readonly serviceProxy: ServiceProxyInterface,
    private readonly endpointResolver: EndpointResolverInterface,
    private readonly capabilitySecret: string,
    private readonly capabilityTtlSeconds: number,
    private readonly logger?: Pick<Logger, 'error' | 'info'>,
  ) {}

  ready(): boolean {
    return this.capabilitySecret.length > 0 && isValidCollaborationCapabilityTtlSeconds(this.capabilityTtlSeconds)
  }

  async authorize(
    request: Request,
    locals: ResponseLocals,
    input: CollaborationAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<CollaborationAuthorizationGrant> {
    // Each condition names itself. The ORDER and the outcome are unchanged --
    // every one of these still refuses before the access check runs, and still
    // refuses with a bare `{ authorized: false }` that discloses nothing to the
    // caller. The only new thing is that the server now knows which it was.
    const who = typeof locals.user?.uuid === 'string' ? { userId: locals.user.uuid } : {}
    const precondition = this.refusedByPrecondition(locals, input, signal)
    if (precondition !== undefined) {
      return this.deny(precondition, who)
    }

    const access = await this.checkAccessWithSyncingServer(request, locals, input.noteUuid, signal)
    if (!access.authorized) {
      return this.deny(access.reason, {
        ...who,
        ...(access.status === undefined ? {} : { accessCheckStatus: access.status }),
        ...(access.errorMetadata === undefined ? {} : access.errorMetadata),
      })
    }
    if (signal?.aborted) {
      return this.deny(CollaborationDenial.Abandoned, who)
    }

    // The default is deterministic for one encryption/membership generation so
    // separately-authorized clients converge on the same initial room. This
    // service never reads room state: the websocket gateway may rotate an
    // empty room to a fresh epoch, and on the sync lane it substitutes the
    // room's CURRENT epoch for this initial value in the discovery answer
    // (`collaborationRoomEpochResolver`, contract C4) while keeping the
    // one-use challenge binding. That resolver is the only source of rotation;
    // the grant leg below signs whatever expectedRoomEpoch the client learned.
    const initialRoomEpoch = createHmac('sha256', this.capabilitySecret)
      .update(`${input.noteUuid}\u0000${access.collaborationSecurityEpoch}`, 'utf8')
      .digest('base64url')

    if (input.epochDiscovery === true) {
      return {
        authorized: true,
        epochDiscovery: true,
        room: input.noteUuid,
        serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
        collaborationProtocolVersion: 3,
        roomEpoch: initialRoomEpoch,
        collaborationSecurityEpoch: access.collaborationSecurityEpoch,
      }
    }

    const roomEpoch = input.expectedRoomEpoch

    const collaborationAuthorizationIssuedAt = Date.now()
    const capability = sign(
      {
        purpose: 'collab-room',
        userUuid: locals.user.uuid,
        room: input.noteUuid,
        collaborationProtocolVersion: 3,
        collaborationAuthorizationIssuedAt,
        roomEpoch,
        collaborationSecurityEpoch: access.collaborationSecurityEpoch,
        serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
        ...(input.leaseRequestId ? { leaseRequestId: input.leaseRequestId } : {}),
        ...(input.bootstrapChallenge ? { bootstrapChallenge: input.bootstrapChallenge } : {}),
      },
      this.capabilitySecret,
      { algorithm: 'HS256', expiresIn: this.capabilityTtlSeconds },
    )

    return {
      authorized: true,
      epochDiscovery: false,
      capability,
      room: input.noteUuid,
      expiresIn: this.capabilityTtlSeconds,
      serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
      collaborationProtocolVersion: 3,
      roomEpoch,
      collaborationSecurityEpoch: access.collaborationSecurityEpoch,
      ...(input.leaseRequestId ? { leaseRequestId: input.leaseRequestId } : {}),
      ...(input.bootstrapChallenge ? { bootstrapChallenge: input.bootstrapChallenge } : {}),
    }
  }

  /**
   * The first refusal this request earns, before any resource is consulted, or
   * `undefined` when none of them applies. Pure, so the mapping from condition
   * to reason is testable on its own.
   */
  private refusedByPrecondition(
    locals: ResponseLocals,
    input: CollaborationAuthorizationRequest,
    signal?: AbortSignal,
  ): CollaborationDenialReason | undefined {
    if (!this.ready()) {
      return CollaborationDenial.NotConfigured
    }
    if (signal?.aborted) {
      return CollaborationDenial.Abandoned
    }
    if (locals.readOnlyAccess === true || locals.session?.readonly_access === true) {
      return CollaborationDenial.ReadOnlySession
    }
    if (locals.mcpScope?.access === 'read') {
      return CollaborationDenial.ReadScopedMcpSession
    }
    if (locals.collaborationEnabled !== true) {
      return CollaborationDenial.CollaborationDisabled
    }
    if (typeof locals.user?.uuid !== 'string' || locals.user.uuid.length === 0) {
      return CollaborationDenial.UnidentifiedSession
    }
    if (!isValidRequest(input)) {
      return CollaborationDenial.MalformedRequest
    }
    return undefined
  }

  /**
   * Record a refusal and return the refusal the caller has always received.
   *
   * The returned value is byte-identical to the bare `{ authorized: false }`
   * this method replaced: nothing about WHY crosses the service boundary, so a
   * caller still cannot distinguish "this note does not exist" from "it exists
   * and you may not edit it". The reason exists for the operator's log only.
   *
   * The NOTE UUID is deliberately absent, here and in the access-check error
   * metadata. One line per refusal, and the line says what kind of refusal it
   * was, not which resource it was about.
   */
  private deny(reason: CollaborationDenialReason, context: Record<string, unknown>): { authorized: false } {
    const category = collaborationDenialCategory(reason)
    // `action`, `reason` and `category` are written LAST so merged exception
    // metadata (which carries its own `action`) cannot rename the verdict.
    const metadata = { ...context, action: 'collaboration.authorize', reason, category }
    if (category === 'unreadable') {
      // A fail-closed refusal that NOTHING DECIDED. This is the arm both silent
      // defects belonged in, and it is the one an operator must be able to find
      // in an error log without knowing to look for it.
      this.logger?.error('Collaboration authorization could not be decided.', metadata)
    } else {
      this.logger?.info('Collaboration authorization denied.', metadata)
    }
    return { authorized: false }
  }

  private async checkAccessWithSyncingServer(
    request: Request,
    locals: ResponseLocals,
    noteUuid: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        authorized: false
        reason: CollaborationDenialReason
        status?: number
        /** Already-redacted exception detail, merged into the ONE denial line. */
        errorMetadata?: Record<string, unknown>
      }
    | { authorized: true; serverUpdatedAtTimestamp: number; collaborationSecurityEpoch: string }
  > {
    let capturedStatus = 0
    let capturedBody: unknown
    const captureResponse = {
      locals,
      setHeader: () => captureResponse,
      status: (code: number) => {
        capturedStatus = code
        return captureResponse
      },
      send: (body: unknown) => {
        capturedBody = body
        return captureResponse
      },
      json: (body: unknown) => {
        capturedBody = body
        return captureResponse
      },
    } as unknown as Response

    try {
      if (signal?.aborted) {
        return { authorized: false, reason: CollaborationDenial.Abandoned }
      }
      await this.serviceProxy.callSyncingServer(
        request,
        captureResponse,
        this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'items/collaboration-authorization'),
        { itemUuid: noteUuid },
      )
    } catch (error) {
      // The exception detail travels WITH the verdict rather than on a line of
      // its own: one refusal, one log line, carrying both what went wrong and
      // the fact that nothing decided the refusal that followed.
      return {
        authorized: false,
        reason: CollaborationDenial.AccessCheckUnreachable,
        errorMetadata: safeHttpErrorLogMetadata(error, {
          action: 'collaboration.access-check',
          endpoint: '/items/collaboration-authorization',
          method: 'POST',
        }),
      }
    }

    if (signal?.aborted) {
      return { authorized: false, reason: CollaborationDenial.Abandoned }
    }
    if (capturedStatus !== 0 && (capturedStatus < 200 || capturedStatus >= 300)) {
      // `0` means the direct-call transport never set a status, which is normal
      // for it. A real non-2xx means the ROUTE answered wrongly, and that is
      // the exact trace the multi-container defect left: `POST
      // items/collaboration-authorization` dispatched as a GET, no such route,
      // 404 -- read until now as `{ authorized: false }` and nothing else.
      return {
        authorized: false,
        reason: CollaborationDenial.AccessCheckHttpStatus,
        status: capturedStatus,
      }
    }
    const body = capturedBody as
      | {
          authorized?: unknown
          serverUpdatedAtTimestamp?: unknown
          collaborationSecurityEpoch?: unknown
          data?: {
            authorized?: unknown
            serverUpdatedAtTimestamp?: unknown
            collaborationSecurityEpoch?: unknown
          }
        }
      | undefined
    const authorized = body?.authorized ?? body?.data?.authorized
    const serverUpdatedAtTimestamp = body?.serverUpdatedAtTimestamp ?? body?.data?.serverUpdatedAtTimestamp
    const collaborationSecurityEpoch = body?.collaborationSecurityEpoch ?? body?.data?.collaborationSecurityEpoch
    if (authorized === true) {
      return Number.isSafeInteger(serverUpdatedAtTimestamp) &&
        Number(serverUpdatedAtTimestamp) > 0 &&
        isValidEpoch(collaborationSecurityEpoch)
        ? {
            authorized: true,
            serverUpdatedAtTimestamp: Number(serverUpdatedAtTimestamp),
            collaborationSecurityEpoch,
          }
        : // Said yes, and did not supply what a capability has to be bound to.
          // Nobody decided this refusal either.
          { authorized: false, reason: CollaborationDenial.AccessCheckIncompleteGrant }
    }
    // `false` is a DECISION; anything else is a 2xx we cannot read a decision
    // out of (an error envelope, an empty body, a different shape) and is NOT
    // the access check saying no.
    return {
      authorized: false,
      reason: authorized === false ? CollaborationDenial.AccessCheckRefused : CollaborationDenial.AccessCheckUnreadable,
    }
  }
}

function isValidRequest(input: CollaborationAuthorizationRequest): boolean {
  if (
    typeof input.noteUuid !== 'string' ||
    input.noteUuid.length === 0 ||
    input.noteUuid.length > 200 ||
    input.collaborationProtocolVersion !== 3
  ) {
    return false
  }
  if (input.epochDiscovery === true) {
    const candidate = input as unknown as Record<string, unknown>
    return (
      candidate.expectedRoomEpoch === undefined &&
      candidate.leaseRequestId === undefined &&
      candidate.bootstrapChallenge === undefined
    )
  }
  return (
    isValidEpoch(input.expectedRoomEpoch) &&
    (input.leaseRequestId === undefined ||
      (typeof input.leaseRequestId === 'string' &&
        input.leaseRequestId.length > 0 &&
        input.leaseRequestId.length <= MAX_BOUND_IDENTIFIER_LENGTH)) &&
    (input.bootstrapChallenge === undefined ||
      (typeof input.bootstrapChallenge === 'string' &&
        input.bootstrapChallenge.length > 0 &&
        input.bootstrapChallenge.length <= MAX_BOUND_IDENTIFIER_LENGTH)) &&
    (input.bootstrapChallenge === undefined || input.leaseRequestId !== undefined)
  )
}

function isValidEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
