// Transport abstraction for collaborative-editing frames. The web app backs this
// with the existing authenticated gateway WebSocket (see WebSocketsService); the
// provider unit tests back it with an in-memory loopback. Keeping the provider
// decoupled from the socket makes the CRDT logic testable headlessly.

export type CollabFrame =
  // `cap` is the short-lived signed capability the gateway requires to join.
  | { t: 'room-join'; room: string; cap?: string }
  | { t: 'room-leave'; room: string }
  | { t: 'room-sync'; room: string }
  | { t: 'yjs'; room: string; payload: string }
  | { t: 'awareness'; room: string; payload: string }
  // Standard Red Notes: an E2E-encrypted note-comment event (see WebsocketsService
  // CollaborationFrame). Carries an encrypted JSON comment payload.
  | { t: 'comment'; room: string; payload: string }
  // Gateway -> client: the join was refused.
  | { t: 'room-denied'; room: string }

export interface CollabChannel {
  isConnected(): boolean
  send(frame: CollabFrame): void
  /** Subscribe to ALL inbound frames; the provider filters by room. Returns an unsubscribe. */
  subscribe(handler: (frame: CollabFrame) => void): () => void
  /**
   * Standard Red Notes: obtain a signed capability authorizing a join to `room`
   * (the gateway requires it). Returns undefined when the server denies access or
   * the request fails; the provider then must NOT join.
   */
  authorize(room: string): Promise<string | undefined>
}
