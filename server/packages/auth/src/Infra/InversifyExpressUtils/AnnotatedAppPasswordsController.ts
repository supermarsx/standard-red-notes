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

  @httpDelete('/:appPasswordId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }
}
