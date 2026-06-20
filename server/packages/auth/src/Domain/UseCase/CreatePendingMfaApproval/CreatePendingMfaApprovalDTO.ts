export interface CreatePendingMfaApprovalDTO {
  userUuid: string
  requestingUserAgent: string
  requestingIpAddress: string | null
}
