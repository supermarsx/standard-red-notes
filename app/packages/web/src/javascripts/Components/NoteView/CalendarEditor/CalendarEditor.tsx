import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  CalendarDocument,
  CalendarEvent,
  buildMonthGrid,
  createCalendarId,
  createEmptyCalendarDocument,
  parseCalendarDocument,
  serializeCalendarDocument,
  todayIso,
} from './CalendarDocument'
import { downloadICS } from '@/Utils/ICS/downloadICS'
import { calendarEventToICS } from '@/Utils/ICS/icsAdapters'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Calendar note. */
export const CalendarEditorIdentifier = 'org.standardnotes.calendar'

const PERSIST_DEBOUNCE_MS = 400

const EVENT_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

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

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

export const CalendarEditor: FunctionComponent<Props> = ({
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseCalendarDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<CalendarDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)

  const today = useMemo(() => todayIso(), [])
  const initialMonth = useMemo(() => {
    const [y, m] = today.split('-')
    return { year: Number(y), month: Number(m) - 1 }
  }, [today])
  const [view, setView] = useState<{ year: number; month: number }>(initialMonth)
  /** The day (ISO) whose event list is currently expanded for editing. */
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: CalendarDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeCalendarDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Calendar: ${doc.events.length} ${doc.events.length === 1 ? 'event' : 'events'}`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: CalendarDocument) => CalendarDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local calendar.
  useEffect(() => {
    const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
      if (updatedNote.uuid !== note.current.uuid) {
        return
      }
      note.current = updatedNote
      if (ignoreNextChange.current) {
        ignoreNextChange.current = false
        return
      }
      if (isPayloadSourceRetrieved(source)) {
        const { document: parsed } = parseCalendarDocument(updatedNote.text)
        setDocument(parsed)
      }
    })
    return disposer
  }, [controller])

  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
    }
  }, [])

  // Group events by date for fast per-cell lookup.
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of document.events) {
      const existing = map.get(event.date)
      if (existing) {
        existing.push(event)
      } else {
        map.set(event.date, [event])
      }
    }
    return map
  }, [document.events])

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
    setView(initialMonth)
    setSelectedDate(today)
  }, [initialMonth, today])

  const addEvent = useCallback(
    (date: string) => {
      if (isReadonly) {
        return
      }
      const id = createCalendarId('evt')
      updateDocument((doc) => ({
        ...doc,
        events: [...doc.events, { id, date, title: '' }],
      }))
    },
    [isReadonly, updateDocument],
  )

  const updateEvent = useCallback(
    (id: string, patch: Partial<CalendarEvent>) => {
      updateDocument((doc) => ({
        ...doc,
        events: doc.events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
      }))
    },
    [updateDocument],
  )

  const deleteEvent = useCallback(
    (id: string) => {
      updateDocument((doc) => ({ ...doc, events: doc.events.filter((event) => event.id !== id) }))
    },
    [updateDocument],
  )

  const onDayClick = useCallback(
    (date: string) => {
      setSelectedDate((prev) => (prev === date ? null : date))
    },
    [],
  )

  const selectedEvents = selectedDate ? eventsByDate.get(selectedDate) ?? [] : []

  const exportICS = useCallback(() => {
    if (document.events.length === 0) {
      return
    }
    const noteTitle = note.current.title
    const noteUuid = note.current.uuid
    downloadICS(document.events.map((event) => calendarEventToICS(event, noteUuid, noteTitle)))
  }, [document.events])

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="clock" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">
            {MONTH_LABELS[view.month]} {view.year}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => goToMonth(-1)}
            title="Previous month"
            aria-label="Previous month"
          >
            <Icon type="chevron-left" size="small" />
          </button>
          <button
            className="rounded px-2 py-1 text-sm hover:bg-default"
            onClick={goToToday}
            title="Go to today"
          >
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
            className="rounded p-1 hover:bg-default disabled:opacity-40"
            onClick={exportICS}
            disabled={document.events.length === 0}
            title="Export this calendar's events to .ics"
            aria-label="Export to .ics"
          >
            <Icon type="download" size="small" />
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a calendar and a new one was started. Your original text is
            preserved until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Month grid (scrolls on small screens). */}
      <div className="min-h-0 flex-grow overflow-auto p-2">
        <div className="grid grid-cols-7 gap-px">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="px-1 py-1 text-center text-xs font-bold uppercase tracking-wide text-passive-1">
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
                onClick={() => onDayClick(cell.date)}
                onDoubleClick={() => addEvent(cell.date)}
                className={classNames(
                  'flex min-h-[3.5rem] flex-col items-stretch rounded border p-1 text-left align-top transition-colors sm:min-h-[5rem]',
                  cell.inMonth ? 'bg-default' : 'bg-contrast text-passive-2',
                  isSelected ? 'border-info' : 'border-border',
                  'hover:border-info',
                )}
                title={cell.inMonth ? 'Click to view, double-click to add an event' : undefined}
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
                  {dayEvents.slice(0, 3).map((event) => (
                    <span
                      key={event.id}
                      className="truncate rounded px-1 text-[0.625rem] leading-tight"
                      style={{
                        backgroundColor: event.color ?? 'var(--sn-stylekit-info-color)',
                        color: '#ffffff',
                      }}
                    >
                      {event.title || 'Untitled'}
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

      {/* Selected day event editor. */}
      {selectedDate && (
        <div className="max-h-[40%] overflow-auto border-t border-border bg-default px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold">{selectedDate}</h3>
            <div className="flex items-center gap-2">
              {!isReadonly && (
                <button
                  className="flex items-center gap-1 rounded bg-info px-2 py-1 text-xs font-semibold text-info-contrast hover:opacity-90"
                  onClick={() => addEvent(selectedDate)}
                >
                  <Icon type="add" size="small" />
                  Add event
                </button>
              )}
              <button
                className="rounded p-1 hover:bg-contrast"
                onClick={() => setSelectedDate(null)}
                aria-label="Close day"
                title="Close"
              >
                <Icon type="close" size="small" />
              </button>
            </div>
          </div>
          {selectedEvents.length === 0 ? (
            <p className="text-xs text-passive-1">No events on this day.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {selectedEvents.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-0 flex-grow rounded border border-border bg-default px-2 py-1 text-sm text-text disabled:opacity-50"
                    value={event.title}
                    placeholder="Event title"
                    disabled={isReadonly}
                    onChange={(e) => updateEvent(event.id, { title: e.target.value })}
                  />
                  <input
                    type="date"
                    className="rounded border border-border bg-default px-2 py-1 text-xs text-text disabled:opacity-50"
                    value={event.date}
                    disabled={isReadonly}
                    onChange={(e) => {
                      if (e.target.value) {
                        updateEvent(event.id, { date: e.target.value })
                        setSelectedDate(e.target.value)
                      }
                    }}
                  />
                  <div className="flex items-center gap-1">
                    {EVENT_COLORS.map((color) => (
                      <button
                        key={color}
                        className={classNames(
                          'h-4 w-4 rounded-full border',
                          event.color === color ? 'border-info' : 'border-border',
                        )}
                        style={{ backgroundColor: color }}
                        disabled={isReadonly}
                        title="Set color"
                        aria-label={`Set color ${color}`}
                        onClick={() => updateEvent(event.id, { color: event.color === color ? undefined : color })}
                      />
                    ))}
                  </div>
                  <button
                    className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                    disabled={isReadonly}
                    onClick={() => deleteEvent(event.id)}
                    title="Delete event"
                    aria-label="Delete event"
                  >
                    <Icon type="trash" size="small" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export const initializeCalendarNoteText = (): string => serializeCalendarDocument(createEmptyCalendarDocument())
