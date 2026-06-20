import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpDelete, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for MCP scoped tokens. The list/create/
 * delete/keys routes proxy to the auth server's `/mcp-tokens` controller behind
 * the required cross-service token middleware so the auth server receives the
 * authenticated user on `response.locals.user`.
 *
 * The `/authenticate` route is intentionally UNAUTHENTICATED: the MCP token in
 * the request body IS the credential. It proxies to the auth server which mints
 * a real session (bypassing SRP) and returns the session payload plus the
 * client-wrapped key material in one round-trip.
 */
@controller('/v1/mcp-tokens')
export class McpTokensController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'mcp-tokens/'),
      request.body,
    )
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'mcp-tokens/'),
      request.body,
    )
  }

  @httpDelete('/:mcpTokenId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async delete(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'mcp-tokens/:mcpTokenId',
        request.params.mcpTokenId as string,
      ),
      request.body,
    )
  }

  @httpGet('/keys/:mcpTokenId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getKeys(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'mcp-tokens/keys/:mcpTokenId',
        request.params.mcpTokenId as string,
      ),
      request.body,
    )
  }

  // UNAUTHENTICATED on purpose: the MCP token in the body is the credential.
  @httpPost('/authenticate')
  async authenticate(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'mcp-tokens/authenticate'),
      request.body,
    )
  }
}
