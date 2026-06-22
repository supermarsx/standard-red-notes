import { ControllerContainerInterface, RoleName } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Role } from '@standardnotes/security'
import { BaseHttpController, results } from 'inversify-express-utils'

import { WebhooksController } from '../../../Controller/WebhooksController'
import { ResponseLocals } from '../ResponseLocals'

export class BaseWebhooksController extends BaseHttpController {
  constructor(
    protected webhooksController: WebhooksController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.webhooks.list', this.list.bind(this))
      this.controllerContainer.register('auth.webhooks.create', this.create.bind(this))
      this.controllerContainer.register('auth.webhooks.delete', this.delete.bind(this))
    }
  }

  // INTERNAL_TEAM_USER is required for global webhooks and to list/delete
  // across users. Mirrors BaseAdminController.requestorIsAdmin.
  protected requestorIsAdmin(response: Response): boolean {
    const roles = ((response.locals as { roles?: Role[] } | undefined)?.roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.InternalTeamUser)
  }

  private clientIp(request: Request): string | undefined {
    return (request.headers['x-forwarded-for'] as string | undefined) ?? request.ip
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.webhooksController.list({
      userUuid: locals.user.uuid,
      isAdmin: this.requestorIsAdmin(response),
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.webhooksController.create({
      userUuid: locals.user.uuid,
      isAdmin: this.requestorIsAdmin(response),
      targetUrl: request.body.targetUrl as string,
      events: (request.body.events as string[]) ?? [],
      global: request.body.global as boolean | undefined,
      ip: this.clientIp(request),
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.webhooksController.delete({
      userUuid: locals.user.uuid,
      isAdmin: this.requestorIsAdmin(response),
      webhookId: request.params.webhookId as string,
      ip: this.clientIp(request),
    })

    return this.json(result.data, result.status)
  }
}
