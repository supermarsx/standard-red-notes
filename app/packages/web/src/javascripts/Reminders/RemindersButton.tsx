import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { classNames } from '@standardnotes/utils'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatReminderRelative,
  getNoteReminders,
  isReminderDue,
  Reminder,
  ReminderWithNote,
  sortRemindersByDueAt,
} from './reminders'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: a small floating control showing all upcoming/overdue
 * reminders across notes. Clicking it opens a popover listing each reminder with
 * the note title, relative due time, and open/dismiss actions.
 *
 * It reads reminders live from notes (appData) and re-scans on note streams +
 * a light interval so the relative times and overdue badge stay fresh. It does
 * NOT fire notifications — that's the job of `useReminderChecker`; this is the
 * read-only overview UI.
 */
const RemindersButton = ({ application }: Props) => {
  const [open, setOpen] = useState(false)
  const [pairs, setPairs] = useState<ReminderWithNote[]>([])
  const buttonRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(() => {
    const notes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
    const collected: ReminderWithNote[] = []
    for (const note of notes) {
      if (note.trashed) {
        continue
      }
      for (const reminder of getNoteReminders(note)) {
        collected.push({ note, reminder })
      }
    }
    collected.sort((a, b) => Date.parse(a.reminder.dueAt) - Date.parse(b.reminder.dueAt))
    setPairs(collected)
  }, [application])

  useEffect(() => {
    refresh()
    const removeObserver = application.items.streamItems<SNNote>(ContentType.TYPES.Note, () => refresh())
    const intervalId = setInterval(refresh, 30_000)
    return () => {
      removeObserver()
      clearInterval(intervalId)
    }
  }, [application, refresh])

  const togglePopover = useCallback(() => setOpen((value) => !value), [])

  const openNote = useCallback(
    (note: SNNote) => {
      application.itemListController.openNote(note.uuid).catch(console.error)
      setOpen(false)
    },
    [application],
  )

  const dismissReminder = useCallback(
    (note: SNNote, reminder: Reminder) => {
      application.notesController.removeNoteReminder(note, reminder.id).catch(console.error)
    },
    [application],
  )

  const now = Date.now()
  const overdueCount = pairs.filter(({ reminder }) => isReminderDue(reminder, now)).length
  const total = pairs.length

  if (total === 0) {
    // Stay out of the way entirely when there are no reminders (opt-in).
    return null
  }

  return (
    <div className="pointer-events-auto">
      <StyledTooltip label="Reminders" showOnHover>
        <button
          ref={buttonRef}
          onClick={togglePopover}
          aria-label="Reminders"
          className={classNames(
            'relative flex items-center gap-1.5 rounded border border-border bg-default px-2.5 py-1.5 text-sm shadow',
            'hover:bg-contrast',
          )}
        >
          <Icon type="clock" size="small" />
          <span>{total}</span>
          {overdueCount > 0 && (
            <span
              aria-label={`${overdueCount} overdue`}
              className="ml-0.5 rounded-full bg-danger px-1.5 text-xs font-bold text-danger-contrast"
            >
              {overdueCount}
            </span>
          )}
        </button>
      </StyledTooltip>

      <Popover
        open={open}
        anchorElement={buttonRef}
        togglePopover={togglePopover}
        align="end"
        side="top"
        title="Reminders"
        className="py-1"
      >
        <div className="min-w-[18rem] max-w-[24rem] py-1">
          <div className="px-3 py-1 text-xs font-semibold uppercase text-passive-0">Reminders</div>
          <ul className="max-h-80 overflow-y-auto">
            {sortRemindersByDueAt(pairs.map((pair) => pair.reminder)).length === 0 && (
              <li className="px-3 py-2 text-sm text-passive-0">No reminders.</li>
            )}
            {pairs.map(({ note, reminder }) => {
              const due = isReminderDue(reminder, now)
              return (
                <li
                  key={reminder.id}
                  className="flex flex-col gap-0.5 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      className="truncate text-left text-sm font-semibold text-text hover:underline"
                      onClick={() => openNote(note)}
                      title={note.title || 'Untitled'}
                    >
                      {note.title?.trim() || 'Untitled'}
                    </button>
                    <button
                      className="flex-shrink-0 rounded p-1 text-passive-0 hover:bg-contrast hover:text-danger"
                      aria-label="Dismiss reminder"
                      onClick={() => dismissReminder(note, reminder)}
                    >
                      <Icon type="close" size="small" />
                    </button>
                  </div>
                  <span className={classNames('text-xs', due ? 'font-semibold text-danger' : 'text-passive-0')}>
                    {formatReminderRelative(reminder, now)}
                    {' · '}
                    {new Date(reminder.dueAt).toLocaleString()}
                  </span>
                  {reminder.message && <span className="text-xs text-passive-0">{reminder.message}</span>}
                </li>
              )
            })}
          </ul>
        </div>
      </Popover>
    </div>
  )
}

export default RemindersButton
