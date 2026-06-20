export interface PendingMfaApprovalHttpProjection {
  uuid: string
  challengeId: string
  status: string
  requestingUserAgent: string
  requestingIpAddress: string | null
  createdAt: number
  expiresAt: number
}
