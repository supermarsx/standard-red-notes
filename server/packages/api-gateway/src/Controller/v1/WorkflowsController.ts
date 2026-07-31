import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { WorkflowsService } from '../../Service/Workflows/WorkflowsService'

/**
 * Authenticated discovery endpoint for an operator-managed n8n service.
 *
 * SRN gates whether the link is visible. It does not authenticate the user to
 * n8n, provision an n8n user/project, proxy n8n traffic, or revoke n8n access.
 * The external service is responsible for all of those security decisions.
 */
@controller('/v1/workflows')
export class WorkflowsController extends BaseHttpController {
  constructor(@inject(TYPES.ApiGateway_WorkflowsService) private workflowsService: WorkflowsService) {
    super()
  }

  @httpGet('/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async status(_request: Request, response: Response): Promise<void> {
    const accountEnabled = this.userEnabled(response)
    const link = await this.workflowsService.resolveLink()
    const enabled = accountEnabled && link.enabled

    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.json({
      enabled,
      available: enabled && link.publicUrl !== null,
      publicUrl: enabled ? link.publicUrl : null,
      configurationError: enabled && link.configurationError,
      authentication: 'n8n',
    })
  }

  private userEnabled(response: Response): boolean {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return false
    }
    const raw = settings[SettingName.NAMES.WorkflowsEnabled]
    return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
  }
}
