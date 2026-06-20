import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { EmailRemindersController } from '../../Controller/EmailRemindersController'
import { inject } from 'inversify'
import { BaseEmailRemindersController } from './Base/BaseEmailRemindersController'

@controller('/email-reminders')
export class AnnotatedEmailRemindersController extends BaseEmailRemindersController {
  constructor(
    @inject(TYPES.Auth_EmailRemindersController) override emailRemindersController: EmailRemindersController,
  ) {
    super(emailRemindersController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpDelete('/:reminderId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }
}
