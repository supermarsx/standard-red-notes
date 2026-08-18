import { Request, Response } from 'express'
import { sign } from 'jsonwebtoken'
import { Logger } from 'winston'

import { isValidCollaborationCapabilityTtlSeconds } from '../../Bootstrap/CollaborationCapabilityTtl'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { safeHttpErrorLogMetadata } from '../Logging/SafeLog'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'

export type CollaborationAuthorizationRequest = {
  noteUuid: string
  collaborationProtocolVersion: 2
  leaseRequestId?: string
  bootstrapChallenge?: string
}

export type CollaborationAuthorizationGrant =
  | { authorized: false }
  | {
      authorized: true
      capability: string
      room: string
      expiresIn: number
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 2
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

    const capability = sign(
      {
        purpose: 'collab-room',
        userUuid: locals.user.uuid,
        room: input.noteUuid,
        collaborationProtocolVersion: 2,
        serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
        ...(input.leaseRequestId ? { leaseRequestId: input.leaseRequestId } : {}),
        ...(input.bootstrapChallenge ? { bootstrapChallenge: input.bootstrapChallenge } : {}),
      },
      this.capabilitySecret,
      { algorithm: 'HS256', expiresIn: this.capabilityTtlSeconds },
    )

    return {
      authorized: true,
      capability,
      room: input.noteUuid,
      expiresIn: this.capabilityTtlSeconds,
      serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
      collaborationProtocolVersion: 2,
      ...(input.leaseRequestId ? { leaseRequestId: input.leaseRequestId } : {}),
      ...(input.bootstrapChallenge ? { bootstrapChallenge: input.bootstrapChallenge } : {}),
    }
  }

  private async checkAccessWithSyncingServer(
    request: Request,
    locals: ResponseLocals,
    noteUuid: string,
    signal?: AbortSignal,
  ): Promise<{ authorized: false } | { authorized: true; serverUpdatedAtTimestamp: number }> {
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
          data?: { authorized?: unknown; serverUpdatedAtTimestamp?: unknown }
        }
      | undefined
    const authorized = body?.authorized ?? body?.data?.authorized
    const serverUpdatedAtTimestamp = body?.serverUpdatedAtTimestamp ?? body?.data?.serverUpdatedAtTimestamp
    return authorized === true && Number.isSafeInteger(serverUpdatedAtTimestamp) && Number(serverUpdatedAtTimestamp) > 0
      ? { authorized: true, serverUpdatedAtTimestamp: Number(serverUpdatedAtTimestamp) }
      : { authorized: false }
  }
}

function isValidRequest(input: CollaborationAuthorizationRequest): boolean {
  return (
    typeof input.noteUuid === 'string' &&
    input.noteUuid.length > 0 &&
    input.noteUuid.length <= 200 &&
    input.collaborationProtocolVersion === 2 &&
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
