import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { buildMonthGrid, todayIso } from '../NoteView/CalendarEditor/CalendarDocument'
import {
  AggregatedCalendarEvent,
  collectAllCalendarEvents,
  indexCalendarEventsByDate,
} from './allCalendarEvents'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const CalendarAggregateView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { removePane } = useResponsiveAppPane()

  const [events, setEvents] = useState<AggregatedCalendarEvent[]>(() =>
    collectAllCalendarEvents(application.items.getItems<SNNote>(ContentType.TYPES.Note)),
  )

  const today = useMemo(() => todayIso(), [])
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const [y, m] = today.split('-')
    return { year: Number(y), month: Number(m) - 1 }
  })
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // Throttled recompute from local item state — no server polling.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setEvents(collectAllCalendarEvents(application.items.getItems<SNNote>(ContentType.TYPES.Note)))
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

  const eventsByDate = useMemo(() => indexCalendarEventsByDate(events), [events])
  const grid = useMemo(() => buildMonthGrid(view.year, view.month), [view])

  const goToMonth = useCallback((direction: -1 | 1) => {
    setView((prev) => {
      const nextMonthIndex = prev.month + direction
      if (nextMonthIndex < 0) {
        return { year: prev.year - 1, month: 11 }
      }
      if (nextMonthIndex > 11) {
        return { year: prev.year + 1, month: 0 }
      }
      return { year: prev.year, month: nextMonthIndex }
    })
  }, [])

  const goToToday = useCallback(() => {
    const [y, m] = today.split('-')
    setView({ year: Number(y), month: Number(m) - 1 })
    setSelectedDate(today)
  }, [today])

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

  const selectedEvents = selectedDate ? eventsByDate.get(selectedDate) ?? [] : []

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="history" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">
            Calendar <span className="text-passive-1">· {MONTH_LABELS[view.month]} {view.year}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => goToMonth(-1)}
            title="Previous month"
            aria-label="Previous month"
          >
            <Icon type="chevron-left" size="small" />
          </button>
          <button className="rounded px-2 py-1 text-sm hover:bg-default" onClick={goToToday} title="Go to today">
            Today
          </button>
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => goToMonth(1)}
            title="Next month"
            aria-label="Next month"
          >
            <Icon type="chevron-right" size="small" />
          </button>
          <button
            className="ml-1 rounded p-1 hover:bg-default"
            onClick={() => removePane(AppPaneId.Calendar)}
            aria-label="Close calendar"
            title="Close"
          >
            <Icon type="menu-close" />
          </button>
        </div>
      </div>

      {events.length === 0 && (
        <div className="border-b border-border bg-default px-4 py-2 text-xs text-passive-1">
          No calendar entries yet. Create a Calendar note and its events will appear here.
        </div>
      )}

      <div className="min-h-0 flex-grow overflow-auto p-2">
        <div className="grid grid-cols-7 gap-px">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="px-1 py-1 text-center text-xs font-bold uppercase tracking-wide text-passive-1"
            >
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{label.charAt(0)}</span>
            </div>
          ))}
          {grid.map((cell) => {
            const dayEvents = eventsByDate.get(cell.date) ?? []
            const isToday = cell.date === today
            const isSelected = cell.date === selectedDate
            return (
              <button
                key={cell.date}
                onClick={() => setSelectedDate((prev) => (prev === cell.date ? null : cell.date))}
                className={classNames(
                  'flex min-h-[3.5rem] flex-col items-stretch rounded border p-1 text-left align-top transition-colors sm:min-h-[5rem]',
                  cell.inMonth ? 'bg-default' : 'bg-contrast text-passive-2',
                  isSelected ? 'border-info' : 'border-border',
                  'hover:border-info',
                )}
              >
                <span
                  className={classNames(
                    'mb-0.5 inline-flex h-5 w-5 items-center justify-center self-start rounded-full text-xs',
                    isToday ? 'bg-info font-bold text-info-contrast' : 'text-passive-1',
                  )}
                >
                  {cell.day}
                </span>
                <span className="flex flex-col gap-0.5 overflow-hidden">
                  {dayEvents.slice(0, 3).map((aggregated) => (
                    <span
                      key={aggregated.note.uuid + aggregated.event.id}
                      className="truncate rounded px-1 text-[0.625rem] leading-tight"
                      style={{
                        backgroundColor: aggregated.event.color ?? 'var(--sn-stylekit-info-color)',
                        color: '#ffffff',
                      }}
                    >
                      {aggregated.event.title || 'Untitled'}
                    </span>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="px-1 text-[0.625rem] text-passive-1">+{dayEvents.length - 3} more</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="max-h-[40%] overflow-auto border-t border-border bg-default px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold">{selectedDate}</h3>
            <button
              className="rounded p-1 hover:bg-contrast"
              onClick={() => setSelectedDate(null)}
              aria-label="Close day"
              title="Close"
            >
              <Icon type="close" size="small" />
            </button>
          </div>
          {selectedEvents.length === 0 ? (
            <p className="text-xs text-passive-1">No entries on this day.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {selectedEvents.map((aggregated) => (
                <li key={aggregated.note.uuid + aggregated.event.id}>
                  <button
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-contrast"
                    onClick={() => openNote(aggregated.note.uuid)}
                    title="Open source calendar note"
                  >
                    <span
                      className="h-3 w-3 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: aggregated.event.color ?? 'var(--sn-stylekit-info-color)' }}
                    />
                    <span className="min-w-0 flex-grow truncate text-sm text-text">
                      {aggregated.event.title || 'Untitled'}
                    </span>
                    <span className="flex-shrink-0 truncate text-xs text-passive-1">
                      {aggregated.note.title?.trim() || 'Untitled note'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {children}
    </div>
  )
})

CalendarAggregateView.displayName = 'CalendarAggregateView'

export default observer(CalendarAggregateView)
