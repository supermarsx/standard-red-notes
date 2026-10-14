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
        An open session is an unexpired sign-in. Activity reflects authenticated device contact within the last two
        minutes.
      </p>
      {loading && <p role="status">Loading sessions…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {sessions && (
        <>
          <p className="mt-2 text-sm">
            {sessions.length} open sessions · {countSessionDevices(sessions)} observed devices · {activeDevices} active
            recently
          </p>
          {!sessions.length && <p>No open sessions.</p>}
          <ul className="mt-2 space-y-3">
            {sessions.map((session) => {
              const activity = presentSessionActivity(session, now, receivedAt)
              return (
                <li key={session.uuid} className="border-border rounded border p-3">
                  <h4 className="font-semibold">{sessionDeviceLabel(session)}</h4>
                  <p>
                    {activity.statusLabel} · Last seen: {activity.lastSeenText}
                  </p>
                  <p className="text-passive-1 text-xs">
                    Signed in: {formatSessionDate(session.created_at)} · Session expires:{' '}
                    {formatSessionDate(session.refresh_expiration)}
                  </p>
                  {session.ip_address && <p className="text-passive-1 text-xs">IP: {session.ip_address}</p>}
                  <ul>
                    {session.devices?.map((device) => {
                      const status = presentActivity(
                        { ...device, activity_checked_at: session.activity_checked_at },
                        now,
                        receivedAt,
                      )
                      return (
                        <li key={device.device_id} className="mt-1 text-xs">
                          Device {device.device_id.slice(0, 8)} · {status.statusLabel} · Last seen:{' '}
                          {status.lastSeenText}
                        </li>
                      )
                    })}
                  </ul>
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
