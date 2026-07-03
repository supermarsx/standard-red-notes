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
      this.controllerContainer.register('auth.appPasswords.revoke', this.revoke.bind(this))
      this.controllerContainer.register('auth.appPasswords.delete', this.deletePermanently.bind(this))
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
      expiresInDays: (request.body.expiresInDays ?? null) as number | null,
    })

    return this.json(result.data, result.status)
  }

  // Default destructive action: soft-revoke (audit trail retained).
  async revoke(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.appPasswordsController.revoke({
      userUuid: locals.user.uuid,
      appPasswordId: request.params.appPasswordId as string,
    })

    return this.json(result.data, result.status)
  }

  // Permanent hard-delete.
  async deletePermanently(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.appPasswordsController.deletePermanently({
      userUuid: locals.user.uuid,
      appPasswordId: request.params.appPasswordId as string,
    })

    return this.json(result.data, result.status)
  }
}
