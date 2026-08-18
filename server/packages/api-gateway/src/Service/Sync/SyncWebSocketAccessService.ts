import type {
  SyncCapabilityResponse,
  SyncGatewayAccess,
  SyncTicketIdentity,
  SyncTicketResponse,
} from '@standard-red-notes/websocket-gateway'

export class SyncWebSocketUnavailableError extends Error {
  constructor() {
    super('WebSocket sync is unavailable.')
    this.name = 'SyncWebSocketUnavailableError'
  }
}

/**
 * Late-bound bridge between controllers (registered before app.build()) and
 * the gateway (attached to the owned http.Server before listen). Absence is an
 * intentional fail-closed state and is what rolling deploys/kill-switches
 * advertise to old clients.
 */
export class SyncWebSocketAccessService {
  private provider?: SyncGatewayAccess

  setProvider(provider: SyncGatewayAccess): void {
    this.provider = provider
  }

  clearProvider(provider?: SyncGatewayAccess): void {
    if (provider === undefined || this.provider === provider) {
      this.provider = undefined
    }
  }

  capabilities(): SyncCapabilityResponse {
    return this.provider?.capabilities() ?? { capabilities: [] }
  }

  async issueTicket(identity: SyncTicketIdentity): Promise<SyncTicketResponse> {
    if (!this.provider || this.capabilities().capabilities.length === 0) {
      throw new SyncWebSocketUnavailableError()
    }
    return this.provider.issueTicket(identity)
  }
}

export const syncWebSocketAccessService = new SyncWebSocketAccessService()
