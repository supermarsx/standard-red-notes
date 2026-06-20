import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { McpTokensController } from '../../../Controller/McpTokensController'
import { BaseHttpController, results } from 'inversify-express-utils'
import { ResponseLocals } from '../ResponseLocals'

export class BaseMcpTokensController extends BaseHttpController {
  constructor(
    protected mcpTokensController: McpTokensController,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.mcpTokens.list', this.list.bind(this))
      this.controllerContainer.register('auth.mcpTokens.create', this.create.bind(this))
      this.controllerContainer.register('auth.mcpTokens.delete', this.delete.bind(this))
      this.controllerContainer.register('auth.mcpTokens.getKeys', this.getKeys.bind(this))
      this.controllerContainer.register('auth.mcpTokens.authenticate', this.authenticate.bind(this))
    }
  }

  async list(_request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.mcpTokensController.list({
      userUuid: locals.user.uuid,
    })

    return this.json(result.data, result.status)
  }

  async create(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.mcpTokensController.create({
      userUuid: locals.user.uuid,
      label: request.body.label as string,
      scope: request.body.scope as string,
      scopeTagUuids: request.body.scopeTagUuids as string[] | undefined,
      wrappedKeys: request.body.wrappedKeys as string,
      kdfSalt: request.body.kdfSalt as string,
      kdfParams: request.body.kdfParams as string,
    })

    return this.json(result.data, result.status)
  }

  async delete(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.mcpTokensController.delete({
      userUuid: locals.user.uuid,
      mcpTokenId: request.params.mcpTokenId as string,
    })

    return this.json(result.data, result.status)
  }

  async getKeys(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.mcpTokensController.getKeys({
      userUuid: locals.user.uuid,
      mcpTokenId: request.params.mcpTokenId as string,
    })

    return this.json(result.data, result.status)
  }

  // UNAUTHENTICATED: the MCP token presented in the body IS the credential.
  async authenticate(request: Request, _response: Response): Promise<results.JsonResult> {
    const result = await this.mcpTokensController.authenticate({
      token: request.body.token as string,
      apiVersion: request.body.api as string | undefined,
      userAgent: request.headers['user-agent'] as string,
    })

    return this.json(result.data, result.status)
  }
}
