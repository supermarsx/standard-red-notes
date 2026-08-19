import { Request, Response } from 'express'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { isSyncDeviceId } from '@standard-red-notes/websocket-gateway'

import { TYPES } from '../../Bootstrap/Types'
import { ResponseLocals } from '../ResponseLocals'
import {
  SyncWebSocketUnavailableError,
  syncWebSocketAccessService,
} from '../../Service/Sync/SyncWebSocketAccessService'

@controller('/v1/sockets/sync')
export class SyncWebSocketController extends BaseHttpController {
  /**
   * Deliberately unauthenticated: clients negotiate the sync transport before
   * they hold a session, and the payload is the static protocol descriptor
   * (`id`/`version`/`endpoint`), empty while sync is unavailable. Never return
   * anything derived from the request or from a user, vault or subscription
   * here — the allowlist in `Controller/RouteDispatch.spec.ts` pins this route
   * as public on exactly that basis. Access itself is granted by `/ticket`.
   */
  @httpGet('/capabilities')
  capabilities(_request: Request, response: Response): void {
    response.status(200).send(syncWebSocketAccessService.capabilities())
  }

  @httpPost('/ticket', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async ticket(request: Request, response: Response): Promise<void> {
    const deviceId = request.body?.deviceId
    if (!isSyncDeviceId(deviceId)) {
      response.status(400).send({ error: { code: 'INVALID_DEVICE' } })
      return
    }

    const locals = response.locals as ResponseLocals
    const authorization = request.headers.authorization
    if (
      !locals.user?.uuid ||
      !locals.session?.uuid ||
      typeof authorization !== 'string' ||
      authorization.length === 0
    ) {
      response.status(401).send({ error: { code: 'AUTH_REJECTED' } })
      return
    }

    try {
      const ticket = await syncWebSocketAccessService.issueTicket({
        userUuid: locals.user.uuid,
        sessionUuid: locals.session.uuid,
        deviceId,
        authorization,
      })
      response.status(200).send(ticket)
    } catch (error) {
      if (error instanceof SyncWebSocketUnavailableError) {
        response.status(503).send({ error: { code: 'SYNC_DISABLED' } })
        return
      }
      throw error
    }
  }
}
