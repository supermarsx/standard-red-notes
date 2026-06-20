import { Request, Response } from 'express'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { McpTokensController } from '../../Controller/McpTokensController'
import { inject } from 'inversify'
import { BaseMcpTokensController } from './Base/BaseMcpTokensController'

@controller('/mcp-tokens')
export class AnnotatedMcpTokensController extends BaseMcpTokensController {
  constructor(@inject(TYPES.Auth_McpTokensController) override mcpTokensController: McpTokensController) {
    super(mcpTokensController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async create(request: Request, response: Response): Promise<results.JsonResult> {
    return super.create(request, response)
  }

  @httpDelete('/:mcpTokenId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async delete(request: Request, response: Response): Promise<results.JsonResult> {
    return super.delete(request, response)
  }

  @httpGet('/keys/:mcpTokenId', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getKeys(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getKeys(request, response)
  }

  // UNAUTHENTICATED on purpose: the MCP token itself is the credential.
  @httpPost('/authenticate')
  override async authenticate(request: Request, response: Response): Promise<results.JsonResult> {
    return super.authenticate(request, response)
  }
}
