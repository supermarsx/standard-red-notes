import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  TimelineDocument,
  TimelineItem,
  computeTimelineLayout,
  createEmptyTimelineDocument,
  createTimelineId,
  normalizeTimelineDate,
  parseTimelineDocument,
  serializeTimelineDocument,
} from './TimelineDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Timeline note. */
export const TimelineEditorIdentifier = 'org.standardnotes.timeline'

const PERSIST_DEBOUNCE_MS = 400

const ITEM_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

const todayIso = (): string => {
  const now = new Date()
  return `${now.getFullYear().toString().padStart(4, '0')}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`
}

export const TimelineEditor: FunctionComponent<Props> = ({
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseTimelineDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<TimelineDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: TimelineDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeTimelineDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Timeline: ${doc.items.length} ${doc.items.length === 1 ? 'item' : 'items'}`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: TimelineDocument) => TimelineDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local timeline.
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
        const { document: parsed } = parseTimelineDocument(updatedNote.text)
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

  const layout = useMemo(() => computeTimelineLayout(document.items), [document.items])
  const barsById = useMemo(() => {
    const map = new Map<string, { offset: number; width: number }>()
    for (const bar of layout.bars) {
      map.set(bar.id, { offset: bar.offset, width: bar.width })
    }
    return map
  }, [layout.bars])

  const addItem = useCallback(() => {
    if (isReadonly) {
      return
    }
    const start = todayIso()
    updateDocument((doc) => ({
      ...doc,
      items: [...doc.items, { id: createTimelineId('item'), label: 'New item', start, end: start }],
    }))
  }, [isReadonly, updateDocument])

  const updateItem = useCallback(
    (id: string, patch: Partial<TimelineItem>) => {
      updateDocument((doc) => ({
        ...doc,
        items: doc.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      }))
    },
    [updateDocument],
  )

  const deleteItem = useCallback(
    (id: string) => {
      updateDocument((doc) => ({ ...doc, items: doc.items.filter((item) => item.id !== id) }))
    },
    [updateDocument],
  )

  // Keep start <= end when editing a date field.
  const setItemStart = useCallback(
    (item: TimelineItem, value: string) => {
      const normalized = normalizeTimelineDate(value) ?? item.start
      const end = normalized > item.end ? normalized : item.end
      updateItem(item.id, { start: normalized, end })
    },
    [updateItem],
  )

  const setItemEnd = useCallback(
    (item: TimelineItem, value: string) => {
      const normalized = normalizeTimelineDate(value) ?? item.end
      const start = normalized < item.start ? normalized : item.start
      updateItem(item.id, { start, end: normalized })
    },
    [updateItem],
  )

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="history" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">Timeline</span>
          <span className="truncate text-xs text-neutral">
            {document.items.length} {document.items.length === 1 ? 'item' : 'items'}
            {layout.minDate && layout.maxDate ? ` · ${layout.minDate} → ${layout.maxDate}` : ''}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-default disabled:opacity-50"
            onClick={addItem}
            disabled={isReadonly}
            title="Add item"
          >
            <Icon type="add" size="small" />
            <span className="hidden sm:inline">Item</span>
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a timeline and a new one was started. Your original text is
            preserved until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-grow overflow-auto">
        {document.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
            <p className="font-semibold">No items yet</p>
            <p>Add an item with a start and end date to plot the waterfall.</p>
            {!isReadonly && (
              <button
                className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
                onClick={addItem}
              >
                Add item
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Waterfall / Gantt chart. Scrolls horizontally on small screens. */}
            <div className="overflow-x-auto border-b border-border p-3">
              <div className="min-w-[28rem]">
                {document.items.map((item) => {
                  const bar = barsById.get(item.id)
                  const offsetPct = `${(bar?.offset ?? 0) * 100}%`
                  const widthPct = `${Math.max((bar?.width ?? 0) * 100, 1)}%`
                  return (
                    <div key={item.id} className="mb-1.5 flex items-center gap-2">
                      <div className="w-28 flex-shrink-0 truncate text-xs text-text sm:w-40" title={item.label}>
                        {item.label || <span className="text-passive-2">Untitled</span>}
                      </div>
                      <div className="relative h-5 flex-grow rounded bg-contrast">
                        <div
                          className="absolute top-0 h-full rounded"
                          style={{
                            left: offsetPct,
                            width: widthPct,
                            backgroundColor: item.color ?? 'var(--sn-stylekit-info-color)',
                          }}
                          title={`${item.start} → ${item.end}`}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Editable item list. */}
            <div className="p-3">
              <ul className="flex flex-col gap-2">
                {document.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
                    <input
                      className="min-w-0 flex-grow rounded border border-border bg-default px-2 py-1 text-sm text-text disabled:opacity-50"
                      value={item.label}
                      placeholder="Item label"
                      disabled={isReadonly}
                      onChange={(e) => updateItem(item.id, { label: e.target.value })}
                    />
                    <label className="flex items-center gap-1 text-xs text-passive-1">
                      <span className="hidden sm:inline">Start</span>
                      <input
                        type="date"
                        className="rounded border border-border bg-default px-2 py-1 text-xs text-text disabled:opacity-50"
                        value={item.start}
                        disabled={isReadonly}
                        onChange={(e) => e.target.value && setItemStart(item, e.target.value)}
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-passive-1">
                      <span className="hidden sm:inline">End</span>
                      <input
                        type="date"
                        className="rounded border border-border bg-default px-2 py-1 text-xs text-text disabled:opacity-50"
                        value={item.end}
                        disabled={isReadonly}
                        onChange={(e) => e.target.value && setItemEnd(item, e.target.value)}
                      />
                    </label>
                    <div className="flex items-center gap-1">
                      {ITEM_COLORS.map((color) => (
                        <button
                          key={color}
                          className={classNames(
                            'h-4 w-4 rounded-full border',
                            item.color === color ? 'border-info' : 'border-border',
                          )}
                          style={{ backgroundColor: color }}
                          disabled={isReadonly}
                          title="Set color"
                          aria-label={`Set color ${color}`}
                          onClick={() => updateItem(item.id, { color: item.color === color ? undefined : color })}
                        />
                      ))}
                    </div>
                    <button
                      className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                      disabled={isReadonly}
                      onClick={() => deleteItem(item.id)}
                      title="Delete item"
                      aria-label="Delete item"
                    >
                      <Icon type="trash" size="small" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export const initializeTimelineNoteText = (): string => serializeTimelineDocument(createEmptyTimelineDocument())
