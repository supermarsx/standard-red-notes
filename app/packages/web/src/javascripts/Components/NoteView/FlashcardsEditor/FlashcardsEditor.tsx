import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  Flashcard,
  FlashcardsDocument,
  countKnownCards,
  createEmptyFlashcardsDocument,
  createFlashcardsId,
  createFlashcardsStarter,
  orderCardsForStudy,
  parseFlashcardsDocument,
  serializeFlashcardsDocument,
} from './FlashcardsDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as Flashcards. */
export const FlashcardsEditorIdentifier = 'org.standardnotes.flashcards'

const PERSIST_DEBOUNCE_MS = 400

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

type Mode = 'edit' | 'study'

export const FlashcardsEditor: FunctionComponent<Props> = ({
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseFlashcardsDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<FlashcardsDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)
  const [mode, setMode] = useState<Mode>('edit')

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: FlashcardsDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        const known = countKnownCards(doc)
        void controller.saveAndAwaitLocalPropagation({
          text: serializeFlashcardsDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Flashcards: ${doc.cards.length} ${doc.cards.length === 1 ? 'card' : 'cards'}, ${known} known`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: FlashcardsDocument) => FlashcardsDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local deck.
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
        const { document: parsed } = parseFlashcardsDocument(updatedNote.text)
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

  // --- card mutators -------------------------------------------------------

  const addCard = useCallback(() => {
    if (isReadonly) {
      return
    }
    updateDocument((doc) => ({
      ...doc,
      cards: [...doc.cards, { id: createFlashcardsId('card'), front: '', back: '' }],
    }))
  }, [isReadonly, updateDocument])

  const setCardField = useCallback(
    (cardId: string, field: 'front' | 'back', value: string) => {
      updateDocument((doc) => ({
        ...doc,
        cards: doc.cards.map((c) => (c.id === cardId ? { ...c, [field]: value } : c)),
      }))
    },
    [updateDocument],
  )

  const deleteCard = useCallback(
    (cardId: string) => {
      updateDocument((doc) => ({ ...doc, cards: doc.cards.filter((c) => c.id !== cardId) }))
    },
    [updateDocument],
  )

  const moveCard = useCallback(
    (cardId: string, direction: -1 | 1) => {
      updateDocument((doc) => {
        const index = doc.cards.findIndex((c) => c.id === cardId)
        const target = index + direction
        if (index < 0 || target < 0 || target >= doc.cards.length) {
          return doc
        }
        const cards = [...doc.cards]
        const [moved] = cards.splice(index, 1)
        cards.splice(target, 0, moved)
        return { ...doc, cards }
      })
    },
    [updateDocument],
  )

  /** Record a study review outcome (spaced-repetition-lite bookkeeping). */
  const reviewCard = useCallback(
    (cardId: string, gotIt: boolean) => {
      updateDocument((doc) => ({
        ...doc,
        cards: doc.cards.map((c) =>
          c.id === cardId
            ? {
                ...c,
                knownCount: gotIt ? (c.knownCount ?? 0) + 1 : 0,
                lastReviewed: Date.now(),
              }
            : c,
        ),
      }))
    },
    [updateDocument],
  )

  const knownCount = countKnownCards(document)

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="copy" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">Flashcards</span>
          <span className="truncate text-xs text-neutral">
            {document.cards.length} {document.cards.length === 1 ? 'card' : 'cards'} · {knownCount} known
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <div className="mr-1 flex items-center overflow-hidden rounded border border-border">
            <button
              className={classNames(
                'px-2 py-1 text-sm',
                mode === 'edit' ? 'bg-info text-info-contrast' : 'hover:bg-default',
              )}
              onClick={() => setMode('edit')}
            >
              Edit
            </button>
            <button
              className={classNames(
                'px-2 py-1 text-sm',
                mode === 'study' ? 'bg-info text-info-contrast' : 'hover:bg-default',
              )}
              onClick={() => setMode('study')}
            >
              Study
            </button>
          </div>
          {mode === 'edit' && (
            <button
              className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-default disabled:opacity-50"
              onClick={addCard}
              disabled={isReadonly}
              title="Add card"
            >
              <Icon type="add" size="small" />
              <span className="hidden sm:inline">Card</span>
            </button>
          )}
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a flashcards deck and a new one was started. Your original text is
            preserved until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-grow overflow-auto p-3">
        {mode === 'edit' ? (
          <EditMode
            document={document}
            isReadonly={isReadonly}
            onAddCard={addCard}
            onSetField={setCardField}
            onDeleteCard={deleteCard}
            onMoveCard={moveCard}
          />
        ) : (
          <StudyMode document={document} onReview={reviewCard} onGoToEdit={() => setMode('edit')} />
        )}
      </div>
    </div>
  )
}

// --- Edit mode -------------------------------------------------------------

type EditModeProps = {
  document: FlashcardsDocument
  isReadonly: boolean
  onAddCard: () => void
  onSetField: (cardId: string, field: 'front' | 'back', value: string) => void
  onDeleteCard: (cardId: string) => void
  onMoveCard: (cardId: string, direction: -1 | 1) => void
}

const EditMode: FunctionComponent<EditModeProps> = ({
  document,
  isReadonly,
  onAddCard,
  onSetField,
  onDeleteCard,
  onMoveCard,
}) => {
  if (document.cards.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
        <p className="font-semibold">No cards yet</p>
        <p>Add a card to start building your deck.</p>
        {!isReadonly && (
          <button
            className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
            onClick={onAddCard}
          >
            Add card
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      {document.cards.map((card, index) => (
        <div key={card.id} className="rounded-md border border-border bg-default p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-bold text-passive-1">Card {index + 1}</span>
            {(card.knownCount ?? 0) > 0 && (
              <span className="rounded bg-success-faded px-1.5 py-0.5 text-xs text-success">
                known x{card.knownCount}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly || index === 0}
                onClick={() => onMoveCard(card.id, -1)}
                title="Move card up"
                aria-label="Move card up"
              >
                <Icon type="arrow-up" size="small" />
              </button>
              <button
                className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly || index === document.cards.length - 1}
                onClick={() => onMoveCard(card.id, 1)}
                title="Move card down"
                aria-label="Move card down"
              >
                <Icon type="arrow-down" size="small" />
              </button>
              <button
                className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly}
                onClick={() => onDeleteCard(card.id)}
                title="Delete card"
                aria-label="Delete card"
              >
                <Icon type="trash" size="small" />
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-passive-1">Front</span>
              <textarea
                className="w-full resize-none rounded border border-border bg-contrast p-2 text-sm text-text outline-none focus:border-info disabled:opacity-50"
                rows={3}
                value={card.front}
                placeholder="Front (question)"
                disabled={isReadonly}
                onChange={(e) => onSetField(card.id, 'front', e.target.value)}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-passive-1">Back</span>
              <textarea
                className="w-full resize-none rounded border border-border bg-contrast p-2 text-sm text-text outline-none focus:border-info disabled:opacity-50"
                rows={3}
                value={card.back}
                placeholder="Back (answer)"
                disabled={isReadonly}
                onChange={(e) => onSetField(card.id, 'back', e.target.value)}
              />
            </label>
          </div>
        </div>
      ))}
      {!isReadonly && (
        <button
          className="flex items-center justify-center gap-1 rounded border border-dashed border-border px-2 py-2 text-sm text-passive-1 hover:border-info hover:text-info"
          onClick={onAddCard}
        >
          <Icon type="add" size="small" />
          Add card
        </button>
      )}
    </div>
  )
}

// --- Study mode ------------------------------------------------------------

type StudyModeProps = {
  document: FlashcardsDocument
  onReview: (cardId: string, gotIt: boolean) => void
  onGoToEdit: () => void
}

const StudyMode: FunctionComponent<StudyModeProps> = ({ document, onReview, onGoToEdit }) => {
  // Build the study queue once per study session entry. We snapshot ordering so
  // marking a card mid-session doesn't reshuffle the position out from under the
  // user; the spaced-repetition-lite ordering is recomputed on each new session
  // (and reflected next time Study is opened) via orderCardsForStudy.
  const queue = useMemo(() => orderCardsForStudy(document.cards).map((c) => c.id), [])
  const [position, setPosition] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [reviewedCount, setReviewedCount] = useState(0)

  const currentId = queue[position]
  // Re-resolve the card from the (possibly mutated) document so we always show
  // fresh front/back text even after edits in another session.
  const current: Flashcard | undefined = useMemo(
    () => document.cards.find((c) => c.id === currentId),
    [document.cards, currentId],
  )

  const advance = useCallback(() => {
    setFlipped(false)
    setPosition((prev) => prev + 1)
  }, [])

  const handleMark = useCallback(
    (gotIt: boolean) => {
      if (current) {
        onReview(current.id, gotIt)
      }
      setReviewedCount((prev) => prev + 1)
      advance()
    },
    [advance, current, onReview],
  )

  const restart = useCallback(() => {
    setPosition(0)
    setFlipped(false)
    setReviewedCount(0)
  }, [])

  if (document.cards.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
        <p className="font-semibold">Nothing to study</p>
        <p>Add some cards first.</p>
        <button
          className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
          onClick={onGoToEdit}
        >
          Add cards
        </button>
      </div>
    )
  }

  // Finished the queue (or current id vanished due to deletion).
  if (position >= queue.length || !current) {
    const known = countKnownCards(document)
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
        <Icon type="check-circle" className="mb-2 text-success" size="large" />
        <p className="font-semibold">Session complete</p>
        <p>
          Reviewed {reviewedCount} of {queue.length} · {known} known
        </p>
        <button
          className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
          onClick={restart}
        >
          Study again
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col">
      {/* Progress */}
      <div className="mb-3 flex items-center justify-between text-xs text-passive-1">
        <span>
          Card {position + 1} / {queue.length}
        </span>
        <span>{countKnownCards(document)} known</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-contrast">
        <div
          className="h-full bg-info transition-all"
          style={{ width: `${(position / queue.length) * 100}%` }}
        />
      </div>

      {/* Card */}
      <button
        className="my-4 flex min-h-[12rem] flex-grow flex-col items-center justify-center rounded-lg border border-border bg-default p-6 text-center hover:border-info"
        onClick={() => setFlipped((prev) => !prev)}
        aria-label={flipped ? 'Show front' : 'Reveal answer'}
      >
        <span className="mb-2 text-xs uppercase tracking-wide text-passive-1">{flipped ? 'Back' : 'Front'}</span>
        <span className="whitespace-pre-wrap break-words text-lg text-text">
          {(flipped ? current.back : current.front) || (
            <span className="italic text-passive-2">{flipped ? '(no answer)' : '(no question)'}</span>
          )}
        </span>
        {!flipped && <span className="mt-3 text-xs text-passive-1">Click to reveal</span>}
      </button>

      {/* Controls */}
      {flipped ? (
        <div className="flex items-center gap-2">
          <button
            className="flex flex-1 items-center justify-center gap-1 rounded bg-danger px-3 py-2 text-sm font-semibold text-danger-contrast hover:opacity-90"
            onClick={() => handleMark(false)}
          >
            <Icon type="close" size="small" />
            Again
          </button>
          <button
            className="flex flex-1 items-center justify-center gap-1 rounded bg-success px-3 py-2 text-sm font-semibold text-success-contrast hover:opacity-90"
            onClick={() => handleMark(true)}
          >
            <Icon type="check" size="small" />
            Got it
          </button>
        </div>
      ) : (
        <button
          className="rounded border border-border bg-contrast px-3 py-2 text-sm font-semibold hover:border-info"
          onClick={() => setFlipped(true)}
        >
          Reveal answer
        </button>
      )}
    </div>
  )
}

export const initializeFlashcardsNoteText = (): string => serializeFlashcardsDocument(createFlashcardsStarter())
export const initializeEmptyFlashcardsNoteText = (): string =>
  serializeFlashcardsDocument(createEmptyFlashcardsDocument())
