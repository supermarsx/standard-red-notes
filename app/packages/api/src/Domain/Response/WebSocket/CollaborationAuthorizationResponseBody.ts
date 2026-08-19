export type CollaborationAuthorizationResponseBody =
  | {
      epochDiscovery: true
      room: string
      roomEpoch: string
      collaborationSecurityEpoch: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
    }
  | {
      epochDiscovery: false
      capability: string
      room: string
      expiresIn: number
      roomEpoch: string
      collaborationSecurityEpoch: string
      /** Canonical encrypted item revision observed by the authorization decision. */
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      leaseRequestId?: string
      bootstrapChallenge?: string
    }
