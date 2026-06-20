import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { TrustedDevicesController } from '../../../Controller/TrustedDevicesController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseTrustedDevicesController extends BaseHttpController {
  constructor(
    protected trustedDevicesController: TrustedDevicesController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.trustedDevices.list', this.list.bind(this))
      this.controllerContainer.register('auth.trustedDevices.create', this.create.bind(this))
      this.controllerContainer.register('auth.trustedDevices.delete', this.delete.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.trustedDevicesController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    // Derive a sensible default label from the session's device info when the
    // client does not provide one explicitly.
    const fallbackLabel = locals.session?.device_info ?? 'Trusted device'

    const result = await this.trustedDevicesController.create({
      userUuid: locals.user.uuid,
      label: (request.body.label as string | undefined)?.trim() || fallbackLabel,
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.trustedDevicesController.delete({
      userUuid: locals.user.uuid,
      deviceId: request.params.deviceId as string,
    })

    return this.json(result.data, result.status)
  }
}
