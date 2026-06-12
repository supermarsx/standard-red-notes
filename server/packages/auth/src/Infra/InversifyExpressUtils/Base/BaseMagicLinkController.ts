import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { BaseHttpController, results } from 'inversify-express-utils'

import { MagicLinkController } from '../../../Controller/MagicLinkController'
import { ResponseLocals } from '../ResponseLocals'

export class BaseMagicLinkController extends BaseHttpController {
  constructor(
    protected magicLinkController: MagicLinkController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.magicLink.request', this.request.bind(this))
      this.controllerContainer.register('auth.magicLink.setStatus', this.setStatus.bind(this))
      this.controllerContainer.register('auth.magicLink.getStatus', this.getStatus.bind(this))
    }
  }

  async getStatus(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.magicLinkController.getStatus({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async request(request: Request): Promise<results.JsonResult> {
    const result = await this.magicLinkController.request({
      email: request.body.email ?? request.body.username,
    })

    return this.json(result.data, result.status)
  }

  async setStatus(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.magicLinkController.setStatus({
      userUuid: locals.user.uuid,
      enabled: request.body.enabled === true || request.body.enabled === 'true',
    })

    return this.json(result.data, result.status)
  }
}
