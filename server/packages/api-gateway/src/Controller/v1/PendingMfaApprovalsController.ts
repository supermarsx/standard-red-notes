import { inject } from 'inversify'
import { Request, Response } from 'express'
import { controller, BaseHttpController, httpGet, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

/**
 * Standard Red Notes: gateway routes for push-MFA approvals.
 *
 *  - list / resolve are behind the required cross-service token middleware (an
 *    already-authenticated, trusted session manages approvals for its account).
 *  - status is UNAUTHENTICATED: the new (untrusted) device is not signed in yet
 *    and polls using only the high-entropy, single-use challenge id.
 */
@controller('/v1/pending-mfa-approvals')
export class PendingMfaApprovalsController extends BaseHttpController {
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
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'pending-mfa-approvals/'),
      request.body,
    )
  }

  @httpPost('/:challengeId/resolve', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async resolve(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'POST',
        'pending-mfa-approvals/:challengeId/resolve',
        request.params.challengeId as string,
      ),
      request.body,
    )
  }

  @httpGet('/:challengeId/status')
  async status(request: Request, response: Response): Promise<void> {
    await this.httpService.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'pending-mfa-approvals/:challengeId/status',
        request.params.challengeId as string,
      ),
      request.body,
    )
  }
}
