import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { EmailRemindersController } from '../../../Controller/EmailRemindersController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseEmailRemindersController extends BaseHttpController {
  constructor(
    protected emailRemindersController: EmailRemindersController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.emailReminders.list', this.list.bind(this))
      this.controllerContainer.register('auth.emailReminders.create', this.create.bind(this))
      this.controllerContainer.register('auth.emailReminders.delete', this.delete.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.emailRemindersController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.emailRemindersController.create({
      userUuid: locals.user.uuid,
      dueAt: request.body.dueAt as number | string,
      message: request.body.message as string,
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.emailRemindersController.delete({
      userUuid: locals.user.uuid,
      reminderId: request.params.reminderId as string,
    })

    return this.json(result.data, result.status)
  }
}
