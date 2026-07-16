import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { formatDateAndTimeForNote } from '@/Utils/DateUtils'
import { formatReminderRelative } from '@/Reminders/reminders'
import {
  AggregatedReminder,
  ReminderGroup,
  buildCombinedReminderDocument,
  collectAllReminders,
  groupReminders,
} from '@/Reminders/allReminders'
import { downloadICS } from '@/Utils/ICS/downloadICS'
import { reminderToICS } from '@/Utils/ICS/icsAdapters'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

const formatDueDateTime = (ms: number): string => formatDateAndTimeForNote(new Date(ms))

const GROUP_ACCENT: Record<ReminderGroup['key'], string> = {
  overdue: 'text-danger',
  today: 'text-info',
  upcoming: 'text-neutral',
}

const ReminderRow = ({
  aggregated,
  now,
  onOpen,
}: {
  aggregated: AggregatedReminder
  now: number
  onOpen: (uuid: string) => void
}) => {
  const { note, reminder, dueMs, recurrenceSummary } = aggregated
  return (
    <li className="border-border border-b last:border-b-0">
      <button
        className="hover:bg-contrast flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left"
        onClick={() => onOpen(note.uuid)}
        title="Open source note"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-text truncate text-sm font-semibold">{note.title?.trim() || 'Untitled'}</span>
          <span className="text-passive-1 flex-shrink-0 text-xs">{formatReminderRelative(reminder, now)}</span>
        </div>
        <span className="text-neutral text-xs">{formatDueDateTime(dueMs)}</span>
        {reminder.message?.trim() && (
          <span className="text-passive-1 line-clamp-2 text-xs">{reminder.message.trim()}</span>
        )}
        {recurrenceSummary && (
          <span className="text-info mt-0.5 inline-flex items-center gap-1 text-[0.625rem]">
            <Icon type="restore" size="small" className="flex-shrink-0" />
            {recurrenceSummary}
          </span>
        )}
      </button>
    </li>
  )
}

const RemindersView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const [reminders, setReminders] = useState<AggregatedReminder[]>(() =>
    collectAllReminders(application.items.getItems<SNNote>(ContentType.TYPES.Note)),
  )
  const [now, setNow] = useState(() => Date.now())
  const [showCombined, setShowCombined] = useState(false)

  // Throttled recompute from local item state — no server polling. Driven by
  // item streams + sync completion, exactly like the Dashboard.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      const current = Date.now()
      setNow(current)
      setReminders(collectAllReminders(application.items.getItems<SNNote>(ContentType.TYPES.Note)))
    }

    const scheduleRecompute = () => {
      if (throttleTimeout) {
        pending = true
        return
      }
      recompute()
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending) {
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const removeItemObserver = application.items.streamItems([ContentType.TYPES.Note], () => scheduleRecompute())
    const removeSyncObserver = application.addEventObserver(async () => {
      scheduleRecompute()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      removeItemObserver()
      removeSyncObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application])

  const groups = useMemo(() => groupReminders(reminders, now), [reminders, now])
  const combinedDocument = useMemo(
    () => buildCombinedReminderDocument(reminders, now, formatDueDateTime),
    [reminders, now],
  )

  const openNote = useCallback(
    (uuid: string) => {
      const note = application.items.findItem<SNNote>(uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      application.paneController.presentPane(AppPaneId.Editor)
    },
    [application],
  )

  const exportICS = useCallback(() => {
    if (reminders.length === 0) {
      return
    }
    downloadICS(reminders.map(({ reminder, note }) => reminderToICS(reminder, note.uuid, note.title)))
  }, [reminders])

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'border-border bg-default flex h-full flex-col overflow-hidden border-l')}
    >
      <div className="border-border bg-contrast flex items-center justify-between border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="clock" className="text-info flex-shrink-0" />
          <span className="text-base font-bold">Reminders</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={classNames(
              'hover:bg-default rounded px-2 py-1 text-xs font-semibold',
              showCombined ? 'bg-default text-info' : 'text-neutral',
            )}
            onClick={() => setShowCombined((value) => !value)}
            title="Toggle a single combined read-only page of all reminders"
          >
            {showCombined ? 'List view' : 'Combined page'}
          </button>
          <button
            className="hover:bg-default rounded p-1 disabled:opacity-40"
            onClick={exportICS}
            disabled={reminders.length === 0}
            aria-label="Export reminders to .ics"
            title="Export all reminders to .ics"
          >
            <Icon type="download" size="small" />
          </button>
          <button
            className="hover:bg-default rounded p-1"
            onClick={() => application.paneController.closeViewTab(AppPaneId.Reminders)}
            aria-label="Close reminders"
            title="Close"
          >
            <Icon type="close" />
          </button>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto p-4">
        {reminders.length === 0 ? (
          <div className="text-passive-1 px-4 py-10 text-center text-sm">No reminders yet.</div>
        ) : showCombined ? (
          <div className="border-border bg-default rounded-md border p-4">
            <p className="text-passive-1 mb-2 text-xs">
              A read-only page that virtually concatenates every reminder. This is synthesized on the fly and is not a
              saved note.
            </p>
            <pre className="text-text font-sans text-sm break-words whitespace-pre-wrap">{combinedDocument}</pre>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <h2 className={classNames('mb-2 text-sm font-bold', GROUP_ACCENT[group.key])}>
                  {group.label} <span className="text-passive-1">({group.reminders.length})</span>
                </h2>
                <div className="border-border bg-default overflow-hidden rounded-md border">
                  <ul>
                    {group.reminders.map((aggregated) => (
                      <ReminderRow
                        key={`${aggregated.note.uuid}-${aggregated.reminder.id}`}
                        aggregated={aggregated}
                        now={now}
                        onOpen={openNote}
                      />
                    ))}
                  </ul>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  )
})

RemindersView.displayName = 'RemindersView'

export default observer(RemindersView)
