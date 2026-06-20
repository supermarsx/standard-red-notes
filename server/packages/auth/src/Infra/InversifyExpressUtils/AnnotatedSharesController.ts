import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { SharesController } from '../../Controller/SharesController'
import { inject } from 'inversify'
import { BaseSharesController } from './Base/BaseSharesController'

@controller('/shares')
export class AnnotatedSharesController extends BaseSharesController {
  constructor(@inject(TYPES.Auth_SharesController) override sharesController: SharesController) {
    super(sharesController)
  }

  // Authed: the signed-in user's own shares (metadata only, no ciphertext).
  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpDelete('/:shareId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async revoke(request: Request, response: Response): Promise<results.JsonResult> {
    return super.revoke(request, response)
  }

  // UNAUTHENTICATED on purpose: public read of the opaque ciphertext by link id.
  @httpGet('/:shareId')
  override async get(request: Request, response: Response): Promise<results.JsonResult> {
    return super.get(request, response)
  }
}
