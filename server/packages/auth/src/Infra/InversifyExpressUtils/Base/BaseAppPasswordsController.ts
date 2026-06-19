import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { AppPasswordsController } from '../../../Controller/AppPasswordsController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseAppPasswordsController extends BaseHttpController {
  constructor(
    protected appPasswordsController: AppPasswordsController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.appPasswords.list', this.list.bind(this))
      this.controllerContainer.register('auth.appPasswords.create', this.create.bind(this))
      this.controllerContainer.register('auth.appPasswords.delete', this.delete.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.appPasswordsController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.appPasswordsController.create({
      userUuid: locals.user.uuid,
      label: request.body.label as string,
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.appPasswordsController.delete({
      userUuid: locals.user.uuid,
      appPasswordId: request.params.appPasswordId as string,
    })

    return this.json(result.data, result.status)
  }
}
