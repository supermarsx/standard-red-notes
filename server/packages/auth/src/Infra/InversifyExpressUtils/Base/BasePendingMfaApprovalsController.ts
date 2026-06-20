import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { PendingMfaApprovalsController } from '../../../Controller/PendingMfaApprovalsController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BasePendingMfaApprovalsController extends BaseHttpController {
  constructor(
    protected pendingMfaApprovalsController: PendingMfaApprovalsController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.pendingMfaApprovals.list', this.list.bind(this))
      this.controllerContainer.register('auth.pendingMfaApprovals.resolve', this.resolve.bind(this))
      this.controllerContainer.register('auth.pendingMfaApprovals.status', this.status.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.pendingMfaApprovalsController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async resolve(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.pendingMfaApprovalsController.resolve({
      userUuid: locals.user.uuid,
      challengeId: request.params.challengeId as string,
      approve: request.body.approve === true,
    })

    return this.json(result.data, result.status)
  }

  // Unauthenticated status poll for the new device. No ResponseLocals.user.
  async status(request: Request): Promise<results.JsonResult> {
    const result = await this.pendingMfaApprovalsController.status({
      challengeId: request.params.challengeId as string,
    })

    return this.json(result.data, result.status)
  }
}
