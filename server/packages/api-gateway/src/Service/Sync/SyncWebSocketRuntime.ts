import { attachWebSocketGateway, type AttachedGateway, type AttachOptions } from '@standard-red-notes/websocket-gateway'
import type { IncomingMessage, ServerResponse } from 'http'

import type { RealtimeGatewayHealth } from '../Readiness/AggregateReadinessService'
import { SyncWebSocketAccessService, syncWebSocketAccessService } from './SyncWebSocketAccessService'

export type WebSocketGatewayAttach = (options: AttachOptions) => AttachedGateway

/** What an in-process mint produced, ready for a proxy's response envelope. */
export type InProcessMintResult = { statusCode: number; json: Record<string, unknown> }

/** The locals the cross-service token middleware leaves for an authenticated call. */
export type MintLocals = { user?: { uuid?: string }; session?: { uuid?: string }; authToken?: string }

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

  /**
   * Standard Red Notes (R4): mint a connection token for an ALREADY
   * AUTHENTICATED proxy call without leaving the process. The gateway's mint
   * handler authenticates the web-client path from a forwarded `x-auth-token`
   * (the cross-service token the middleware left on `locals.authToken`), so the
   * synthetic request carries exactly that and nothing from the inbound
   * request. Returns `undefined` when no gateway is attached OR the locals are
   * incomplete, so the caller can fall back to its own answer.
   */
  mintConnectionTokenFor(locals: MintLocals): InProcessMintResult | undefined {
    if (!this.provider || !locals.user?.uuid || !locals.session?.uuid || !locals.authToken) {
      return undefined
    }

    let statusCode = 500
    let json: Record<string, unknown> = { error: { message: 'Could not reach the websockets gateway.' } }
    const capture: { writeHead(status: number): unknown; end(body?: string): void } = {
      writeHead: (status: number): unknown => {
        statusCode = status
        return capture
      },
      end: (body?: string): void => {
        try {
          json = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        } catch {
          statusCode = 502
        }
      },
    }
    this.provider.handleMintToken(
      {
        headers: { 'x-auth-token': locals.authToken },
        body: { userUuid: locals.user.uuid, sessionUuid: locals.session.uuid },
      } as unknown as IncomingMessage,
      capture as unknown as ServerResponse,
    )

    return { statusCode, json }
  }

  /**
   * C9: the attached gateway's point-in-time health, for readiness and the
   * admin sync diagnostics. `undefined` when nothing is attached. Read
   * structurally so a gateway build predating `health()` still satisfies the
   * interface (it then reports as not attached, never throws).
   */
  health(): RealtimeGatewayHealth | undefined {
    const provider = this.provider as (AttachedGateway & { health?: () => RealtimeGatewayHealth }) | undefined
    return provider?.health?.()
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
