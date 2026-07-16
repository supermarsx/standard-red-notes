import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { FileItem, SNTag } from '@standardnotes/snjs'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import Icon from '../Icon/Icon'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import { suggestTagsForFile } from '@/Assistant/tagSuggestions'
import { extractFileTextForTags } from '@/Components/FilePreview/fileTextExtraction'

type Props = {
  application: WebApplication
  file: FileItem
  isOpen: boolean
  close: () => void
}

/** A suggested (or user-typed) tag plus whether it already exists by name. */
type Suggestion = {
  /** Display name. For existing tags this is the existing tag's exact title. */
  name: string
  existing?: SNTag
  selected: boolean
}

const SuggestTagsForFileModalContent = observer(({ application, file, close }: Omit<Props, 'isOpen'>) => {
  const aiAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  // Snapshot of the user's existing displayable tags, used both to seed the prompt
  // (prefer reuse) and to mark suggestions that map to an existing tag.
  const existingTags = useMemo(() => application.items.getDisplayableTags(), [application, file])

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [reading, setReading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ranOnce, setRanOnce] = useState(false)
  // null until a run has determined what was extractable for this file.
  const [onlyMetadata, setOnlyMetadata] = useState<boolean | null>(null)
  const [customTag, setCustomTag] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const generate = useCallback(async () => {
    if (!aiAvailability.available) {
      return
    }
    setError(null)
    setRanOnce(true)
    setSuggestions([])
    setOnlyMetadata(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // 1) Read what we can from the file ON DEVICE (text-like files only; PDFs via
      //    the cached OCR text when enabled). Everything else is metadata-only.
      setReading(true)
      const extracted = await extractFileTextForTags(application, file, { signal: controller.signal })
      setOnlyMetadata(extracted.onlyMetadataAvailable)
      setReading(false)

      // 2) Ask the assistant for topics from metadata (+ any extracted text).
      setGenerating(true)
      const existingTitles = existingTags.map((tag) => tag.title)
      const names = await suggestTagsForFile(
        application,
        {
          name: file.name,
          mimeType: file.mimeType,
          sizeLabel: formatSizeToReadableString(file.decryptedSize),
          extractedText: extracted.text,
          existingTags: existingTitles,
        },
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
      setReading(false)
      setGenerating(false)
      abortRef.current = null
    }
  }, [aiAvailability.available, application, existingTags, file])

  const toggle = useCallback((index: number) => {
    setSuggestions((prev) => prev.map((s, i) => (i === index ? { ...s, selected: !s.selected } : s)))
  }, [])

  const addCustomTag = useCallback(() => {
    const name = customTag.trim()
    if (!name) {
      return
    }
    setSuggestions((prev) => {
      const existingIndex = prev.findIndex((s) => s.name.toLowerCase() === name.toLowerCase())
      if (existingIndex !== -1) {
        // Already listed — just make sure it's selected.
        return prev.map((s, i) => (i === existingIndex ? { ...s, selected: true } : s))
      }
      const match = existingTags.find((tag) => tag.title.toLowerCase() === name.toLowerCase())
      return [...prev, { name: match ? match.title : name, existing: match, selected: true }]
    })
    setCustomTag('')
  }, [customTag, existingTags])

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
        await application.linkingController.addTagToItem(tag, file, false)
      }
      await application.sync.sync()
      addToast({
        type: ToastType.Success,
        message: `Added ${chosen.length} ${chosen.length === 1 ? 'topic' : 'topics'} to this file.`,
      })
      close()
    } catch (err) {
      addToast({
        type: ToastType.Error,
        message: err instanceof Error ? `Could not add topics: ${err.message}` : 'Could not add topics.',
      })
    } finally {
      setApplying(false)
    }
  }, [application, chosen, file, close])

  const busy = reading || generating
  const noSuggestions = ranOnce && !busy && !error && suggestions.length === 0

  return (
    <Modal
      title="Suggest topics"
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
          label: applying ? 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'topic' : 'topics'}`,
          type: 'primary',
          onClick: () => void applyTags(),
          disabled: chosen.length === 0 || applying || busy,
          mobileSlot: 'right',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* Data-exposure notice tailored to files — honest about what leaves the device. */}
        <div className="border-warning bg-warning-faded rounded border border-solid p-3 text-sm">
          <div className="text-warning font-semibold">Suggesting topics sends file details to an AI</div>
          <p className="mt-1">
            Suggesting topics sends this file&rsquo;s name, type, and any readable text (extracted on your device) to
            the AI provider you configured. Encrypted file contents that can&rsquo;t be read as text are never sent. No
            topics are added until you confirm below.
          </p>
          {onlyMetadata === true && (
            <p className="mt-1 font-semibold">
              For this file only its name and type were sent — its contents couldn&rsquo;t be read as text on your
              device.
            </p>
          )}
          {onlyMetadata === false && (
            <p className="mt-1 font-semibold">For this file its name, type, and readable text were sent.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="bg-info text-info-contrast flex items-center gap-1 rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
            onClick={() => void generate()}
            disabled={!aiAvailability.available || busy || applying}
          >
            <Icon type="dashboard" size="small" />
            {reading ? 'Reading file…' : generating ? 'Suggesting…' : ranOnce ? 'Suggest again' : 'Suggest topics'}
          </button>
        </div>

        {!aiAvailability.available && <p className="text-passive-0 text-xs">{aiAvailability.reason}</p>}
        {error && <p className="text-danger text-sm">Could not suggest topics: {error}</p>}
        {noSuggestions && (
          <p className="text-passive-0 text-sm">
            No good topic suggestions for this file. You can still add your own below.
          </p>
        )}

        {suggestions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Choose which topics to add</span>
            {suggestions.map((suggestion, index) => (
              <label key={`${suggestion.name}-${index}`} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={suggestion.selected} onChange={() => toggle(index)} />
                <span className="flex items-center gap-1.5">
                  <Icon type="hashtag" size="small" className="text-neutral" />
                  {suggestion.name}
                  {suggestion.existing ? (
                    <span className="text-passive-0 text-xs">(existing tag)</span>
                  ) : (
                    <span className="text-info text-xs">(new tag)</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Add-your-own row: a manual topic path that still applies only on confirm. */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Add your own topic</span>
          <div className="flex items-center gap-2">
            <input
              className="input flex-grow text-sm"
              type="text"
              value={customTag}
              placeholder="Type a topic and press Add"
              onChange={(event) => setCustomTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addCustomTag()
                }
              }}
            />
            <button
              className="border-border rounded border border-solid px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
              onClick={addCustomTag}
              disabled={!customTag.trim() || applying}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
})

const SuggestTagsForFileModal = ({ application, file, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[32rem]">
      <SuggestTagsForFileModalContent application={application} file={file} close={close} />
    </ModalOverlay>
  )
}

export default observer(SuggestTagsForFileModal)
