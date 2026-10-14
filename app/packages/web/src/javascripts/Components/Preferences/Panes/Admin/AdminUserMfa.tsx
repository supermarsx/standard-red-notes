import type { WebApplication } from '@/Application/WebApplication'
import { isErrorResponse, type AdminUserMfaStatus } from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'
import { useEffect, useRef, useState } from 'react'
import Button from '@/Components/Button/Button'

const AdminUserMfa = ({
  application,
  userUuid,
  email,
  noteIfForbidden,
  onReset,
}: {
  application: WebApplication
  userUuid: string
  email: string
  noteIfForbidden: (response: { status?: number }) => void
  onReset?: (uuid: string) => void
}) => {
  const generation = useRef<{ active: boolean; busy: boolean } | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<{ uuid: string; status: AdminUserMfaStatus }>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const request = { active: true, busy: false }
    generation.current = request
    setLoading(true)
    setError('')
    setResetting(false)
    void (async () => {
      try {
        const response = await application.legacyApi.adminGetUserMfaStatus(userUuid)
        if (generation.current !== request || !request.active) {
          return
        }
        noteIfForbidden(response)
        if (isErrorResponse(response) || !response.data) {
          setSnapshot(undefined)
          setError('Sign-in factors could not be loaded.')
          return
        }
        setSnapshot({ uuid: userUuid, status: response.data })
      } catch {
        if (generation.current === request && request.active) {
          setSnapshot(undefined)
          setError('Sign-in factors could not be loaded.')
        }
      } finally {
        if (generation.current === request && request.active) {
          setLoading(false)
        }
      }
    })()
    return () => {
      request.active = false
    }
  }, [application, userUuid, revision, noteIfForbidden])
  const status = snapshot?.uuid === userUuid ? snapshot.status : undefined
  const reset = async () => {
    const request = generation.current
    if (!request?.active || request.busy || loading || resetting || !status) {
      return
    }
    request.busy = true
    setResetting(true)
    setError('')
    const isCurrent = () => request.active && generation.current === request
    try {
      const confirmed = await confirmDialog({
        title: 'Reset all sign-in factors',
        text: `Reset all sign-in factors for ${email}? This removes their authenticator, recovery codes and security keys, disables magic-link sign-in, revokes trusted devices and app passwords, and signs out every open session. They must sign in with their account password and enroll their factors again.`,
        confirmButtonText: 'Reset factors and sign out',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed || !isCurrent()) {
        return
      }
      const response = await application.legacyApi.adminResetAllUserFactors(userUuid)
      if (!isCurrent()) {
        return
      }
      noteIfForbidden(response)
      if (
        isErrorResponse(response) ||
        response.data?.success !== true ||
        response.data.userUuid !== userUuid ||
        response.data.scope !== 'all_factors'
      ) {
        setError('The reset could not be confirmed. Refresh the status before trying again.')
        return
      }
      setSnapshot({ uuid: userUuid, status: response.data.status })
      onReset?.(userUuid)
    } catch {
      if (isCurrent()) {
        setError('The reset could not be confirmed. Refresh the status before trying again.')
      }
    } finally {
      request.busy = false
      if (isCurrent()) {
        setResetting(false)
      }
    }
  }

  return (
    <section aria-label="User sign-in factors" className="border-border my-4 border-b pb-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Two-factor authentication and sign-in factors</h3>
        <Button
          small
          label="Refresh factors"
          disabled={loading || resetting}
          onClick={() => setRevision((value) => value + 1)}
        />
      </div>
      {loading && <p role="status">Loading sign-in factors…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {status && (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            <dt>Authenticator</dt>
            <dd>{status.totpConfigured ? 'Configured' : 'Not configured'}</dd>
            <dt>Security keys</dt>
            <dd>{status.securityKeyCount}</dd>
            <dt>Recovery codes</dt>
            <dd>{status.recoveryCodesAvailable ? 'Available' : 'None'}</dd>
            <dt>Magic-link sign-in</dt>
            <dd>{status.magicLinkEnabled ? 'Enabled' : 'Disabled'}</dd>
            <dt>Trusted devices</dt>
            <dd>{status.trustedDeviceCount}</dd>
            <dt>App passwords</dt>
            <dd>{status.appPasswordCount}</dd>
            <dt>Open sessions</dt>
            <dd>{status.openSessionCount}</dd>
          </dl>
          <Button
            className="mt-3"
            small
            colorStyle="danger"
            label="Reset all sign-in factors"
            disabled={loading || resetting}
            onClick={() => void reset()}
          />
        </>
      )}
    </section>
  )
}

export default AdminUserMfa
