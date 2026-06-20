import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { DragEvent as ReactDragEvent, FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  KanbanCard,
  KanbanColumn,
  KanbanDocument,
  countCards,
  createEmptyKanbanDocument,
  createKanbanId,
  createKanbanStarter,
  parseKanbanDocument,
  serializeKanbanDocument,
} from './KanbanDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Kanban board. */
export const KanbanEditorIdentifier = 'org.standardnotes.kanban-board'

const PERSIST_DEBOUNCE_MS = 400

const COLUMN_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

type DragInfo = { cardId: string; fromColumnId: string }

export const KanbanEditor: FunctionComponent<Props> = ({
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseKanbanDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<KanbanDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)
  const dragInfo = useRef<DragInfo | null>(null)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: KanbanDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        const cards = countCards(doc)
        void controller.saveAndAwaitLocalPropagation({
          text: serializeKanbanDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Kanban: ${doc.columns.length} columns, ${cards} ${cards === 1 ? 'card' : 'cards'}`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: KanbanDocument) => KanbanDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local board.
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
        const { document: parsed } = parseKanbanDocument(updatedNote.text)
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

  // --- column mutators -----------------------------------------------------

  const addColumn = useCallback(() => {
    if (isReadonly) {
      return
    }
    updateDocument((doc) => ({
      ...doc,
      columns: [...doc.columns, { id: createKanbanId('col'), title: 'New column', cards: [] }],
    }))
  }, [isReadonly, updateDocument])

  const renameColumn = useCallback(
    (columnId: string, title: string) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.map((c) => (c.id === columnId ? { ...c, title } : c)),
      }))
    },
    [updateDocument],
  )

  const setColumnColor = useCallback(
    (columnId: string, color: string | undefined) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.map((c) => (c.id === columnId ? { ...c, color } : c)),
      }))
    },
    [updateDocument],
  )

  const deleteColumn = useCallback(
    (columnId: string) => {
      updateDocument((doc) => ({ ...doc, columns: doc.columns.filter((c) => c.id !== columnId) }))
    },
    [updateDocument],
  )

  const moveColumn = useCallback(
    (columnId: string, direction: -1 | 1) => {
      updateDocument((doc) => {
        const index = doc.columns.findIndex((c) => c.id === columnId)
        const target = index + direction
        if (index < 0 || target < 0 || target >= doc.columns.length) {
          return doc
        }
        const columns = [...doc.columns]
        const [moved] = columns.splice(index, 1)
        columns.splice(target, 0, moved)
        return { ...doc, columns }
      })
    },
    [updateDocument],
  )

  // --- card mutators -------------------------------------------------------

  const addCard = useCallback(
    (columnId: string) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.map((c) =>
          c.id === columnId ? { ...c, cards: [...c.cards, { id: createKanbanId('card'), text: '' }] } : c,
        ),
      }))
    },
    [updateDocument],
  )

  const setCardText = useCallback(
    (columnId: string, cardId: string, text: string) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.map((c) =>
          c.id === columnId ? { ...c, cards: c.cards.map((card) => (card.id === cardId ? { ...card, text } : card)) } : c,
        ),
      }))
    },
    [updateDocument],
  )

  const deleteCard = useCallback(
    (columnId: string, cardId: string) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.map((c) =>
          c.id === columnId ? { ...c, cards: c.cards.filter((card) => card.id !== cardId) } : c,
        ),
      }))
    },
    [updateDocument],
  )

  /** Move a card to an adjacent column (button-based fallback for drag). */
  const moveCardToColumn = useCallback(
    (cardId: string, fromColumnId: string, direction: -1 | 1) => {
      updateDocument((doc) => {
        const fromIndex = doc.columns.findIndex((c) => c.id === fromColumnId)
        const toIndex = fromIndex + direction
        if (fromIndex < 0 || toIndex < 0 || toIndex >= doc.columns.length) {
          return doc
        }
        const card = doc.columns[fromIndex].cards.find((c) => c.id === cardId)
        if (!card) {
          return doc
        }
        const columns = doc.columns.map((column, index) => {
          if (index === fromIndex) {
            return { ...column, cards: column.cards.filter((c) => c.id !== cardId) }
          }
          if (index === toIndex) {
            return { ...column, cards: [...column.cards, card] }
          }
          return column
        })
        return { ...doc, columns }
      })
    },
    [updateDocument],
  )

  /** Drop a dragged card onto a target column (appends at the end). */
  const dropCardOnColumn = useCallback(
    (toColumnId: string) => {
      const info = dragInfo.current
      dragInfo.current = null
      setDragOverColumnId(null)
      if (!info || info.fromColumnId === toColumnId) {
        return
      }
      updateDocument((doc) => {
        const card = doc.columns.find((c) => c.id === info.fromColumnId)?.cards.find((c) => c.id === info.cardId)
        if (!card) {
          return doc
        }
        const columns = doc.columns.map((column) => {
          if (column.id === info.fromColumnId) {
            return { ...column, cards: column.cards.filter((c) => c.id !== info.cardId) }
          }
          if (column.id === toColumnId) {
            return { ...column, cards: [...column.cards, card] }
          }
          return column
        })
        return { ...doc, columns }
      })
    },
    [updateDocument],
  )

  const onCardDragStart = useCallback(
    (event: ReactDragEvent, card: KanbanCard, column: KanbanColumn) => {
      if (isReadonly) {
        return
      }
      dragInfo.current = { cardId: card.id, fromColumnId: column.id }
      event.dataTransfer.effectAllowed = 'move'
      // Some browsers require data to be set for a drag to start.
      event.dataTransfer.setData('text/plain', card.id)
    },
    [isReadonly],
  )

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="dashboard" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">Kanban</span>
          <span className="truncate text-xs text-neutral">
            {document.columns.length} columns · {countCards(document)} cards
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-default disabled:opacity-50"
            onClick={addColumn}
            disabled={isReadonly}
            title="Add column"
          >
            <Icon type="add" size="small" />
            <span className="hidden sm:inline">Column</span>
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a kanban board and a new one was started. Your original text is
            preserved until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Board: columns scroll horizontally; stack readably on small screens. */}
      <div className="min-h-0 flex-grow overflow-auto p-3">
        {document.columns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
            <p className="font-semibold">No columns yet</p>
            <p>Add a column to start organizing cards.</p>
            {!isReadonly && (
              <button
                className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
                onClick={addColumn}
              >
                Add column
              </button>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col gap-3 md:flex-row md:items-start">
            {document.columns.map((column, columnIndex) => (
              <div
                key={column.id}
                className={classNames(
                  'flex w-full flex-shrink-0 flex-col rounded-md border bg-default md:w-72',
                  dragOverColumnId === column.id ? 'border-info' : 'border-border',
                )}
                style={{ borderTop: column.color ? `3px solid ${column.color}` : undefined }}
                onDragOver={(event) => {
                  if (dragInfo.current) {
                    event.preventDefault()
                    setDragOverColumnId(column.id)
                  }
                }}
                onDragLeave={() => setDragOverColumnId((prev) => (prev === column.id ? null : prev))}
                onDrop={(event) => {
                  event.preventDefault()
                  dropCardOnColumn(column.id)
                }}
              >
                {/* Column header */}
                <div className="flex items-center gap-1 border-b border-border px-2 py-2">
                  <input
                    className="min-w-0 flex-grow rounded bg-transparent px-1 py-0.5 text-sm font-bold text-text outline-none focus:bg-contrast disabled:opacity-50"
                    value={column.title}
                    placeholder="Column title"
                    disabled={isReadonly}
                    onChange={(e) => renameColumn(column.id, e.target.value)}
                  />
                  <span className="text-xs text-passive-1">{column.cards.length}</span>
                  <button
                    className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                    disabled={isReadonly || columnIndex === 0}
                    onClick={() => moveColumn(column.id, -1)}
                    title="Move column left"
                    aria-label="Move column left"
                  >
                    <Icon type="chevron-left" size="small" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                    disabled={isReadonly || columnIndex === document.columns.length - 1}
                    onClick={() => moveColumn(column.id, 1)}
                    title="Move column right"
                    aria-label="Move column right"
                  >
                    <Icon type="chevron-right" size="small" />
                  </button>
                  <button
                    className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                    disabled={isReadonly}
                    onClick={() => deleteColumn(column.id)}
                    title="Delete column"
                    aria-label="Delete column"
                  >
                    <Icon type="trash" size="small" />
                  </button>
                </div>

                {/* Column color swatches */}
                {!isReadonly && (
                  <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                    {COLUMN_COLORS.map((color) => (
                      <button
                        key={color}
                        className={classNames(
                          'h-3.5 w-3.5 rounded-full border',
                          column.color === color ? 'border-info' : 'border-border',
                        )}
                        style={{ backgroundColor: color }}
                        title="Set column color"
                        aria-label={`Set column color ${color}`}
                        onClick={() => setColumnColor(column.id, column.color === color ? undefined : color)}
                      />
                    ))}
                  </div>
                )}

                {/* Cards */}
                <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto p-2 md:max-h-none">
                  {column.cards.map((card) => (
                    <div
                      key={card.id}
                      draggable={!isReadonly}
                      onDragStart={(event) => onCardDragStart(event, card, column)}
                      onDragEnd={() => {
                        dragInfo.current = null
                        setDragOverColumnId(null)
                      }}
                      className="group rounded border border-border bg-contrast p-2"
                    >
                      <textarea
                        className="w-full resize-none bg-transparent text-sm text-text outline-none disabled:opacity-50"
                        rows={2}
                        value={card.text}
                        placeholder="Card text"
                        disabled={isReadonly}
                        onChange={(e) => setCardText(column.id, card.id, e.target.value)}
                      />
                      {!isReadonly && (
                        <div className="mt-1 flex items-center justify-end gap-1">
                          <button
                            className="rounded p-1 hover:bg-default disabled:opacity-30"
                            disabled={columnIndex === 0}
                            onClick={() => moveCardToColumn(card.id, column.id, -1)}
                            title="Move card to previous column"
                            aria-label="Move card to previous column"
                          >
                            <Icon type="arrow-left" size="small" />
                          </button>
                          <button
                            className="rounded p-1 hover:bg-default disabled:opacity-30"
                            disabled={columnIndex === document.columns.length - 1}
                            onClick={() => moveCardToColumn(card.id, column.id, 1)}
                            title="Move card to next column"
                            aria-label="Move card to next column"
                          >
                            <Icon type="arrow-right" size="small" />
                          </button>
                          <button
                            className="rounded p-1 text-danger hover:bg-default"
                            onClick={() => deleteCard(column.id, card.id)}
                            title="Delete card"
                            aria-label="Delete card"
                          >
                            <Icon type="trash" size="small" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!isReadonly && (
                    <button
                      className="flex items-center justify-center gap-1 rounded border border-dashed border-border px-2 py-1.5 text-xs text-passive-1 hover:border-info hover:text-info"
                      onClick={() => addCard(column.id)}
                    >
                      <Icon type="add" size="small" />
                      Add card
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export const initializeKanbanNoteText = (): string => serializeKanbanDocument(createKanbanStarter())
export const initializeEmptyKanbanNoteText = (): string => serializeKanbanDocument(createEmptyKanbanDocument())
