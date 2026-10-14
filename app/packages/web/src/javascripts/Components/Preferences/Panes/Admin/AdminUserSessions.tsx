import type { WebApplication } from '@/Application/WebApplication'
import type { SessionListEntry } from '@standardnotes/responses'
import { isErrorResponse } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import Button from '@/Components/Button/Button'
import {
  countSessionDevices,
  formatSessionDate,
  presentActivity,
  presentSessionActivity,
  sessionDeviceLabel,
} from '@/Components/SessionsModal/sessionPresentation'

const AdminUserSessions = ({
  application,
  userUuid,
  noteIfForbidden,
  refreshRevision = 0,
}: {
  application: WebApplication
  userUuid: string
  noteIfForbidden: (response: { status?: number }) => void
  refreshRevision?: number
}) => {
  const [snapshot, setSnapshot] = useState<{ userUuid: string; sessions: SessionListEntry[]; receivedAt: number }>()
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const response = await application.legacyApi.getAdminUserSessions(userUuid)
        if (cancelled) {
          return
        }
        noteIfForbidden(response)
        if (isErrorResponse(response) || !Array.isArray(response.data)) {
          setSnapshot(undefined)
          setError('Sessions could not be loaded. Refresh to try again.')
          return
        }
        const receivedAt = Date.now()
        setSnapshot({ userUuid, sessions: response.data, receivedAt })
        setNow(receivedAt)
      } catch {
        if (!cancelled) {
          setSnapshot(undefined)
          setError('Sessions could not be loaded. Refresh to try again.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [application, userUuid, refresh, refreshRevision, noteIfForbidden])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const sessions = snapshot?.userUuid === userUuid ? snapshot.sessions : undefined
  const receivedAt = snapshot?.receivedAt ?? now
  const activeDevices = new Set(
    (sessions ?? []).flatMap((session) =>
      (session.devices ?? [])
        .filter(
          (device) =>
            presentActivity({ ...device, activity_checked_at: session.activity_checked_at }, now, receivedAt).active,
        )
        .map((device) => device.device_id),
    ),
  ).size
  return (
    <section aria-label="User sessions and devices" className="border-border my-4 border-b pb-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Open sessions and devices</h3>
        <Button small label="Refresh sessions" disabled={loading} onClick={() => setRefresh((value) => value + 1)} />
      </div>
      <p className="text-passive-1 mt-1 text-xs">
        Open sessions are unexpired sign-ins. Activity is authenticated contact within two minutes.
      </p>
      {loading && <p role="status">Loading sessions…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {sessions && (
        <>
          <p className="mt-2 text-xs">
            {sessions.length} open sessions · {countSessionDevices(sessions)} observed devices · {activeDevices} active
            recently
          </p>
          {!sessions.length && <p>No open sessions.</p>}
          <ul className="divide-border mt-2 divide-y text-xs">
            {sessions.map((session, index) => {
              const activity = presentSessionActivity(session, now, receivedAt)
              const devices = session.devices
              const deviceCount =
                devices === undefined
                  ? 'Not reported'
                  : `${devices.length} ${devices.length === 1 ? 'profile' : 'profiles'}`
              return (
                <li key={session.uuid} className="py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <details className="min-w-0 flex-1">
                      <summary
                        className="cursor-pointer list-inside truncate font-medium"
                        aria-label={`Session ${index + 1} details: ${sessionDeviceLabel(session)}`}
                      >
                        {sessionDeviceLabel(session)}
                        {session.current ? ' · Current session' : ''}
                      </summary>
                      <div className="text-passive-1 mt-2 space-y-1 pl-3">
                        <p>
                          Signed in: {formatSessionDate(session.created_at)} · Expires:{' '}
                          {formatSessionDate(session.refresh_expiration)}
                        </p>
                        {session.ip_address && <p>IP: {session.ip_address}</p>}
                        {devices === undefined ? (
                          <p>Device observations not reported.</p>
                        ) : devices.length === 0 ? (
                          <p>No device observations yet.</p>
                        ) : (
                          <ul aria-label={`Observed profiles for session ${index + 1}`}>
                            {devices.map((device, deviceIndex) => {
                              const status = presentActivity(
                                { ...device, activity_checked_at: session.activity_checked_at },
                                now,
                                receivedAt,
                              )
                              return (
                                <li key={device.device_id}>
                                  Profile {deviceIndex + 1} · {status.statusLabel} · Last seen: {status.lastSeenText}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    </details>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 ${activity.active ? 'bg-info text-info-contrast' : 'bg-contrast text-passive-1'}`}
                    >
                      {activity.statusLabel}
                    </span>
                    <span className="text-passive-1">Last seen: {activity.lastSeenText}</span>
                    <span className="text-passive-1" aria-label={`Session ${index + 1} observed profiles`}>
                      {deviceCount}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

export default AdminUserSessions
