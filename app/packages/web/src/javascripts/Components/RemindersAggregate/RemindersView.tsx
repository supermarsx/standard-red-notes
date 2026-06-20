import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
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
    <li className="border-b border-border last:border-b-0">
      <button
        className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-contrast"
        onClick={() => onOpen(note.uuid)}
        title="Open source note"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-text">{note.title?.trim() || 'Untitled'}</span>
          <span className="flex-shrink-0 text-xs text-passive-1">{formatReminderRelative(reminder, now)}</span>
        </div>
        <span className="text-xs text-neutral">{formatDueDateTime(dueMs)}</span>
        {reminder.message?.trim() && (
          <span className="line-clamp-2 text-xs text-passive-1">{reminder.message.trim()}</span>
        )}
        {recurrenceSummary && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[0.625rem] text-info">
            <Icon type="restore" size="small" className="flex-shrink-0" />
            {recurrenceSummary}
          </span>
        )}
      </button>
    </li>
  )
}

const RemindersView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { removePane } = useResponsiveAppPane()

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

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="clock" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Reminders</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={classNames(
              'rounded px-2 py-1 text-xs font-semibold hover:bg-default',
              showCombined ? 'bg-default text-info' : 'text-neutral',
            )}
            onClick={() => setShowCombined((value) => !value)}
            title="Toggle a single combined read-only page of all reminders"
          >
            {showCombined ? 'List view' : 'Combined page'}
          </button>
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => removePane(AppPaneId.Reminders)}
            aria-label="Close reminders"
            title="Close"
          >
            <Icon type="menu-close" />
          </button>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto p-4">
        {reminders.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-passive-1">No reminders yet.</div>
        ) : showCombined ? (
          <div className="rounded-md border border-border bg-default p-4">
            <p className="mb-2 text-xs text-passive-1">
              A read-only page that virtually concatenates every reminder. This is synthesized on the fly and is not a
              saved note.
            </p>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">{combinedDocument}</pre>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <h2 className={classNames('mb-2 text-sm font-bold', GROUP_ACCENT[group.key])}>
                  {group.label} <span className="text-passive-1">({group.reminders.length})</span>
                </h2>
                <div className="overflow-hidden rounded-md border border-border bg-default">
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
