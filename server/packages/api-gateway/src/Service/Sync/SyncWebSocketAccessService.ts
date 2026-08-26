import type {
  SyncCapabilityResponse,
  SyncGatewayAccess,
  SyncTicketIdentity,
  SyncTicketResponse,
  SyncUnavailabilityReason,
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

  /**
   * Standard Red Notes: the gateway's own LIVE reasons for refusing a ticket, as
   * the closed enum it already maintains for its refusal logs. Exposed for the
   * admin diagnostics endpoint, which pairs these with the boot-time gate record
   * — the gate says why the lane was never built, these say why a lane that WAS
   * built is refusing right now (stopping, a store that went away, an adapter
   * that dropped). Never surfaced to unauthenticated callers.
   *
   * A provider predating `unavailabilityReasons` reports the single reason the
   * capability list already implies, so callers never have to special-case it.
   */
  unavailabilityReasons(): readonly SyncUnavailabilityReason[] {
    if (!this.provider) {
      return ['sync-not-configured']
    }

    return this.provider.unavailabilityReasons?.() ?? (this.capabilities().capabilities.length === 0 ? ['sync-not-configured'] : [])
  }

  async issueTicket(identity: SyncTicketIdentity): Promise<SyncTicketResponse> {
    if (!this.provider || this.capabilities().capabilities.length === 0) {
      throw new SyncWebSocketUnavailableError()
    }
    return this.provider.issueTicket(identity)
  }
}

export const syncWebSocketAccessService = new SyncWebSocketAccessService()
