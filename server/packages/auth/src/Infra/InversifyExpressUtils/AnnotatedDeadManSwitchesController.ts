import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { DeadManSwitchesController } from '../../Controller/DeadManSwitchesController'
import { inject } from 'inversify'
import { BaseDeadManSwitchesController } from './Base/BaseDeadManSwitchesController'

@controller('/dead-man-switches')
export class AnnotatedDeadManSwitchesController extends BaseDeadManSwitchesController {
  constructor(
    @inject(TYPES.Auth_DeadManSwitchesController) override deadManSwitchesController: DeadManSwitchesController,
  ) {
    super(deadManSwitchesController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpPost('/:switchId/check-in', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async checkIn(request: Request, response: Response): Promise<results.JsonResult> {
    return super.checkIn(request, response)
  }

  @httpDelete('/:switchId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }
}
