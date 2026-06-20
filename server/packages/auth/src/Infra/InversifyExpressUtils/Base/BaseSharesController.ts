import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { SharesController } from '../../../Controller/SharesController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseSharesController extends BaseHttpController {
  constructor(
    protected sharesController: SharesController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.shares.list', this.list.bind(this))
      this.controllerContainer.register('auth.shares.create', this.create.bind(this))
      this.controllerContainer.register('auth.shares.revoke', this.revoke.bind(this))
      this.controllerContainer.register('auth.shares.get', this.get.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.sharesController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.sharesController.create({
      userUuid: locals.user.uuid,
      type: request.body.type as string,
      encryptedPayload: request.body.encryptedPayload as string,
      nickname: request.body.nickname as string | null | undefined,
      oneTimeView: request.body.oneTimeView as boolean | undefined,
      viewExpiresMinutes: request.body.viewExpiresMinutes as number | null | undefined,
    })

    return this.json(result.data, result.status)
  }

  async revoke(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.sharesController.revoke({
      userUuid: locals.user.uuid,
      shareId: request.params.shareId as string,
    })

    return this.json(result.data, result.status)
  }

  // UNAUTHENTICATED: anyone with the share link id can read the opaque ciphertext.
  async get(request: Request, _response: Response): Promise<results.JsonResult> {
    const result = await this.sharesController.get({
      shareId: request.params.shareId as string,
    })

    return this.json(result.data, result.status)
  }
}
