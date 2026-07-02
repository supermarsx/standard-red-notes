/**
 * Standard Red Notes: push-MFA approvals (approving side).
 *
 * Pure helpers for the "pending sign-in approvals" inbox. Kept free of React /
 * application dependencies so they can be unit-tested in isolation.
 *
 * The shape mirrors the server's PendingMfaApprovalHttpProjection returned by
 * `GET /v1/pending-mfa-approvals` (see snjs ApiService.listPendingMfaApprovals):
 * one entry per untrusted device currently waiting on a 2FA approval.
 */
export type PendingMfaApproval = {
  uuid: string
  challengeId: string
  // 'pending' while awaiting a decision; 'approved' | 'denied' | 'expired' are
  // terminal. Only 'pending' entries are actionable.
  status: string
  requestingUserAgent: string
  requestingIpAddress: string | null
  createdAt: number
  expiresAt: number
}

/**
 * Best-effort human label for the requesting device derived from its
 * user-agent string. Order matters: several browsers embed other browsers'
 * tokens in their UA (Edge ships "Chrome", Chrome ships "Safari"), so the more
 * specific brand must be matched first.
 */
export const describeRequestingDevice = (userAgent: string): string => {
  const ua = (userAgent ?? '').trim()
  if (ua.length === 0) {
    return 'Unknown device'
  }

  let browser = 'Unknown browser'
  if (/Firefox\//.test(ua)) {
    browser = 'Firefox'
  } else if (/Edg\//.test(ua)) {
    browser = 'Edge'
  } else if (/OPR\/|Opera/.test(ua)) {
    browser = 'Opera'
  } else if (/Chrome\//.test(ua)) {
    browser = 'Chrome'
  } else if (/Safari\//.test(ua)) {
    browser = 'Safari'
  }

  let os = ''
  if (/Windows/.test(ua)) {
    os = 'Windows'
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    // Checked before macOS: iOS UAs also contain "Mac OS X".
    os = 'iOS'
  } else if (/Android/.test(ua)) {
    os = 'Android'
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    os = 'macOS'
  } else if (/Linux/.test(ua)) {
    os = 'Linux'
  }

  return os ? `${browser} on ${os}` : browser
}

export const formatApprovalTimestamp = (value: number): string => {
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString()
}

export const describeRequestingIpAddress = (ipAddress: string | null): string => {
  const ip = (ipAddress ?? '').trim()
  return ip.length > 0 ? ip : 'unknown IP'
}

/**
 * Single-line summary of a pending approval: which device, from where, when.
 * Used both for the inbox secondary line and for accessible labels.
 */
export const formatApprovalEntryLabel = (approval: PendingMfaApproval): string => {
  return [
    describeRequestingDevice(approval.requestingUserAgent),
    describeRequestingIpAddress(approval.requestingIpAddress),
    formatApprovalTimestamp(approval.createdAt),
  ].join(' · ')
}

/**
 * An approval is only actionable while it is still `pending` and has not passed
 * its TTL. The server enforces this too (single-use + TTL); the client filters
 * so expired/terminal rows never linger in the inbox.
 */
export const isApprovalActionable = (approval: PendingMfaApproval, now: number): boolean => {
  return approval.status === 'pending' && approval.expiresAt > now
}
