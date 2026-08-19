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
    private readonly logger?: Pick<Logger, 'error'>,
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
    if (
      !this.ready() ||
      signal?.aborted ||
      locals.readOnlyAccess === true ||
      locals.session?.readonly_access === true ||
      locals.mcpScope?.access === 'read' ||
      locals.collaborationEnabled !== true ||
      typeof locals.user?.uuid !== 'string' ||
      locals.user.uuid.length === 0 ||
      !isValidRequest(input)
    ) {
      return { authorized: false }
    }

    const access = await this.checkAccessWithSyncingServer(request, locals, input.noteUuid, signal)
    if (!access.authorized || signal?.aborted) {
      return { authorized: false }
    }

    // The default is deterministic for one encryption/membership generation so
    // separately-authorized clients converge on the same initial room. Redis
    // may rotate an empty room to a fresh epoch; clients then re-authorize with
    // that exact server-reported epoch through expectedRoomEpoch.
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

  private async checkAccessWithSyncingServer(
    request: Request,
    locals: ResponseLocals,
    noteUuid: string,
    signal?: AbortSignal,
  ): Promise<
    { authorized: false } | { authorized: true; serverUpdatedAtTimestamp: number; collaborationSecurityEpoch: string }
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
        return { authorized: false }
      }
      await this.serviceProxy.callSyncingServer(
        request,
        captureResponse,
        this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'items/collaboration-authorization'),
        { itemUuid: noteUuid },
      )
    } catch (error) {
      this.logger?.error(
        'Collaboration access check call failed.',
        safeHttpErrorLogMetadata(error, {
          action: 'collaboration.access-check',
          endpoint: '/items/collaboration-authorization',
          method: 'POST',
        }),
      )
      return { authorized: false }
    }

    if (signal?.aborted || (capturedStatus !== 0 && (capturedStatus < 200 || capturedStatus >= 300))) {
      return { authorized: false }
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
    return authorized === true &&
      Number.isSafeInteger(serverUpdatedAtTimestamp) &&
      Number(serverUpdatedAtTimestamp) > 0 &&
      isValidEpoch(collaborationSecurityEpoch)
      ? {
          authorized: true,
          serverUpdatedAtTimestamp: Number(serverUpdatedAtTimestamp),
          collaborationSecurityEpoch,
        }
      : { authorized: false }
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
