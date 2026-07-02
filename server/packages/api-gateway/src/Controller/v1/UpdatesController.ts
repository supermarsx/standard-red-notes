import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { UpdateCheckService } from '../../Service/Updates/UpdateCheckService'

/**
 * Standard Red Notes: self-hosted "Check for updates" endpoint.
 *
 * The gateway performs the outbound check against the operator-configured
 * UPDATE_CHECK_URL server-side (no client CORS/privacy leak) and caches the
 * result, so this endpoint is cheap to poll. `?force=true` (the client's manual
 * "Check for updates" button) bypasses the cache.
 *
 * Authenticated (session required) like the other feature endpoints: the check
 * spends server-side network I/O and reveals deployment metadata (the running
 * version), neither of which should be exposed to anonymous callers.
 *
 * Response shape (never throws; failures are degraded fields, not errors):
 *   { configured, currentVersion, latestVersion?, updateAvailable?,
 *     releaseUrl?, checkedAt?, error? }
 */
@controller('/v1/updates')
export class UpdatesController extends BaseHttpController {
  constructor(@inject(TYPES.ApiGateway_UpdateCheckService) private updateCheckService: UpdateCheckService) {
    super()
  }

  @httpGet('/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async status(request: Request, response: Response): Promise<void> {
    const force = `${request.query.force}` === 'true'
    response.json(await this.updateCheckService.getStatus(force))
  }
}
