import {
  SNApplication,
  SessionStrings,
  UuidString,
  SessionListEntry,
  isErrorResponse,
  getErrorFromErrorResponse,
} from '@standardnotes/snjs'
import { FunctionComponent, useState, useEffect, useRef, useMemo } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { observer } from 'mobx-react-lite'
import Spinner from '@/Components/Spinner/Spinner'
import Button from '@/Components/Button/Button'
import Icon from '../Icon/Icon'
import Modal, { ModalAction } from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import AlertDialog from '../AlertDialog/AlertDialog'
import {
  countSessionDevices,
  formatSessionDate,
  presentActivity,
  presentSessionActivity,
  sessionDeviceLabel,
} from './sessionPresentation'

type Session = SessionListEntry & {
  revoking?: true
}

function useSessions(
  application: SNApplication,
): [Session[], () => void, boolean, (uuid: UuidString) => Promise<void>, string, number] {
  const [sessions, setSessions] = useState<Session[]>([])
  const [lastRefreshDate, setLastRefreshDate] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [receivedAt, setReceivedAt] = useState(Date.now())

  useEffect(() => {
    ;(async () => {
      setRefreshing(true)

      const response = await application.getSessions()
      if (isErrorResponse(response)) {
        if (response.data?.error?.message) {
          setErrorMessage(response.data?.error.message)
        } else {
          setErrorMessage('An unknown error occured while loading sessions.')
        }
      } else {
        const sessions = response.data as SessionListEntry[]
        setSessions(sessions)
        setReceivedAt(Date.now())
        setErrorMessage('')
      }

      setRefreshing(false)
    })().catch(() => {
      setErrorMessage('Could not load sessions. Try refreshing.')
      setRefreshing(false)
    })
  }, [application, lastRefreshDate])

  function refresh() {
    setLastRefreshDate((previous) => previous + 1)
  }

  async function revokeSession(uuid: UuidString) {
    const sessionsBeforeRevoke = sessions

    const responsePromise = Promise.resolve()
      .then(() => application.revokeSession(uuid))
      .catch(() => {
        setErrorMessage('Could not revoke the session. Try again.')
        return undefined
      })

    const sessionsDuringRevoke = sessions.slice()
    const toRemoveIndex = sessions.findIndex((session) => session.uuid === uuid)
    sessionsDuringRevoke[toRemoveIndex] = {
      ...sessionsDuringRevoke[toRemoveIndex],
      revoking: true,
    }
    setSessions(sessionsDuringRevoke)

    const response = await responsePromise
    if (!response) {
      setSessions(sessionsBeforeRevoke)
    } else if (isErrorResponse(response)) {
      setErrorMessage(
        getErrorFromErrorResponse(response).message || 'An unknown error occured while revoking the session.',
      )

      setSessions(sessionsBeforeRevoke)
    } else {
      setSessions(response.data)
      setReceivedAt(Date.now())
    }
  }

  return [sessions, refresh, refreshing, revokeSession, errorMessage, receivedAt]
}

const SessionsModalContent: FunctionComponent<{
  application: WebApplication
}> = ({ application }) => {
  const [sessions, refresh, refreshing, revokeSession, errorMessage, receivedAt] = useSessions(application)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const [confirmRevokingSessionUuid, setRevokingSessionUuid] = useState('')
  const closeRevokeSessionAlert = () => setRevokingSessionUuid('')
  const cancelRevokeRef = useRef<HTMLButtonElement>(null)

  const closeRevokeConfirmationDialog = () => {
    setRevokingSessionUuid('')
  }

  const sessionModalActions = useMemo(
    (): ModalAction[] => [
      {
        label: 'Close',
        onClick: application.closeSessionsModal,
        type: 'cancel',
        mobileSlot: 'left',
      },
      {
        label: 'Refresh',
        onClick: refresh,
        type: 'primary',
        mobileSlot: 'right',
      },
    ],
    [refresh, application.closeSessionsModal],
  )

  return (
    <>
      <Modal title="Open sessions and devices" close={application.closeSessionsModal} actions={sessionModalActions}>
        <div className="px-4 py-4">
          <p>
            Open sessions are unexpired sign-ins. Active recently means authenticated activity within the last two
            minutes.
          </p>
          {refreshing ? (
            <div className="flex items-center gap-2">
              <Spinner className="h-3 w-3" />
              <h2 className="sk-p sessions-modal-refreshing">Loading sessions</h2>
            </div>
          ) : (
            <>
              {errorMessage && (
                <div role="alert" className="sk-p bold">
                  {errorMessage}
                </div>
              )}
              {sessions.length > 0 && (
                <>
                  <p className="my-3 font-semibold">
                    {sessions.length} open sessions ·{' '}
                    {sessions.every((session) => Array.isArray(session.devices))
                      ? `${countSessionDevices(sessions)} observed devices`
                      : 'Device activity unavailable'}
                  </p>
                  <ul className="divide-border divide-y">
                    {sessions.map((session) => (
                      <li key={session.uuid} className="py-3">
                        <h2 className="text-base font-bold">{sessionDeviceLabel(session)}</h2>
                        {session.ip_address && <p>IP {session.ip_address}</p>}
                        <p>Signed in on {formatSessionDate(session.created_at)}</p>
                        <p>
                          {presentSessionActivity(session, now, receivedAt).statusLabel} · Last seen:{' '}
                          {presentSessionActivity(session, now, receivedAt).lastSeenText}
                        </p>
                        {session.refresh_expiration && (
                          <p>Session expires {formatSessionDate(session.refresh_expiration)}</p>
                        )}
                        {session.devices?.length ? (
                          <ul className="my-2 pl-3">
                            {session.devices.map((device, index) => {
                              const activity = presentActivity(
                                { ...device, activity_checked_at: session.activity_checked_at },
                                now,
                                receivedAt,
                              )
                              return (
                                <li key={device.device_id}>
                                  Device {index + 1}: {activity.statusLabel} · Last seen: {activity.lastSeenText}
                                </li>
                              )
                            })}
                          </ul>
                        ) : (
                          <p>No device activity observed for this session.</p>
                        )}
                        {session.current ? (
                          <span className="text-info font-bold">Current session</span>
                        ) : (
                          <Button
                            primary
                            small
                            colorStyle="danger"
                            disabled={session.revoking}
                            onClick={() => setRevokingSessionUuid(session.uuid)}
                          >
                            <span>Revoke</span>
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
      {confirmRevokingSessionUuid && (
        <AlertDialog closeDialog={closeRevokeConfirmationDialog}>
          <div className="flex items-center justify-between text-lg font-bold">
            {SessionStrings.RevokeTitle}
            <button className="hover:bg-contrast rounded p-1 font-bold" onClick={closeRevokeConfirmationDialog}>
              <Icon type="close" />
            </button>
          </div>
          <div className="sk-panel-row">
            <p className="text-foreground text-base lg:text-sm">{SessionStrings.RevokeText}</p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button ref={cancelRevokeRef} onClick={closeRevokeSessionAlert}>
              <span>{SessionStrings.RevokeCancelButton}</span>
            </Button>
            <Button
              primary
              colorStyle="danger"
              onClick={() => {
                closeRevokeSessionAlert()
                revokeSession(confirmRevokingSessionUuid).catch(console.error)
              }}
            >
              <span>{SessionStrings.RevokeConfirmButton}</span>
            </Button>
          </div>
        </AlertDialog>
      )}
    </>
  )
}

const SessionsModal: FunctionComponent<{
  application: WebApplication
}> = ({ application }) => {
  return (
    <ModalOverlay
      isOpen={application.isSessionsModalVisible}
      close={application.closeSessionsModal}
      className="sessions-modal"
    >
      <SessionsModalContent application={application} />
    </ModalOverlay>
  )
}

export default observer(SessionsModal)
