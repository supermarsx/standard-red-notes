import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

@controller('/v1/items', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
export class ItemsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
  ) {
    super()
  }

  @httpPost('/')
  async sync(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'items/sync'),
      request.body,
    )
  }

  @httpPost('/check-integrity')
  async checkIntegrity(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'items/check-integrity'),
      request.body,
    )
  }

  @httpGet('/sync-command/:commandId')
  async getSyncCommandStatus(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'items/sync-command/:commandId',
        request.params.commandId as string,
      ),
      request.body,
    )
  }

  /**
   * Standard Red Notes: this account's own stored item-payload total, for the
   * admin diagnostics pane's Space block.
   *
   * DECLARED BEFORE `/:uuid`: express matches in registration order, so the bare
   * parameter route below would otherwise claim `storage-usage` and proxy it as an
   * item uuid — which the syncing server answers 404 "Item not found" to, and the
   * pane would then report a server that does not carry the figure.
   *
   * *** AND THIS PATH IS UNREACHABLE OVER THE WEBSOCKET RPC LANE, ON PURPOSE. ***
   * `/v1/items` is a forbidden family in `LoopbackSyncApiRpcAdapter` — durable
   * item sync owns its own idempotency and must never be re-entered over the
   * transport it established. So the web client reads this with
   * `httpOnlyJsonRequest`, the helper that exists for exactly that case; through
   * the lane-first helper the refusal arrives as an error the worker marks unsafe
   * to fall back from and the read fails while the deployment is perfectly
   * healthy. Mounting this outside the family was tried and is WORSE: the lane
   * then accepts the path, re-enters the gateway, and the request simply stalls
   * until the 30-second RPC deadline — measured live, twice.
   */
  @httpGet('/storage-usage')
  async getStorageUsage(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'items/storage-usage'),
      request.body,
    )
  }

  @httpGet('/:uuid')
  async getItem(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callSyncingServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'items/:uuid', request.params.uuid as string),
      request.body,
    )
  }
}
