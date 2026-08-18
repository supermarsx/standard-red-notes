import { attachWebSocketGateway, type AttachedGateway, type AttachOptions } from '@standard-red-notes/websocket-gateway'
import type { IncomingMessage, ServerResponse } from 'http'

import { SyncWebSocketAccessService, syncWebSocketAccessService } from './SyncWebSocketAccessService'

export type WebSocketGatewayAttach = (options: AttachOptions) => AttachedGateway

export class WebSocketGatewayAccessService {
  private provider: AttachedGateway | undefined

  setProvider(provider: AttachedGateway): void {
    this.provider = provider
  }

  clearProvider(provider?: AttachedGateway): void {
    if (!provider || this.provider === provider) {
      this.provider = undefined
    }
  }

  mintConnectionToken(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.provider) {
      return false
    }
    this.provider.handleMintToken(request, response)
    return true
  }
}

export const webSocketGatewayAccessService = new WebSocketGatewayAccessService()

/**
 * One lifecycle owner for both standalone api-gateway and bundled HomeServer.
 * The HTTP controller only receives a provider after every gateway subsystem
 * attached successfully. During shutdown it withdraws capability/ticket access
 * before draining sockets, allowing the caller to close HTTP only afterwards.
 */
export class SyncWebSocketRuntime {
  private gateway: AttachedGateway | undefined
  private stopPromise: Promise<void> | undefined

  constructor(
    private readonly accessService: SyncWebSocketAccessService = syncWebSocketAccessService,
    private readonly attachGateway: WebSocketGatewayAttach = attachWebSocketGateway,
    private readonly gatewayAccessService: WebSocketGatewayAccessService = webSocketGatewayAccessService,
  ) {}

  attach(options: AttachOptions): AttachedGateway {
    if (this.gateway || this.stopPromise) {
      throw new Error('WebSocket gateway runtime is already active or stopping.')
    }

    const gateway = this.attachGateway(options)
    this.gateway = gateway
    this.accessService.setProvider(gateway.sync)
    this.gatewayAccessService.setProvider(gateway)
    return gateway
  }

  isActive(): boolean {
    return this.gateway !== undefined || this.stopPromise !== undefined
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    const gateway = this.gateway
    if (!gateway) {
      return
    }

    this.gateway = undefined
    this.accessService.clearProvider(gateway.sync)
    this.gatewayAccessService.clearProvider(gateway)
    this.stopPromise = gateway.stop()
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = undefined
    }
  }
}
