import { Application } from 'express'
import { Container } from 'inversify'

import { TYPES } from '../Bootstrap/Types'
import { CaldavService } from '../Service/Caldav/CaldavService'
import { createCaldavRouter } from './createCaldavRouter'

/**
 * Standard Red Notes: mount the read-only CalDAV router on an Express app.
 *
 * Called from both the standalone api-gateway bootstrap (bin/server.ts) and the
 * self-hosted HomeServer setConfig, so the feature is available in either
 * deployment. The router resolves its own gating (env master switch) internally,
 * so mounting it is always safe — it 404s when the feature is off.
 *
 * Returns true if the router was mounted (it always mounts; gating is internal),
 * so callers can log it.
 */
export function registerCaldavRoutes(app: Application, container: Container): boolean {
  const service = container.get<CaldavService>(TYPES.ApiGateway_CaldavService)
  const basePath = container.get<string>(TYPES.ApiGateway_CALDAV_BASE_PATH)
  app.use(basePath, createCaldavRouter(service, { basePath }))
  return true
}
