import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import { inject } from 'inversify'

import TYPES from '../../Bootstrap/Types'
import { WebhooksController } from '../../Controller/WebhooksController'
import { BaseWebhooksController } from './Base/BaseWebhooksController'

@controller('/webhooks')
export class AnnotatedWebhooksController extends BaseWebhooksController {
  constructor(@inject(TYPES.Auth_WebhooksController) override webhooksController: WebhooksController) {
    super(webhooksController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpDelete('/:webhookId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }
}
