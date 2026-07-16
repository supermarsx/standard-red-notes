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
  PendingMfaApproval,
} from './pendingMfaApproval'

type Props = {
  application: WebApplication
}

// The pending-approval TTL is short (server default ~2 min), so a modest poll
// interval keeps the inbox fresh without hammering the endpoint. Any inbound
// websocket "approval requested" frame also triggers an immediate refresh.
const POLL_INTERVAL_MS = 6000

const PendingMfaApprovals: FunctionComponent<Props> = ({ application }: Props) => {
  const [approvals, setApprovals] = useState<PendingMfaApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [resolvingChallengeId, setResolvingChallengeId] = useState<string | null>(null)
  // If the endpoint is unavailable (feature disabled / older server), degrade
  // gracefully by hiding the whole section rather than surfacing a scary error.
  const [unavailable, setUnavailable] = useState(false)

  // Avoids a state update (and toast) after the pane has unmounted.
  const mountedRef = useRef(true)

  const loadApprovals = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (showSpinner && mountedRef.current) {
        setLoading(true)
      }
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

    const interval = setInterval(() => {
      void loadApprovals()
    }, POLL_INTERVAL_MS)

    // Refresh immediately when a new device pushes an approval request over the
    // websocket, so the inbox reacts without waiting for the next poll tick.
    const removeObserver = application.sockets.addEventObserver((event) => {
      if (event === WebSocketsServiceEvent.MfaApprovalRequested) {
        void loadApprovals()
      }
    })

    return () => {
      mountedRef.current = false
      clearInterval(interval)
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
