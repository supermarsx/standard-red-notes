import { WebSocketsServiceEvent, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast, dismissToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import {
  describeRequestingDevice,
  describeRequestingIpAddress,
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
 *    emits it as WebSocketsServiceEvent.MfaApprovalRequested. This is the
 *    existing event mechanism, so no polling is needed while a socket is live.
 *  - FALLBACK — a modest poll of GET /v1/pending-mfa-approvals for deployments
 *    without a websocket server (or while the socket is down). Each tick is
 *    skipped entirely when the socket is open, the tab is hidden, or no user is
 *    signed in, so the steady-state cost is a timer no-op.
 *
 * De-duplication: one toast per challenge id for the lifetime of the approval
 * (ids are remembered until their expiry passes, then pruned), so the websocket
 * frame and a later poll of the same approval cannot double-toast.
 */

/** Fallback poll cadence. Approvals live ~2 minutes, so 45s still catches them. */
export const PENDING_MFA_APPROVALS_POLL_INTERVAL_MS = 45_000

/** Retention for remembered ids when the payload carries no usable expiry. */
const DEFAULT_REMEMBER_MS = 10 * 60 * 1000

type PendingApprovalLike = {
  challengeId?: unknown
  requestingUserAgent?: unknown
  requestingIpAddress?: unknown
  expiresAt?: unknown
}

const debugLog = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.debug('[PendingMfaApprovals]', ...args)
}

export class PendingMfaApprovalsNotifier {
  private socketObserverDisposer?: () => void
  private pollTimer?: ReturnType<typeof setInterval>
  private polling = false
  /** challengeId -> epoch-ms after which the entry may be forgotten. */
  private notifiedChallengeIds = new Map<string, number>()

  constructor(private application: WebApplication) {
    this.socketObserverDisposer = this.application.sockets.addEventObserver(async (event, data) => {
      if (event === WebSocketsServiceEvent.MfaApprovalRequested) {
        this.maybeNotify(data as PendingApprovalLike)
      }
    })

    this.pollTimer = setInterval(() => {
      void this.pollIfNeeded()
    }, PENDING_MFA_APPROVALS_POLL_INTERVAL_MS)
  }

  deinit(): void {
    this.socketObserverDisposer?.()
    this.socketObserverDisposer = undefined
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.notifiedChallengeIds.clear()
    ;(this.application as unknown) = undefined
  }

  /**
   * Fallback path only: skipped when the websocket is delivering frames, the
   * tab is hidden, or there is no signed-in session to authenticate the call.
   */
  private async pollIfNeeded(): Promise<void> {
    if (this.polling) {
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }

    try {
      if (this.application.sockets.isWebSocketConnectionOpen()) {
        return
      }
      if (!this.application.sessions.getUser()) {
        return
      }
    } catch (error) {
      // Application still launching or tearing down; try again next tick.
      void error
      return
    }

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

    addToast({
      type: ToastType.Regular,
      title: 'New sign-in awaiting your approval',
      message: `${device} (${ip}) is trying to sign in to your account and is waiting for your approval.`,
      autoClose: false,
      actions: [
        {
          label: 'Review',
          handler: (toastId) => {
            dismissToast(toastId)
            this.application.openPreferences('security')
          },
        },
      ],
    })
  }

  private pruneRememberedIds(now: number): void {
    for (const [id, forgetAfter] of this.notifiedChallengeIds) {
      if (forgetAfter <= now) {
        this.notifiedChallengeIds.delete(id)
      }
    }
  }
}
