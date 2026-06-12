import { Request, Response } from 'express'
import { controller, httpGet, httpPost, results } from 'inversify-express-utils'
import { inject } from 'inversify'

import TYPES from '../../Bootstrap/Types'
import { MagicLinkController } from '../../Controller/MagicLinkController'
import { BaseMagicLinkController } from './Base/BaseMagicLinkController'

@controller('/mfa/magic-link')
export class AnnotatedMagicLinkController extends BaseMagicLinkController {
  constructor(@inject(TYPES.Auth_MagicLinkController) override magicLinkController: MagicLinkController) {
    super(magicLinkController)
  }

  @httpPost('/request')
  override async request(request: Request): Promise<results.JsonResult> {
    return super.request(request)
  }

  @httpPost('/status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async setStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.setStatus(request, response)
  }

  @httpGet('/status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getStatus(request, response)
  }
}
