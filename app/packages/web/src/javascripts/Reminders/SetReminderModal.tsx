import { useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import Modal from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import {
  Reminder,
  generateReminderId,
  getNoteReminders,
  formatReminderRelative,
} from './reminders'
import {
  getNotificationPermission,
  requestNotificationPermission,
  notificationsSupported,
} from './notificationService'
import {
  createEmailReminder,
  deleteEmailReminder,
  getEmailRemindersOptIn,
  setEmailRemindersOptIn,
} from './emailReminders'

type Props = {
  application: WebApplication
  notesController: NotesController
  note: SNNote
  isOpen: boolean
  close: () => void
}

/** Convert an ISO string to the value expected by `<input type="datetime-local">`. */
function isoToLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  // datetime-local wants local time without timezone, trimmed to minutes.
  const offsetMs = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

/** Default the picker to ~1 hour from now, rounded to the minute. */
function defaultLocalInputValue(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  const offsetMs = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

const SetReminderModalContent = observer(
  ({ application, notesController, note, close }: Omit<Props, 'isOpen'>) => {
    const existing = useMemo(() => getNoteReminders(note), [note])
    const editing: Reminder | undefined = existing[0]

    const [dueLocal, setDueLocal] = useState<string>(() =>
      editing ? isoToLocalInputValue(editing.dueAt) : defaultLocalInputValue(),
    )
    const [message, setMessage] = useState<string>(editing?.message ?? '')
    const [permission, setPermission] = useState(() => getNotificationPermission())

    // Email-reminder opt-in state. `emailMe` is the per-reminder checkbox; it starts
    // checked if this reminder was already registered for email (has an id).
    const hasAccount = application.hasAccount()
    const [emailMe, setEmailMe] = useState<boolean>(Boolean(editing?.emailReminderId))
    const [accountOptIn, setAccountOptIn] = useState<boolean>(false)

    useEffect(() => {
      if (!hasAccount) {
        return
      }
      void getEmailRemindersOptIn(application).then(setAccountOptIn)
    }, [application, hasAccount])

    const now = Date.now()

    const enableNotifications = useCallback(async () => {
      const result = await requestNotificationPermission()
      setPermission(result)
      if (result === 'denied') {
        addToast({
          type: ToastType.Regular,
          message:
            'OS notifications are blocked. Reminders will still appear inside the app as toasts.',
        })
      }
    }, [])

    const save = useCallback(async () => {
      if (!dueLocal) {
        addToast({ type: ToastType.Error, message: 'Pick a date and time for the reminder.' })
        return
      }
      const dueDate = new Date(dueLocal)
      if (Number.isNaN(dueDate.getTime())) {
        addToast({ type: ToastType.Error, message: 'That date and time is invalid.' })
        return
      }

      const dueIso = dueDate.toISOString()
      const trimmedMessage = message.trim()

      const reminder: Reminder = {
        id: editing?.id ?? generateReminderId(),
        dueAt: dueIso,
        message: trimmedMessage || undefined,
        // Editing a reminder's time resets the notified flag so it can fire again.
        notified: editing && editing.dueAt === dueIso ? editing.notified : false,
        emailReminderId: editing?.emailReminderId,
      }

      // Reconcile the server-side email reminder with the checkbox.
      //  - turning email OFF (or any save when previously on): cancel the old server
      //    record (best-effort) so we never email a stale time/message.
      //  - turning email ON: register a fresh server record (its time + message leave
      //    end-to-end encryption — disclosed in the UI below).
      const previousEmailId = editing?.emailReminderId
      if (emailMe && hasAccount) {
        if (previousEmailId) {
          await deleteEmailReminder(application, previousEmailId)
        }
        // Ensure the account-level opt-in is on so the server is allowed to email it.
        if (!accountOptIn) {
          const enabled = await setEmailRemindersOptIn(application, true)
          if (enabled) {
            setAccountOptIn(true)
          }
        }
        const emailText = trimmedMessage || 'Reminder'
        const newId = await createEmailReminder(application, dueIso, emailText)
        if (newId) {
          reminder.emailReminderId = newId
        } else {
          reminder.emailReminderId = undefined
          addToast({
            type: ToastType.Error,
            message: 'The reminder was saved, but it could not be registered for email.',
          })
        }
      } else if (previousEmailId) {
        // Email turned off (or no account): cancel the server record.
        await deleteEmailReminder(application, previousEmailId)
        reminder.emailReminderId = undefined
      }

      try {
        await notesController.upsertNoteReminder(note, reminder)
        addToast({
          type: ToastType.Success,
          message: `Reminder set ${formatReminderRelative(reminder, Date.now())}.`,
        })
        close()
      } catch (error) {
        addToast({
          type: ToastType.Error,
          message: 'Could not save the reminder.',
        })
        console.error(error)
      }
    }, [accountOptIn, application, close, dueLocal, editing, emailMe, hasAccount, message, note, notesController])

    const clear = useCallback(async () => {
      try {
        // Best-effort cancel of the server email reminder so a cleared in-app reminder
        // is never emailed.
        if (editing?.emailReminderId) {
          await deleteEmailReminder(application, editing.emailReminderId)
        }
        await notesController.clearNoteReminders(note)
        addToast({ type: ToastType.Regular, message: 'Reminder cleared.' })
        close()
      } catch (error) {
        addToast({ type: ToastType.Error, message: 'Could not clear the reminder.' })
        console.error(error)
      }
    }, [application, close, editing, note, notesController])

    const previewIso = (() => {
      if (!dueLocal) {
        return undefined
      }
      const d = new Date(dueLocal)
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
    })()

    return (
      <Modal
        title={editing ? 'Edit reminder' : 'Set reminder'}
        className="p-4"
        close={close}
        actions={[
          {
            label: editing ? 'Save changes' : 'Set reminder',
            type: 'primary',
            onClick: () => void save(),
            mobileSlot: 'right',
          },
          {
            label: 'Cancel',
            type: 'cancel',
            onClick: close,
            mobileSlot: 'left',
          },
        ]}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-semibold" htmlFor="reminder-due">
              Remind me at
            </label>
            <input
              id="reminder-due"
              type="datetime-local"
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              value={dueLocal}
              onChange={(event) => setDueLocal(event.target.value)}
            />
            {previewIso && (
              <span className="text-xs text-passive-0">
                {formatReminderRelative({ id: '', dueAt: previewIso }, now)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-semibold" htmlFor="reminder-message">
              Message (optional)
            </label>
            <input
              id="reminder-message"
              type="text"
              maxLength={200}
              placeholder="e.g. Follow up with the client"
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>

          {/* Opt-in email delivery for THIS reminder. Only meaningful with an account
              (an email address is required to receive one). */}
          {hasAccount && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={emailMe}
                  onChange={(event) => setEmailMe(event.target.checked)}
                />
                Also email me this reminder
              </label>
              <p className="text-xs text-passive-0">
                Emailing a reminder sends its time and text to the server in plaintext (it leaves
                end-to-end encryption) so it can be emailed to you. Only this reminder is shared;
                your note stays encrypted. Email is sent only if your server operator has enabled and
                configured email reminders. You can cancel it any time from Preferences &rsaquo;
                Email reminders, or by clearing this reminder.
              </p>
            </div>
          )}

          {/* Opt-in OS notifications. Permission is only requested on this gesture. */}
          {notificationsSupported() ? (
            permission === 'granted' ? (
              <p className="text-xs text-passive-0">
                Desktop notifications are enabled. You&rsquo;ll also see an in-app alert when this
                reminder is due.
              </p>
            ) : permission === 'denied' ? (
              <p className="text-xs text-passive-0">
                Desktop notifications are blocked by your browser. Reminders will still appear inside
                the app.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => void enableNotifications()}
                className="self-start rounded border border-border px-3 py-1.5 text-sm text-info hover:underline"
              >
                Enable desktop notifications
              </button>
            )
          ) : (
            <p className="text-xs text-passive-0">
              Desktop notifications aren&rsquo;t supported here. Reminders appear inside the app.
            </p>
          )}

          {editing && (
            <button
              type="button"
              onClick={() => void clear()}
              className="self-start rounded px-2 py-1.5 text-sm text-danger hover:underline"
            >
              Clear reminder
            </button>
          )}
        </div>
      </Modal>
    )
  },
)

const SetReminderModal = ({ application, notesController, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[30rem]">
      <SetReminderModalContent
        application={application}
        notesController={notesController}
        note={note}
        close={close}
      />
    </ModalOverlay>
  )
}

export default observer(SetReminderModal)
