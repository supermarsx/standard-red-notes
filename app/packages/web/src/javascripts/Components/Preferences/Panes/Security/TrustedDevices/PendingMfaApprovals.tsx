import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse, WebSocketsServiceEvent } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import {
  describeRequestingDevice,
  describeRequestingIpAddress,
  formatApprovalTimestamp,
  isApprovalActionable,
  pendingMfaApprovalsPollIntervalMs,
  PENDING_MFA_APPROVALS_POLL_INTERVAL_MS,
  PendingMfaApproval,
} from './pendingMfaApproval'

type Props = {
  application: WebApplication
}

/**
 * Poll cadence. This inbox used to re-GET `/v1/pending-mfa-approvals` every 6 s for
 * as long as the pane was open, regardless of whether a websocket was delivering the
 * very events it was looking for. Every state change it polled for is now announced:
 *
 *  - a NEW request    -> MFA_APPROVAL_REQUESTED (auth CreatePendingMfaApproval);
 *  - a DECISION taken
 *    in another session -> MFA_APPROVAL_RESOLVED (auth ResolvePendingMfaApproval);
 *  - EXPIRY            -> not an event at all. `expiresAt` is already known for every
 *    row, so a local clock tick retires it with no request whatsoever.
 *
 * So the poll drops to the same lost-push safety net the app-wide notifier runs
 * (`pendingMfaApprovalsPollIntervalMs`), re-evaluated on every tick so a socket that
 * closes mid-interval is picked up at the next short tick rather than after a full
 * long one. The cadence is SHARED with the notifier deliberately: two different
 * answers to "how long may a lost push go unnoticed" is a bug waiting to happen.
 *
 * DEGRADATION: with no push lane — desktop, mobile, any deployment where the socket
 * is off or withheld — `isWebSocketConnectionOpen()` is false and the cadence is the
 * short one, so the inbox behaves exactly as it did before the frames existed. The
 * socket is an optimisation here, never a dependency.
 */
const POLL_TICK_MS = PENDING_MFA_APPROVALS_POLL_INTERVAL_MS

/** Retiring an expired row is pure arithmetic on data already held: no request. */
const EXPIRY_TICK_MS = 1000

const PendingMfaApprovals: FunctionComponent<Props> = ({ application }: Props) => {
  const [approvals, setApprovals] = useState<PendingMfaApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [resolvingChallengeId, setResolvingChallengeId] = useState<string | null>(null)
  // If the endpoint is unavailable (feature disabled / older server), degrade
  // gracefully by hiding the whole section rather than surfacing a scary error.
  const [unavailable, setUnavailable] = useState(false)

  // Avoids a state update (and toast) after the pane has unmounted.
  const mountedRef = useRef(true)
  /** Epoch-ms of the last request that actually went out; cadences measure from here. */
  const lastLoadStartedAt = useRef(0)

  const loadApprovals = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (showSpinner && mountedRef.current) {
        setLoading(true)
      }
      lastLoadStartedAt.current = Date.now()
      try {
        const response = await application.legacyApi.listPendingMfaApprovals()
        if (!mountedRef.current) {
          return
        }
        if (isErrorResponse(response)) {
          setUnavailable(true)
          return
        }
        const data = (response as { data?: { pendingApprovals?: PendingMfaApproval[] } }).data
        const now = Date.now()
        const actionable = (data?.pendingApprovals ?? []).filter((approval) => isApprovalActionable(approval, now))
        setApprovals(actionable)
        setUnavailable(false)
      } catch (error) {
        console.error(error)
        if (mountedRef.current) {
          setUnavailable(true)
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [application],
  )

  useEffect(() => {
    mountedRef.current = true
    void loadApprovals({ showSpinner: true })

    const isSocketOpen = (): boolean => {
      try {
        return application.sockets.isWebSocketConnectionOpen()
      } catch {
        // Application still launching or tearing down: assume no push lane, which
        // only ever makes the inbox poll MORE often. Never fail closed into silence.
        return false
      }
    }

    const interval = setInterval(() => {
      if (Date.now() - lastLoadStartedAt.current < pendingMfaApprovalsPollIntervalMs(isSocketOpen())) {
        return
      }
      void loadApprovals()
    }, POLL_TICK_MS)

    // Expiry needs no network: every row already carries its own `expiresAt`.
    const expiryTick = setInterval(() => {
      if (!mountedRef.current) {
        return
      }
      const now = Date.now()
      setApprovals((current) => {
        const actionable = current.filter((approval) => isApprovalActionable(approval, now))
        return actionable.length === current.length ? current : actionable
      })
    }, EXPIRY_TICK_MS)

    // Both pushes are handled, so the poll above is pure lost-push recovery.
    const removeObserver = application.sockets.addEventObserver((event, data) => {
      if (event === WebSocketsServiceEvent.MfaApprovalRequested) {
        // A brand-new request carries no status/createdAt contract we want to trust
        // for rendering, so read the authoritative list once rather than splicing the
        // frame in. One request per request — not one every 6 s.
        void loadApprovals()
        return
      }
      if (event === WebSocketsServiceEvent.MfaApprovalResolved) {
        // A decision is fully described by the frame: drop that row, no request.
        const challengeId = (data as { challengeId?: unknown } | undefined)?.challengeId
        if (typeof challengeId !== 'string' || !mountedRef.current) {
          return
        }
        setApprovals((current) => current.filter((approval) => approval.challengeId !== challengeId))
      }
    })

    return () => {
      mountedRef.current = false
      clearInterval(interval)
      clearInterval(expiryTick)
      removeObserver()
    }
  }, [application, loadApprovals])

  const handleResolve = useCallback(
    async (approval: PendingMfaApproval, approve: boolean) => {
      setResolvingChallengeId(approval.challengeId)
      // Optimistically drop the row; the poll will reconcile if the server
      // rejects the resolution (e.g. it already expired).
      setApprovals((current) => current.filter((item) => item.challengeId !== approval.challengeId))
      try {
        const response = await application.legacyApi.resolvePendingMfaApproval(approval.challengeId, approve)
        if (isErrorResponse(response)) {
          const message =
            (response.data as { error?: { message?: string } } | undefined)?.error?.message ??
            'Failed to resolve the sign-in request.'
          addToast({ type: ToastType.Error, message })
          void loadApprovals()
          return
        }
        addToast({
          type: approve ? ToastType.Success : ToastType.Regular,
          message: approve
            ? 'Sign-in approved. The other device can now finish signing in.'
            : 'Sign-in denied. The other device was blocked.',
        })
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to resolve the sign-in request.' })
        void loadApprovals()
      } finally {
        if (mountedRef.current) {
          setResolvingChallengeId(null)
        }
      }
    },
    [application, loadApprovals],
  )

  if (unavailable) {
    return null
  }

  return (
    <PreferencesSegment>
      <Subtitle>Pending sign-in approvals</Subtitle>
      <Text className="mt-1">
        When a new, untrusted device tries to sign in to your account, it appears here so you can approve or deny it
        from this trusted session. Approve only sign-ins you recognize — approving lets that device pass the two-factor
        step. Requests expire automatically after a short window.
      </Text>

      {loading && approvals.length === 0 && <Spinner className="mt-3 h-4 w-4" />}

      {!loading && approvals.length === 0 && <Text className="mt-3">No pending sign-in requests.</Text>}

      {approvals.map((approval) => {
        const isResolving = resolvingChallengeId === approval.challengeId
        return (
          <div
            key={approval.challengeId}
            className="border-border mt-3 flex flex-col gap-2 rounded border border-solid p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-base font-medium break-words lg:text-sm">
                {describeRequestingDevice(approval.requestingUserAgent)}
              </span>
              <span className="text-passive-0 text-sm break-words lg:text-xs">
                {describeRequestingIpAddress(approval.requestingIpAddress)} · Requested{' '}
                {formatApprovalTimestamp(approval.createdAt)}
              </span>
            </div>
            <div className="flex flex-shrink-0 gap-2">
              <Button
                label="Approve"
                primary
                disabled={isResolving}
                onClick={() => void handleResolve(approval, true)}
              />
              <Button
                label="Deny"
                colorStyle="danger"
                disabled={isResolving}
                onClick={() => void handleResolve(approval, false)}
              />
            </div>
          </div>
        )
      })}
    </PreferencesSegment>
  )
}

export default observer(PendingMfaApprovals)
