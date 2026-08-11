export type CollaborationAuthorizationResponseBody = {
  // Standard Red Notes: short-lived signed capability the client presents on the
  // `room-join` collaboration frame. Absent on denial (which arrives as an error
  // HTTP response).
  capability: string
  room: string
  expiresIn: number
  /** Canonical encrypted item revision observed by the authorization decision. */
  serverUpdatedAtTimestamp: number
  collaborationProtocolVersion: 2
  leaseRequestId?: string
  bootstrapChallenge?: string
}
