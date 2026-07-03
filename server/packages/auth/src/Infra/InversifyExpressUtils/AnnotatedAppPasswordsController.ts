import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { AppPasswordsController } from '../../Controller/AppPasswordsController'
import { inject } from 'inversify'
import { BaseAppPasswordsController } from './Base/BaseAppPasswordsController'

@controller('/app-passwords')
export class AnnotatedAppPasswordsController extends BaseAppPasswordsController {
  constructor(@inject(TYPES.Auth_AppPasswordsController) override appPasswordsController: AppPasswordsController) {
    super(appPasswordsController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  // Default DELETE soft-revokes (keeps the audit trail). Permanent removal is a
  // distinct, explicit route.
  @httpDelete('/:appPasswordId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async revoke(request: Request, response: Response): Promise<results.JsonResult> {
    return super.revoke(request, response)
  }

  @httpDelete('/:appPasswordId/permanent', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async deletePermanently(request: Request, response: Response): Promise<results.JsonResult> {
    return super.deletePermanently(request, response)
  }
}
