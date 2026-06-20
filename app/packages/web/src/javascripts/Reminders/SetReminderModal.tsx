import { useCallback, useMemo, useState } from 'react'
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

      const reminder: Reminder = {
        id: editing?.id ?? generateReminderId(),
        dueAt: dueDate.toISOString(),
        message: message.trim() || undefined,
        // Editing a reminder's time resets the notified flag so it can fire again.
        notified: editing && editing.dueAt === dueDate.toISOString() ? editing.notified : false,
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
    }, [close, dueLocal, editing, message, note, notesController])

    const clear = useCallback(async () => {
      try {
        await notesController.clearNoteReminders(note)
        addToast({ type: ToastType.Regular, message: 'Reminder cleared.' })
        close()
      } catch (error) {
        addToast({ type: ToastType.Error, message: 'Could not clear the reminder.' })
        console.error(error)
      }
    }, [close, note, notesController])

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
