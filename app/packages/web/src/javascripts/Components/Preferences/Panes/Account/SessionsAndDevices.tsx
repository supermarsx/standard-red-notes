import { useCallback, useEffect, useState } from 'react'
import { isErrorResponse, SessionListEntry } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import { Text, Title } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import {
  countSessionDevices,
  presentSessionActivity,
  sessionDeviceLabel,
} from '@/Components/SessionsModal/sessionPresentation'

export default function SessionsAndDevices({ application }: { application: WebApplication }) {
  const [sessions, setSessions] = useState<SessionListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [receivedAt, setReceivedAt] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.getSessions()
      if (isErrorResponse(response) || !Array.isArray(response.data)) {
        setError('Could not load sessions and devices. Try refreshing.')
      } else {
        setSessions(response.data)
        setReceivedAt(Date.now())
        setNow(Date.now())
        setError('')
      }
    } catch {
      setError('Could not load sessions and devices. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [application])
  useEffect(() => {
    void load()
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [load])
  const devicesKnown = sessions.every((session) => Array.isArray(session.devices))
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Open sessions and devices</Title>
        <Text>
          Review your sign-ins and the browser profiles or devices using them. Active recently means activity within the
          last two minutes.
        </Text>
        {loading && (
          <div role="status" className="mt-3 flex items-center gap-2">
            <Spinner className="h-3 w-3" />
            Loading sessions
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger mt-3">
            {error}
          </p>
        )}
        {!loading && !error && (
          <>
            <p className="mt-3 font-semibold">
              {sessions.length} open {sessions.length === 1 ? 'session' : 'sessions'} ·{' '}
              {devicesKnown ? `${countSessionDevices(sessions)} observed devices` : 'Device activity unavailable'}
            </p>
            {sessions.length === 0 && <p>No open sessions were returned.</p>}
            <ul className="divide-border mt-2 divide-y">
              {sessions.map((session) => {
                const activity = presentSessionActivity(session, now, receivedAt)
                return (
                  <li key={session.uuid} className="py-2">
                    <p className="font-semibold">
                      {sessionDeviceLabel(session)}
                      {session.current && ' · Current session'}
                    </p>
                    <p>
                      {activity.statusLabel} · Last seen: {activity.lastSeenText}
                    </p>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <div className="mt-3 flex flex-wrap gap-3">
          <Button label="Manage sessions and devices" onClick={() => application.openSessionsModal()} />
          <Button label="Refresh" disabled={loading} onClick={() => void load()} />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
