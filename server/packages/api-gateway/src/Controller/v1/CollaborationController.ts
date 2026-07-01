import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'
import { sign } from 'jsonwebtoken'
import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

interface AuthorizeRequestBody {
  /** Note (item) uuid the client wants to collaborate on; equals the relay room id. */
  noteUuid?: string
}

/**
 * Standard Red Notes: mints a SHORT-LIVED, SIGNED capability proving that the
 * authenticated user may join the realtime collaboration room for a given note.
 *
 * Flow:
 *  1. The client opens a note for collaboration and POSTs its uuid here.
 *  2. We ask the syncing-server (single source of truth for note ownership +
 *     shared-vault membership) whether this user may access the note.
 *  3. ONLY on an explicit `authorized: true` do we mint an HS256 capability
 *     `{ purpose: 'collab-room', userUuid, room, exp }`, signed with the same
 *     secret the websocket-gateway verifies connection tokens with, so the
 *     gateway can verify the capability LOCALLY (no per-join cross-service call).
 *  4. The client presents the capability on `room-join`; the gateway rejects any
 *     join lacking a valid, matching, unexpired capability.
 *
 * FAILS CLOSED everywhere: missing/invalid input, no signing secret configured,
 * an unauthorized result, a non-2xx / unparseable syncing-server response, or any
 * thrown error all yield 403 with NO capability.
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
          message: 'You are not authorized to collaborate on this note.',
        },
      })
    }

    try {
      // No signing secret => the realtime gateway is not configured; deny rather
      // than mint an unforgeable-looking-but-unverifiable token.
      if (!this.capabilitySecret) {
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

      const authorized = await this.checkAccessWithSyncingServer(request, response, noteUuid)
      if (!authorized) {
        denied()
        return
      }

      const capability = sign(
        { purpose: 'collab-room', userUuid, room: noteUuid },
        this.capabilitySecret,
        { algorithm: 'HS256', expiresIn: this.capabilityTtlSeconds },
      )

      response.status(200).json({ capability, room: noteUuid, expiresIn: this.capabilityTtlSeconds })
    } catch (error) {
      this.logger.error(`Collaboration authorize failed: ${(error as Error).message}`)
      denied()
    }
  }

  /**
   * Ask the syncing-server (via the existing proxy, which works in both the
   * in-process home-server and the standalone HTTP deployment) whether the user
   * may access the note. We pass a CAPTURE shim as the response so we can read the
   * `{ authorized }` body the syncing-server writes instead of streaming it to the
   * client. Returns true ONLY on a 2xx body with `authorized === true`; ANY other
   * outcome (non-2xx, unparseable, missing flag, thrown error) returns false.
   */
  private async checkAccessWithSyncingServer(
    request: Request,
    response: Response,
    noteUuid: string,
  ): Promise<boolean> {
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
      this.logger.error(`Collaboration access check call failed: ${(error as Error).message}`)
      return false
    }

    if (capturedStatus !== 0 && (capturedStatus < 200 || capturedStatus >= 300)) {
      return false
    }

    // The syncing-server returns { authorized } directly; the home-server proxy
    // wraps service responses as { data: { authorized }, meta }. Handle both.
    const body = capturedBody as { authorized?: unknown; data?: { authorized?: unknown } } | undefined
    const authorized = body?.authorized ?? body?.data?.authorized

    return authorized === true
  }
}
