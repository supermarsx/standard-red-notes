import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote, SNTag } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import Icon from '../Icon/Icon'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import { notePlaintextForTags, suggestTagsForNote } from '@/Assistant/tagSuggestions'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

/** A suggested tag plus whether it already exists (case-insensitive name match). */
type Suggestion = {
  /** Display name. For existing tags this is the existing tag's exact title. */
  name: string
  existing?: SNTag
  selected: boolean
}

const SuggestTagsModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
  const aiAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  const title = note.title ?? ''
  const plaintext = useMemo(() => notePlaintextForTags(note.text ?? '', note.noteType), [note])

  // Snapshot of the user's existing displayable tags, used both to seed the prompt
  // (prefer reuse) and to mark suggestions that map to an existing tag.
  const existingTags = useMemo(() => application.items.getDisplayableTags(), [application, note])

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ranOnce, setRanOnce] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const generate = useCallback(async () => {
    if (!aiAvailability.available) {
      return
    }
    if (!plaintext.trim() && !title.trim()) {
      addToast({ type: ToastType.Regular, message: 'This note is empty — nothing to suggest tags from.' })
      return
    }
    setGenerating(true)
    setError(null)
    setRanOnce(true)
    setSuggestions([])
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const existingTitles = existingTags.map((tag) => tag.title)
      const names = await suggestTagsForNote(
        application,
        { title, plaintext, existingTags: existingTitles },
        { signal: controller.signal },
      )
      const mapped: Suggestion[] = names.map((name) => {
        const match = existingTags.find((tag) => tag.title.toLowerCase() === name.toLowerCase())
        return { name: match ? match.title : name, existing: match, selected: true }
      })
      setSuggestions(mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }, [aiAvailability.available, application, existingTags, plaintext, title])

  const toggle = useCallback((index: number) => {
    setSuggestions((prev) => prev.map((s, i) => (i === index ? { ...s, selected: !s.selected } : s)))
  }, [])

  const chosen = suggestions.filter((s) => s.selected)

  const applyTags = useCallback(async () => {
    if (chosen.length === 0) {
      return
    }
    setApplying(true)
    try {
      for (const suggestion of chosen) {
        // Reuse the existing tag by exact title where one exists; otherwise
        // findOrCreateTag creates a new one. Both go through the real mutator path.
        const tag = suggestion.existing ?? (await application.mutator.findOrCreateTag(suggestion.name))
        // Link without syncing per-tag; we sync once at the end.
        await application.linkingController.addTagToItem(tag, note, false)
      }
      await application.sync.sync()
      addToast({
        type: ToastType.Success,
        message: `Added ${chosen.length} ${chosen.length === 1 ? 'tag' : 'tags'} to this note.`,
      })
      close()
    } catch (err) {
      addToast({
        type: ToastType.Error,
        message: err instanceof Error ? `Could not add tags: ${err.message}` : 'Could not add tags.',
      })
    } finally {
      setApplying(false)
    }
  }, [application, chosen, note, close])

  const noSuggestions = ranOnce && !generating && !error && suggestions.length === 0

  return (
    <Modal
      title="Suggest tags"
      className="p-4"
      close={close}
      actions={[
        {
          label: 'Cancel',
          type: 'cancel',
          onClick: close,
          mobileSlot: 'left',
        },
        {
          label: applying ? 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'tag' : 'tags'}`,
          type: 'primary',
          onClick: () => void applyTags(),
          disabled: chosen.length === 0 || applying || generating,
          mobileSlot: 'right',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* Data-exposure notice — same pattern as Narrate and the Assistant preferences pane. */}
        <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
          <div className="font-semibold text-warning">Suggesting tags sends note content to an AI</div>
          <p className="mt-1">
            Generating tag suggestions sends this note&rsquo;s title and text to the AI provider you configured. No
            tags are added until you confirm below.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
            onClick={() => void generate()}
            disabled={!aiAvailability.available || generating || applying}
          >
            <Icon type="dashboard" size="small" />
            {generating ? 'Suggesting…' : ranOnce ? 'Suggest again' : 'Suggest tags'}
          </button>
        </div>

        {!aiAvailability.available && <p className="text-xs text-passive-0">{aiAvailability.reason}</p>}
        {error && <p className="text-sm text-danger">Could not suggest tags: {error}</p>}
        {noSuggestions && (
          <p className="text-sm text-passive-0">
            No good tag suggestions for this note. Try editing the note and suggesting again.
          </p>
        )}

        {suggestions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Choose which tags to add</span>
            {suggestions.map((suggestion, index) => (
              <label key={`${suggestion.name}-${index}`} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={suggestion.selected} onChange={() => toggle(index)} />
                <span className="flex items-center gap-1.5">
                  <Icon type="hashtag" size="small" className="text-neutral" />
                  {suggestion.name}
                  {suggestion.existing ? (
                    <span className="text-xs text-passive-0">(existing tag)</span>
                  ) : (
                    <span className="text-xs text-info">(new tag)</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
})

const SuggestTagsModal = ({ application, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[32rem]">
      <SuggestTagsModalContent application={application} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(SuggestTagsModal)
