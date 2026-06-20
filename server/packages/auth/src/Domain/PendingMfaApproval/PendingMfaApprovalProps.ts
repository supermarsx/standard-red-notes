export type PendingMfaApprovalStatus = 'pending' | 'approved' | 'denied'

export interface PendingMfaApprovalProps {
  userUuid: string
  // Opaque challenge id handed to the NEW (untrusted) device. It polls the
  // status endpoint with this id; it is single-use and high-entropy so it cannot
  // be guessed by another device.
  challengeId: string
  status: PendingMfaApprovalStatus
  // Context shown to the approving (trusted) session so the user can judge the
  // request. Never trust the new device blindly — show device + time + IP.
  requestingUserAgent: string
  requestingIpAddress: string | null
  createdAt: number
  // Epoch ms. After this instant the approval can no longer be approved/denied
  // or consumed, and the new device must fall back to interactive TOTP.
  expiresAt: number
  // True once the new device has consumed a terminal (approved) status. Enforces
  // single-use: a second poll after consumption returns "not found / expired".
  consumed: boolean
}
