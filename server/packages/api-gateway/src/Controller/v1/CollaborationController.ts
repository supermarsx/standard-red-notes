import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'
import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { ResponseLocals } from '../ResponseLocals'
import { safeHttpErrorLogMetadata } from '../../Service/Logging/SafeLog'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import {
  CollaborationAuthorizationRequest,
  CollaborationAuthorizationService,
} from '../../Service/Sync/CollaborationAuthorizationService'

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
  private readonly authorizationService: CollaborationAuthorizationService

  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) endpointResolver: EndpointResolverInterface,
    @inject(TYPES.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET) capabilitySecret: string,
    @inject(TYPES.ApiGateway_COLLABORATION_CAPABILITY_TTL) capabilityTtlSeconds: number,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
  ) {
    super()
    this.authorizationService = new CollaborationAuthorizationService(
      serviceProxy,
      endpointResolver,
      capabilitySecret,
      capabilityTtlSeconds,
      logger,
    )
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
      const authorization = await this.authorizationService.authorize(
        request,
        response.locals as ResponseLocals,
        request.body as CollaborationAuthorizationRequest,
      )
      if (!authorization.authorized) {
        denied()
        return
      }
      const { authorized: _authorized, ...responseBody } = authorization
      response.status(200).json(responseBody)
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
}
