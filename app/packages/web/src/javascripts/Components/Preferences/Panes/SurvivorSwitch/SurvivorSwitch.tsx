import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ContentType, SNNote, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import { encryptShare, SharePayload } from '@/Components/SharedView/shareCrypto'

type Props = {
  application: WebApplication
}

type DeadManSwitch = {
  uuid: string
  recipientEmail: string
  message: string | null
  intervalDays: number
  deadline: number
  triggered: boolean
  lastCheckInAt: string | null
  createdAt: string
}

// Special scope value representing "the whole account" rather than a single note.
const WHOLE_ACCOUNT = '__whole_account__'

const formatDateTime = (value: number | string | null): string => {
  if (value === null || value === undefined || value === '') {
    return 'Never'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const SurvivorSwitch: FunctionComponent<Props> = ({ application }: Props) => {
  const [switches, setSwitches] = useState<DeadManSwitch[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [scope, setScope] = useState<string>(WHOLE_ACCOUNT)
  const [recipientEmail, setRecipientEmail] = useState('')
  const [intervalDays, setIntervalDays] = useState(30)
  const [message, setMessage] = useState('')

  const notes = useMemo(() => {
    return application.items
      .getItems<SNNote>(ContentType.TYPES.Note)
      .filter((note) => !note.trashed && !note.archived)
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  }, [application])

  const loadSwitches = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listDeadManSwitches()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { deadManSwitches?: DeadManSwitch[] } }).data
        setSwitches(data?.deadManSwitches ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadSwitches()
  }, [loadSwitches])

  const buildPayload = useCallback((): SharePayload | null => {
    if (scope === WHOLE_ACCOUNT) {
      return {
        kind: 'tag',
        title: 'All notes',
        notes: notes.map((note) => ({ title: note.title, text: note.text })),
      }
    }

    const note = notes.find((candidate) => candidate.uuid === scope)
    if (!note) {
      return null
    }
    return { kind: 'note', title: note.title, text: note.text }
  }, [scope, notes])

  const handleSubmit = useCallback(async () => {
    if (!recipientEmail.trim()) {
      addToast({ type: ToastType.Error, message: 'Please enter a recipient email.' })
      return
    }
    if (!Number.isFinite(intervalDays) || intervalDays < 1) {
      addToast({ type: ToastType.Error, message: 'Check-in interval must be at least 1 day.' })
      return
    }

    const payload = buildPayload()
    if (!payload) {
      addToast({ type: ToastType.Error, message: 'Please select a note to share.' })
      return
    }

    setSubmitting(true)
    try {
      const { encryptedPayload, keyHex } = await encryptShare(payload)

      const shareType = scope === WHOLE_ACCOUNT ? 'account' : 'note'
      const shareResponse = await application.legacyApi.createShare({ type: shareType, encryptedPayload })
      if (isErrorResponse(shareResponse)) {
        const data = shareResponse.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to encrypt the share.' })
        return
      }

      const shareId = (shareResponse as { data?: { shareId?: string } }).data?.shareId
      if (!shareId) {
        addToast({ type: ToastType.Error, message: 'The server did not return a share link.' })
        return
      }

      const shareUrl = `${window.location.origin}/?shared=${shareId}#${keyHex}`

      const response = await application.legacyApi.createDeadManSwitch({
        recipientEmail: recipientEmail.trim(),
        shareUrl,
        message: message.trim() || undefined,
        intervalDays,
      })
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create survivor switch.' })
        return
      }

      addToast({ type: ToastType.Success, message: 'Survivor switch created.' })
      setRecipientEmail('')
      setMessage('')
      await loadSwitches()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create survivor switch.' })
    } finally {
      setSubmitting(false)
    }
  }, [application, recipientEmail, intervalDays, message, scope, buildPayload, loadSwitches])

  const handleCheckIn = useCallback(
    async (id: string) => {
      try {
        const response = await application.legacyApi.checkInDeadManSwitch(id)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to check in.' })
          return
        }
        addToast({ type: ToastType.Success, message: 'Checked in. The deadline has been extended.' })
        await loadSwitches()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to check in.' })
      }
    },
    [application, loadSwitches],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to delete this survivor switch? The stored link and key will be removed from the server and nothing will be sent.',
        'Delete Survivor Switch',
        'Delete',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.deleteDeadManSwitch(id)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to delete survivor switch.' })
          return
        }
        await loadSwitches()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to delete survivor switch.' })
      }
    },
    [application, loadSwitches],
  )

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Survivor Switch</Title>
          <Text>
            A survivor switch (a "dead man's switch") delivers a note — or your whole account — to someone you trust if
            you stop checking in. Choose what to share, who receives it, and how often you must check in. As long as you
            check in before each deadline, nothing is sent. If you miss a deadline, the link is emailed to your
            recipient.
          </Text>

          <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
            <Subtitle className="text-warning">Important: this stores your link and key on the server</Subtitle>
            <Text className="mt-1">
              Unlike a normal share link — where the decryption key never leaves your browser — a survivor switch stores
              the full link, including its decryption key, on the server. This is necessary so the content can be
              delivered to your recipient when you are gone. As a result, both your recipient (once the switch triggers)
              and the server itself can access the shared content: anyone who can read the server's stored switches could
              decrypt it without waiting for the switch to fire. Only use this for content you are comfortable entrusting
              to the server and your recipient. Delete the switch to remove the stored link and key from the server.
            </Text>
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Create a survivor switch</Subtitle>

          <label className="mt-3 block">
            <span className="text-sm font-medium lg:text-xs">What to share</span>
            <select
              className="mt-1 block w-full rounded border border-solid border-border bg-default px-2 py-1.5 text-base text-text lg:text-sm"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              disabled={submitting}
            >
              <option value={WHOLE_ACCOUNT}>Whole account ({notes.length} notes)</option>
              {notes.map((note) => (
                <option key={note.uuid} value={note.uuid}>
                  {note.title || 'Untitled note'}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block">
            <span className="text-sm font-medium lg:text-xs">Recipient email</span>
            <input
              type="email"
              className="mt-1 block w-full rounded border border-solid border-border bg-default px-2 py-1.5 text-base text-text lg:text-sm"
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.target.value)}
              placeholder="someone@example.com"
              disabled={submitting}
            />
          </label>

          <label className="mt-3 block">
            <span className="text-sm font-medium lg:text-xs">Check-in interval (days)</span>
            <input
              type="number"
              min={1}
              className="mt-1 block w-full rounded border border-solid border-border bg-default px-2 py-1.5 text-base text-text lg:text-sm"
              value={intervalDays}
              onChange={(event) => setIntervalDays(Number(event.target.value))}
              disabled={submitting}
            />
          </label>

          <label className="mt-3 block">
            <span className="text-sm font-medium lg:text-xs">Message to recipient (optional)</span>
            <textarea
              className="mt-1 block w-full rounded border border-solid border-border bg-default px-2 py-1.5 text-base text-text lg:text-sm"
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="A note that will accompany the link when it is delivered."
              disabled={submitting}
            />
          </label>

          <Button
            className="mt-4"
            primary
            label={submitting ? 'Creating…' : 'Create survivor switch'}
            disabled={submitting}
            onClick={() => void handleSubmit()}
          />
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Your survivor switches</Subtitle>
          {loading && <Spinner className="mt-2 h-4 w-4" />}
          {!loading && switches.length === 0 && <Text className="mt-2">You have no survivor switches.</Text>}
          {!loading &&
            switches.map((item) => (
              <div
                key={item.uuid}
                className="mt-2 flex flex-row items-center justify-between rounded border border-solid border-border p-3"
              >
                <div className="flex flex-col">
                  <span className="text-base font-medium lg:text-sm">{item.recipientEmail}</span>
                  <span className="text-sm text-passive-0 lg:text-xs">Checks in every {item.intervalDays} days</span>
                  <span className="text-sm text-passive-0 lg:text-xs">
                    {item.triggered ? 'Sent' : `Next deadline: ${formatDateTime(item.deadline)}`}
                  </span>
                  <span className="text-sm text-passive-0 lg:text-xs">
                    Last check-in: {formatDateTime(item.lastCheckInAt)}
                  </span>
                </div>
                <div className="flex flex-row items-center gap-2">
                  {!item.triggered && <Button label="Check in" onClick={() => void handleCheckIn(item.uuid)} />}
                  <Button label="Delete" onClick={() => void handleDelete(item.uuid)} />
                </div>
              </div>
            ))}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(SurvivorSwitch)
