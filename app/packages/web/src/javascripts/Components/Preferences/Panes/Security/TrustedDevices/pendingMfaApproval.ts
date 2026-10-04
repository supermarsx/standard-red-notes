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
/**
 * Safety-net poll cadences, shared by BOTH consumers of the inbox — the app-wide
 * `PendingMfaApprovalsNotifier` and the Security pane's inbox — so there is a
 * single answer to "how long may a lost push go unnoticed".
 *
 * They live in this dependency-free module rather than in the notifier because the
 * pane importing the notifier would drag `WebApplication` into its module graph for
 * the sake of two numbers.
 *
 * WHY A POLL REMAINS AT ALL. Both frames (`MFA_APPROVAL_REQUESTED` on creation,
 * `MFA_APPROVAL_RESOLVED` on the decision) are best-effort: the server does not
 * retry a frame the legacy push lane dropped, a half-open socket still reports
 * OPEN, and desktop, mobile and any deployment without a gateway have no push lane
 * at all — there the poll IS the delivery path. So the socket shortens the cadence's
 * job to lost-push recovery; it never removes it.
 */

/** Cadence while the push lane is OPEN: lost-push recovery only. Approvals live ~2 min. */
export const PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS = 120_000

/** Cadence with no push lane: the poll is the only delivery path. */
export const PENDING_MFA_APPROVALS_POLL_INTERVAL_MS = 20_000

/** Minimum spacing between a visibility-triggered poll and whatever poll ran before it. */
export const PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS = 5_000

/**
 * The cadence to use right now. A single function so the pane and the notifier
 * cannot drift into disagreeing about what an open socket buys.
 */
export const pendingMfaApprovalsPollIntervalMs = (socketOpen: boolean): number => {
  return socketOpen ? PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS : PENDING_MFA_APPROVALS_POLL_INTERVAL_MS
}

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
