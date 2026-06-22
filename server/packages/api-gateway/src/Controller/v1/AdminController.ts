import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, httpPut } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for the in-app admin panel. These proxy to
 * the auth server's `/admin` controller. They are protected by the required
 * cross-service token middleware so the auth server receives the decoded roles
 * on `response.locals.roles`, where the controller enforces the
 * INTERNAL_TEAM_USER role. The proxied endpoints themselves only expose the
 * per-user feature-flag setters/getters (never the broader unprotected admin
 * routes).
 */
@controller('/v1/admin')
export class AdminController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpGet('/lookup-user/:email', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async lookupUser(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/lookup-user/:email',
        request.params.email as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserFeatureFlags(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserFeatureFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:email/ban-status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserBanStatus(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:email/ban-status',
        request.params.email as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/ban-status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserBanStatus(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/ban-status',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/registration'),
      request.body,
    )
  }

  @httpPut('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('PUT', 'admin/registration'),
      request.body,
    )
  }

  @httpGet('/audit-log', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getAuditLog(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/audit-log'),
      request.body,
    )
  }

  @httpGet('/roles', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getAvailableRoles(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/roles'),
      request.body,
    )
  }

  @httpGet('/groups', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listGroups(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/groups'),
      request.body,
    )
  }

  @httpPost('/groups', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async createGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'admin/groups'),
      request.body,
    )
  }

  @httpDelete('/groups/:groupUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async deleteGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/groups/:groupUuid',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/groups/:groupUuid/roles', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setGroupRoles(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/groups/:groupUuid/roles',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/groups/:groupUuid/members', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listGroupMembers(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/groups/:groupUuid/members',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpPost('/groups/:groupUuid/members', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async addUserToGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'POST',
        'admin/groups/:groupUuid/members',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpDelete('/groups/:groupUuid/members/:userUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async removeUserFromGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/groups/:groupUuid/members/:userUuid',
        request.params.groupUuid as string,
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:userUuid/effective-permissions', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserEffectivePermissions(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:userUuid/effective-permissions',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }
}
