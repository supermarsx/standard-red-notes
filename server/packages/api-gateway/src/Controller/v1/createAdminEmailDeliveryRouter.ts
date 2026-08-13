import { NextFunction, Request, RequestHandler, Response, Router } from 'express'

import { AdminEmailDeliveryService } from '../../Service/EmailDelivery/AdminEmailDeliveryService'
import { AdminEmailDeliveryAuditLogger, AdminEmailDeliveryController } from './AdminEmailDeliveryController'

export type AdminEmailDeliveryRouterOptions = {
  /** Existing session/cross-service-token middleware supplied by the parent app. */
  authenticationMiddleware?: RequestHandler
  /** Metadata-only structured audit sink. No relay ids, recipients, or provider data are logged. */
  auditLogger?: AdminEmailDeliveryAuditLogger
  /**
   * The production app keeps its annotated legacy-compatible dispatcher as the
   * single owner of POST /test. Enable this only in an isolated boundary test
   * or an embedding that does not mount AdminController.
   */
  mountTestRoute?: boolean
}

type AsyncHandler = (request: Request, response: Response) => Promise<void>

function route(handler: AsyncHandler): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next)
  }
}

/**
 * Creates the isolated `/v1/admin/email-delivery` child router. The parent owns
 * mounting and concrete service lifecycle; this boundary owns route shape,
 * authorization, validation, and redaction.
 */
export function createAdminEmailDeliveryRouter(
  service?: AdminEmailDeliveryService,
  options: AdminEmailDeliveryRouterOptions = {},
): Router {
  const router = Router()
  const controller = new AdminEmailDeliveryController(service, options.auditLogger)
  const authenticate = options.authenticationMiddleware ? [options.authenticationMiddleware] : []

  router.get('/relays', ...authenticate, route(controller.getRelays.bind(controller)))
  router.put('/relays', ...authenticate, route(controller.putRelays.bind(controller)))
  if (options.mountTestRoute === true) {
    router.post('/test', ...authenticate, route(controller.testDelivery.bind(controller)))
  }
  router.get('/queue', ...authenticate, route(controller.listQueue.bind(controller)))
  router.get('/logs', ...authenticate, route(controller.listLogs.bind(controller)))
  router.post('/queue/:id/retry', ...authenticate, route(controller.retryQueueItem.bind(controller)))
  router.delete('/queue/:id', ...authenticate, route(controller.discardQueueItem.bind(controller)))

  return router
}
