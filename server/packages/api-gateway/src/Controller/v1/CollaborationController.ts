import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'
import { sign } from 'jsonwebtoken'
import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { isValidCollaborationCapabilityTtlSeconds } from '../../Bootstrap/CollaborationCapabilityTtl'
import { safeHttpErrorLogMetadata } from '../../Service/Logging/SafeLog'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

interface AuthorizeRequestBody {
  /** Note (item) uuid the client wants to collaborate on; equals the relay room id. */
  noteUuid?: string
  collaborationProtocolVersion?: number
  leaseRequestId?: string
  bootstrapChallenge?: string
}

const COLLABORATION_PROTOCOL_VERSION = 2
const MAX_BOUND_IDENTIFIER_LENGTH = 128

type CollaborationAccessCheck = { authorized: false } | { authorized: true; serverUpdatedAtTimestamp: number }

/**
 * Standard Red Notes: mints a SHORT-LIVED, SIGNED capability proving that the
 * authenticated user may join the realtime collaboration room for a given note.
 *
 * Flow:
 *  1. The client opens a note for collaboration and POSTs its uuid here.
 *  2. We reject read-only sessions, then ask the syncing-server (single source
 *     of truth for note ownership + shared-vault write permission) whether this
 *     user may edit the note.
 *  3. ONLY on an explicit `authorized: true` do we mint an HS256 capability
 *     binding the user, room, v2 protocol, canonical server revision, and any
 *     lease request/bootstrap challenge supplied by the two-phase handshake.
 *  4. The gateway verifies that capability locally and requires exact bindings
 *     first on `room-reserve`, then on challenge-bound `room-join` activation.
 *
 * FAILS CLOSED everywhere: missing/invalid input, no signing secret configured,
 * a read-only session, an unauthorized result, a non-2xx / unparseable
 * syncing-server response, or any thrown error all yield 403 with NO capability.
 */
@controller('/v1/collaboration')
export class CollaborationController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
    @inject(TYPES.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET) private capabilitySecret: string,
    @inject(TYPES.ApiGateway_COLLABORATION_CAPABILITY_TTL) private capabilityTtlSeconds: number,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
  ) {
    super()
  }

  @httpPost('/authorize', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async authorize(request: Request, response: Response): Promise<void> {
    const denied = (): void => {
      response.status(403).json({
        error: {
          tag: 'collaboration-not-authorized',
          message: 'Live collaboration requires edit access to this note.',
        },
      })
    }

    try {
      // No signing secret => the realtime gateway is not configured; deny rather
      // than mint an unforgeable-looking-but-unverifiable token.
      if (!this.capabilitySecret || !isValidCollaborationCapabilityTtlSeconds(this.capabilityTtlSeconds)) {
        denied()
        return
      }

      // AuthMiddleware normalizes both a read-only account session and an
      // MCP read scope into readOnlyAccess. Check the underlying fields too so
      // capability minting remains fail-closed if a future caller constructs
      // response.locals without running that normalization.
      const session = response.locals.session as { readonly_access?: boolean } | undefined
      const mcpScope = response.locals.mcpScope as { access?: string } | undefined
      if (response.locals.readOnlyAccess === true || session?.readonly_access === true || mcpScope?.access === 'read') {
        denied()
        return
      }

      const userUuid = (response.locals.user as { uuid?: string } | undefined)?.uuid
      if (typeof userUuid !== 'string' || userUuid.length === 0) {
        denied()
        return
      }

      const noteUuid = (request.body as AuthorizeRequestBody | undefined)?.noteUuid
      if (typeof noteUuid !== 'string' || noteUuid.length === 0 || noteUuid.length > 200) {
        denied()
        return
      }
      const body = request.body as AuthorizeRequestBody
      if (body.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
        denied()
        return
      }
      const leaseRequestId = body.leaseRequestId
      const bootstrapChallenge = body.bootstrapChallenge
      if (
        (leaseRequestId !== undefined &&
          (typeof leaseRequestId !== 'string' ||
            leaseRequestId.length === 0 ||
            leaseRequestId.length > MAX_BOUND_IDENTIFIER_LENGTH)) ||
        (bootstrapChallenge !== undefined &&
          (typeof bootstrapChallenge !== 'string' ||
            bootstrapChallenge.length === 0 ||
            bootstrapChallenge.length > MAX_BOUND_IDENTIFIER_LENGTH)) ||
        (bootstrapChallenge !== undefined && leaseRequestId === undefined)
      ) {
        denied()
        return
      }

      const access = await this.checkAccessWithSyncingServer(request, response, noteUuid)
      if (!access.authorized) {
        denied()
        return
      }

      const capability = sign(
        {
          purpose: 'collab-room',
          userUuid,
          room: noteUuid,
          collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
          serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
          ...(leaseRequestId ? { leaseRequestId } : {}),
          ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
        },
        this.capabilitySecret,
        {
          algorithm: 'HS256',
          expiresIn: this.capabilityTtlSeconds,
        },
      )

      response.status(200).json({
        capability,
        room: noteUuid,
        expiresIn: this.capabilityTtlSeconds,
        serverUpdatedAtTimestamp: access.serverUpdatedAtTimestamp,
        collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
        ...(leaseRequestId ? { leaseRequestId } : {}),
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
      })
    } catch (error) {
      this.logger.error(
        'Collaboration authorize failed.',
        safeHttpErrorLogMetadata(error, {
          action: 'collaboration.authorize',
          endpoint: '/v1/collaboration/authorize',
          method: 'POST',
        }),
      )
      denied()
    }
  }

  /**
   * Ask the syncing-server (via the existing proxy, which works in both the
   * in-process home-server and the standalone HTTP deployment) whether the user
   * may access the note. We pass a CAPTURE shim as the response so we can read the
   * `{ authorized, serverUpdatedAtTimestamp }` body the syncing-server writes
   * instead of streaming it to the client. Returns an allow ONLY on a 2xx body
   * with an exact positive safe-integer revision; ANY other outcome fails closed.
   */
  private async checkAccessWithSyncingServer(
    request: Request,
    response: Response,
    noteUuid: string,
  ): Promise<CollaborationAccessCheck> {
    let capturedStatus = 0
    let capturedBody: unknown = undefined

    // Minimal Response-like shim. Both HttpServiceProxy and DirectCallServiceProxy
    // only use status()/send()/json()/setHeader() and read response.locals, so this
    // captures their output without touching the real client response.
    const captureResponse = {
      locals: response.locals,
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
      await this.serviceProxy.callSyncingServer(
        request,
        captureResponse,
        this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'items/collaboration-authorization'),
        { itemUuid: noteUuid },
      )
    } catch (error) {
      this.logger.error(
        'Collaboration access check call failed.',
        safeHttpErrorLogMetadata(error, {
          action: 'collaboration.access-check',
          endpoint: 'items/collaboration-authorization',
          method: 'POST',
        }),
      )
      return { authorized: false }
    }

    if (capturedStatus !== 0 && (capturedStatus < 200 || capturedStatus >= 300)) {
      return { authorized: false }
    }

    // The syncing-server returns the authorization and canonical revision
    // directly; the home-server proxy wraps that pair in { data, meta }.
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
