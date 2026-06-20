import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { TrustedDevicesController } from '../../Controller/TrustedDevicesController'
import { inject } from 'inversify'
import { BaseTrustedDevicesController } from './Base/BaseTrustedDevicesController'

@controller('/trusted-devices')
export class AnnotatedTrustedDevicesController extends BaseTrustedDevicesController {
  constructor(
    @inject(TYPES.Auth_TrustedDevicesController) override trustedDevicesController: TrustedDevicesController,
  ) {
    super(trustedDevicesController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpDelete('/:deviceId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }
}
