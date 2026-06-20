export interface ResolvePendingMfaApprovalDTO {
  // The authenticated trusted session's user. Used to enforce that a session can
  // only resolve approvals for its OWN account.
  userUuid: string
  challengeId: string
  approve: boolean
}
