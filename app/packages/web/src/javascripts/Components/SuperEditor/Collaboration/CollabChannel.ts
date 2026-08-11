// Transport abstraction for collaborative-editing frames. The web app backs this
// with the existing authenticated gateway WebSocket (see WebSocketsService); the
// provider unit tests back it with an in-memory loopback. Keeping the provider
// decoupled from the socket makes the CRDT logic testable headlessly.

export const COLLABORATION_PROTOCOL_VERSION = 2 as const
export const COLLABORATION_MAX_TRANSFER_BYTES = 4 * 1024 * 1024

export type CollabFrame =
  // `cap` is the short-lived signed capability the gateway requires to join.
  | {
      t: 'room-reserve'
      room: string
      cap: string
      requestId: string
      role: 'editor'
      protocolVersion: 2
    }
  | {
      t: 'room-join'
      room: string
      cap?: string
      requestId?: string
      role?: 'editor' | 'comment'
      protocolVersion?: 2
    }
  | { t: 'room-leave'; room: string; requestId?: string }
  | {
      t: 'room-reserved'
      room: string
      requestId: string
      bootstrap: boolean
      bootstrapChallenge?: string
      protocolVersion: 2
      maxTransferBytes: number
    }
  | {
      t: 'room-joined'
      room: string
      requestId?: string
      bootstrap?: boolean
      protocolVersion?: number
      maxTransferBytes?: number
    }
  | { t: 'room-sync'; room: string }
  | { t: 'yjs'; room: string; payload: string; transferId?: string; stateRequestId?: string }
  | {
      t: 'yjs-chunk'
      room: string
      transferId: string
      index: number
      count: number
      totalBytes: number
      payload: string
      stateRequestId?: string
    }
  | { t: 'yjs-retry'; room: string; requestId: string; requesterClientId: number }
  | { t: 'yjs-response-claim'; room: string; stateRequestId: string; leaseRequestId: string }
  | {
      t: 'yjs-response-granted'
      room: string
      stateRequestId: string
      leaseRequestId: string
      protocolVersion: 2
    }
  | { t: 'yjs-accepted'; room: string; transferId: string; protocolVersion: 2 }
  | { t: 'awareness'; room: string; payload: string }
  // Standard Red Notes: an E2E-encrypted note-comment event (see WebsocketsService
  // CollaborationFrame). Carries an encrypted JSON comment payload.
  | { t: 'comment'; room: string; payload: string }
  // Gateway -> client: the join was refused.
  | { t: 'room-denied'; room: string; requestId?: string }

export interface CollabChannel {
  isConnected(): boolean
  send(frame: CollabFrame): void
  /** Subscribe to ALL inbound frames; the provider filters by room. Returns an unsubscribe. */
  subscribe(handler: (frame: CollabFrame) => void): () => void
  /**
   * Observe transport reconnects without destroying the Y.Doc. Optional for
   * deterministic test transports that never disconnect.
   */
  subscribeStatus?(handler: (connected: boolean) => void): () => void
  /**
   * Standard Red Notes: obtain a signed capability authorizing a join to `room`
   * (the gateway requires it). Returns undefined when the server denies access or
   * the request fails; the provider then must NOT join.
   */
  authorize(room: string, leaseRequestId?: string, bootstrapChallenge?: string): Promise<string | undefined>
}

export function createCollaborationRequestId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure random UUID generation is unavailable')
  }
  return globalThis.crypto.randomUUID()
}
