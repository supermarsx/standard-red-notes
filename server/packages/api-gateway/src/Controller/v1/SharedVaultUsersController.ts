import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPatch, httpPost } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

@controller('/v1/shared-vaults/:sharedVaultUuid/users', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
export class SharedVaultUsersController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private httpService: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpGet('/')
  async getSharedVaultUsers(request: Request, response: Response): Promise<void> {
    await this.httpService.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'shared-vaults/:sharedVaultUuid/users',
        request.params.sharedVaultUuid as string,
      ),
      request.body,
    )
  }

  @httpDelete('/:userUuid')
  async removeUserFromSharedVault(request: Request, response: Response): Promise<void> {
    await this.httpService.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'shared-vaults/:sharedVaultUuid/users/:userUuid',
        request.params.sharedVaultUuid as string,
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  /**
   * The body is forwarded EXPLICITLY as the fourth argument, which is the only reason it
   * arrives on the single container: `DirectCallServiceProxy` does not read the Express
   * request's parsed body, it merges the payload it is handed. A proxy method declared
   * with fewer parameters than `ServiceProxyInterface` discards it silently and
   * TypeScript permits that -- which is how collaboration came to deny a note's own
   * owner. Verified here by behaviour (a PATCH with `{ permission: 'write' }` really
   * changes the row through the bundled container), not by the signature.
   */
  @httpPatch('/:userUuid')
  async updateSharedVaultUserPermission(request: Request, response: Response): Promise<void> {
    await this.httpService.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PATCH',
        'shared-vaults/:sharedVaultUuid/users/:userUuid',
        request.params.sharedVaultUuid as string,
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPost('/:userUuid/designate-survivor')
  async designateSurvivor(request: Request, response: Response): Promise<void> {
    await this.httpService.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'POST',
        'shared-vaults/:sharedVaultUuid/users/:userUuid/designate-survivor',
        request.params.sharedVaultUuid as string,
        request.params.userUuid as string,
      ),
      request.body,
    )
  }
}
