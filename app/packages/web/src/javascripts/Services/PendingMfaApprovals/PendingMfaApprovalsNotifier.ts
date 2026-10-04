import { WebSocketsServiceEvent, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast, dismissToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import {
  describeRequestingDevice,
  describeRequestingIpAddress,
  PENDING_MFA_APPROVALS_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS,
  pendingMfaApprovalsPollIntervalMs,
} from '@/Components/Preferences/Panes/Security/TrustedDevices/pendingMfaApproval'

/**
 * Standard Red Notes: push-MFA approvals — APP-WIDE surfacing (approving side).
 *
 * The Preferences → Security → Trusted Devices pane already shows the pending
 * sign-in-approval inbox, but only while it is open. This background service
 * makes sure a signed-in user NOTICES a new approval request wherever they are
 * in the app, by raising one toast per pending challenge with a "Review" action
 * that opens the Security preferences pane.
 *
 * Delivery:
 *  - PRIMARY — websocket. The auth server pushes an MFA_APPROVAL_REQUESTED
 *    frame to every other authenticated session the instant the approval is
 *    created (see auth CreatePendingMfaApproval), and WebSocketsService already
 *    emits it as WebSocketsServiceEvent.MfaApprovalRequested. The push is
 *    best-effort: the server does not retry a frame the legacy lane lost, and a
 *    half-open socket still reports OPEN, so an open socket is not proof of
 *    delivery.
 *  - SAFETY NET — a poll of GET /v1/pending-mfa-approvals that always runs:
 *    every 120 s while the socket is OPEN (a lost push is still recovered inside
 *    the ~2 min approval TTL), every 20 s otherwise (desktop, mobile and
 *    deployments without a gateway have no push at all, so the poll IS the
 *    delivery path), and once immediately when the tab becomes visible (5 s
 *    throttle). A hidden tab skips ticks, so an approval raised while the tab
 *    was in the background surfaces the moment the user returns. A tick is never
 *    skipped merely because the socket is OPEN.
 *
 * De-duplication: one toast per challenge id for the lifetime of the approval
 * (ids are remembered until their expiry passes, then pruned), so the websocket
 * frame and a later poll of the same approval cannot double-toast.
 *
 * Retirement: an MFA_APPROVAL_RESOLVED frame (pushed by auth ResolvePendingMfaApproval
 * once SOME trusted session answers) dismisses this session's toast for that
 * challenge, so answering on one device clears the prompt on the others without any
 * session re-reading the inbox over HTTP.
 */

/**
 * Re-exported for the existing importers; the single definition now lives beside the
 * inbox helpers so the Security pane can share it without importing this service.
 */
export {
  PENDING_MFA_APPROVALS_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_SOCKET_OPEN_POLL_INTERVAL_MS,
  PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS,
}

/** Timer granularity: every tick re-reads the socket state and polls once its cadence has elapsed. */
const POLL_TICK_MS = PENDING_MFA_APPROVALS_POLL_INTERVAL_MS

/** Retention for remembered ids when the payload carries no usable expiry. */
const DEFAULT_REMEMBER_MS = 10 * 60 * 1000

type PendingApprovalLike = {
  challengeId?: unknown
  requestingUserAgent?: unknown
  requestingIpAddress?: unknown
  expiresAt?: unknown
}

type PollTrigger = 'tick' | 'visible'

const debugLog = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.debug('[PendingMfaApprovals]', ...args)
}

export class PendingMfaApprovalsNotifier {
  private socketObserverDisposer?: () => void
  private pollTimer?: ReturnType<typeof setInterval>
  private visibilityListener?: () => void
  private polling = false
  /** Epoch-ms of the last poll that actually went out; cadences are measured from here. */
  private lastPollStartedAt: number
  /** challengeId -> epoch-ms after which the entry may be forgotten. */
  private notifiedChallengeIds = new Map<string, number>()
  /** challengeId -> the id of the toast raised for it, so a resolution can retire it. */
  private toastIdsByChallengeId = new Map<string, string>()

  constructor(private application: WebApplication) {
    this.lastPollStartedAt = Date.now()

    this.socketObserverDisposer = this.application.sockets.addEventObserver(async (event, data) => {
      if (event === WebSocketsServiceEvent.MfaApprovalRequested) {
        this.maybeNotify(data as PendingApprovalLike)
        return
      }
      if (event === WebSocketsServiceEvent.MfaApprovalResolved) {
        this.retireResolved(data as PendingApprovalLike)
      }
    })

    this.pollTimer = setInterval(() => {
      void this.pollIfDue('tick')
    }, POLL_TICK_MS)

    if (typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          void this.pollIfDue('visible')
        }
      }
      document.addEventListener('visibilitychange', this.visibilityListener)
    }
  }

  deinit(): void {
    this.socketObserverDisposer?.()
    this.socketObserverDisposer = undefined
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener)
    }
    this.visibilityListener = undefined
    this.notifiedChallengeIds.clear()
    this.toastIdsByChallengeId.clear()
    ;(this.application as unknown) = undefined
  }

  /**
   * A trusted session answered the request, so the "awaiting your approval" toast is
   * now a lie — dismiss it. The challenge id STAYS remembered: forgetting it here
   * would let the very next safety-net poll, if it still saw the row, raise the toast
   * a second time for a request that is already settled.
   */
  private retireResolved(frame: PendingApprovalLike): void {
    const challengeId = typeof frame?.challengeId === 'string' ? frame.challengeId : undefined
    if (!challengeId) {
      return
    }
    const toastId = this.toastIdsByChallengeId.get(challengeId)
    if (toastId === undefined) {
      return
    }
    this.toastIdsByChallengeId.delete(challengeId)
    dismissToast(toastId)
  }

  /**
   * Safety-net poll. A tick polls once the cadence for the CURRENT socket state
   * has elapsed since the last poll — so a socket that closes mid-interval is
   * picked up at the next 20 s tick rather than after a full 120 s — and a
   * visibility wake polls immediately unless a poll ran within the last 5 s.
   * Hidden tabs and signed-out sessions never poll.
   */
  private async pollIfDue(trigger: PollTrigger): Promise<void> {
    if (this.polling) {
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }

    let socketOpen: boolean
    try {
      socketOpen = this.application.sockets.isWebSocketConnectionOpen()
      if (!this.application.sessions.getUser()) {
        return
      }
    } catch (error) {
      // Application still launching or tearing down; try again next tick.
      void error
      return
    }

    const now = Date.now()
    const minimumSpacing =
      trigger === 'visible'
        ? PENDING_MFA_APPROVALS_VISIBILITY_POLL_THROTTLE_MS
        : pendingMfaApprovalsPollIntervalMs(socketOpen)
    if (now - this.lastPollStartedAt < minimumSpacing) {
      return
    }

    this.lastPollStartedAt = now
    this.polling = true
    try {
      const response = await this.application.legacyApi.listPendingMfaApprovals()
      if (isErrorResponse(response)) {
        // Older server / feature unavailable — stay silent (log-gated).
        debugLog('list poll returned an error response')
        return
      }
      const approvals =
        (response as { data?: { pendingApprovals?: PendingApprovalLike[] } }).data?.pendingApprovals ?? []
      for (const approval of approvals) {
        this.maybeNotify(approval)
      }
    } catch (error) {
      debugLog('list poll failed', error)
    } finally {
      this.polling = false
    }
  }

  /** Raise at most one toast per challenge id; ignore malformed/expired input. */
  private maybeNotify(approval: PendingApprovalLike): void {
    const challengeId = typeof approval?.challengeId === 'string' ? approval.challengeId : undefined
    if (!challengeId) {
      return
    }

    const now = Date.now()
    this.pruneRememberedIds(now)

    if (this.notifiedChallengeIds.has(challengeId)) {
      return
    }

    const expiresAt = typeof approval.expiresAt === 'number' ? approval.expiresAt : undefined
    if (expiresAt !== undefined && expiresAt <= now) {
      return
    }

    this.notifiedChallengeIds.set(challengeId, expiresAt ?? now + DEFAULT_REMEMBER_MS)

    const device = describeRequestingDevice(
      typeof approval.requestingUserAgent === 'string' ? approval.requestingUserAgent : '',
    )
    const ip = describeRequestingIpAddress(
      typeof approval.requestingIpAddress === 'string' ? approval.requestingIpAddress : null,
    )

    const raisedToastId = addToast({
      type: ToastType.Regular,
      title: 'New sign-in awaiting your approval',
      message: `${device} (${ip}) is trying to sign in to your account and is waiting for your approval.`,
      autoClose: false,
      actions: [
        {
          label: 'Review',
          handler: (toastId) => {
            this.toastIdsByChallengeId.delete(challengeId)
            dismissToast(toastId)
            this.application.openPreferences('security')
          },
        },
      ],
    })
    this.toastIdsByChallengeId.set(challengeId, raisedToastId)
  }

  private pruneRememberedIds(now: number): void {
    for (const [id, forgetAfter] of this.notifiedChallengeIds) {
      if (forgetAfter <= now) {
        this.notifiedChallengeIds.delete(id)
        this.toastIdsByChallengeId.delete(id)
      }
    }
  }
}
