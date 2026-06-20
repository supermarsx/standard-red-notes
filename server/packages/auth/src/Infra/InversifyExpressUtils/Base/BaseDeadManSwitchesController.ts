import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { DeadManSwitchesController } from '../../../Controller/DeadManSwitchesController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseDeadManSwitchesController extends BaseHttpController {
  constructor(
    protected deadManSwitchesController: DeadManSwitchesController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.deadManSwitches.list', this.list.bind(this))
      this.controllerContainer.register('auth.deadManSwitches.create', this.create.bind(this))
      this.controllerContainer.register('auth.deadManSwitches.checkIn', this.checkIn.bind(this))
      this.controllerContainer.register('auth.deadManSwitches.delete', this.delete.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.deadManSwitchesController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.deadManSwitchesController.create({
      userUuid: locals.user.uuid,
      recipientEmail: request.body.recipientEmail as string,
      shareUrl: request.body.shareUrl as string,
      message: request.body.message as string | null | undefined,
      intervalDays: request.body.intervalDays as number,
    })

    return this.json(result.data, result.status)
  }

  async checkIn(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.deadManSwitchesController.checkIn({
      userUuid: locals.user.uuid,
      switchId: request.params.switchId as string,
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.deadManSwitchesController.delete({
      userUuid: locals.user.uuid,
      switchId: request.params.switchId as string,
    })

    return this.json(result.data, result.status)
  }
}
