import { useCallback, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { SplitMode } from '@/Utils/NoteSplitting/splitNoteContent'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

const MODE_OPTIONS: { id: SplitMode; label: string; description: string }[] = [
  {
    id: 'headings',
    label: 'By Markdown headings',
    description: 'Start a new note at every #, ##, … heading. Content before the first heading becomes its own note.',
  },
  {
    id: 'hr',
    label: 'By horizontal rule',
    description: 'Start a new note at every thematic break (--- / *** / ___ on its own line).',
  },
  {
    id: 'delimiter',
    label: 'By custom delimiter',
    description: 'Split wherever the exact text you enter below appears.',
  },
]

const SplitNoteModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
  const notesController = application.notesController

  const [mode, setMode] = useState<SplitMode>('headings')
  const [delimiter, setDelimiter] = useState<string>('---')
  const [inheritTags, setInheritTags] = useState(true)
  const [keepOriginal, setKeepOriginal] = useState(true)
  const [linkParts, setLinkParts] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const isSuper = note.noteType === NoteType.Super

  const partCount = useMemo(() => {
    try {
      return notesController.previewSplitNote(note, {
        mode,
        delimiter: mode === 'delimiter' ? delimiter : undefined,
      }).length
    } catch {
      return 0
    }
    // Recompute when inputs that affect the split change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesController, note, mode, delimiter])

  const canSplit = partCount >= 2 && !(mode === 'delimiter' && delimiter.length === 0)

  const onConfirm = useCallback(async () => {
    setSubmitting(true)
    try {
      const created = await notesController.splitNote(note, {
        mode,
        delimiter: mode === 'delimiter' ? delimiter : undefined,
        inheritTags,
        keepOriginal,
        linkParts,
      })
      if (created.length > 0) {
        close()
      }
    } finally {
      setSubmitting(false)
    }
  }, [notesController, note, mode, delimiter, inheritTags, keepOriginal, linkParts, close])

  return (
    <Modal
      title="Split note"
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
          label: submitting ? 'Splitting…' : `Split into ${partCount} ${partCount === 1 ? 'note' : 'notes'}`,
          type: 'primary',
          onClick: () => void onConfirm(),
          disabled: !canSplit || submitting,
          mobileSlot: 'right',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {isSuper && (
          <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
            <div className="font-semibold text-warning">Super note becomes plain-text parts</div>
            <p className="mt-1">
              This is a Super note. Splitting extracts its visible text and creates the parts as plain-text notes, so
              rich formatting (tables, embeds, styling) is not carried over. The original Super note is unchanged.
            </p>
          </div>
        )}

        {/* Mode selection */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Split this note…</legend>
          {MODE_OPTIONS.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="split-mode"
                className="mt-1"
                checked={mode === option.id}
                onChange={() => setMode(option.id)}
              />
              <span className="flex flex-col">
                <span className="text-sm">{option.label}</span>
                <span className="text-xs text-passive-0">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === 'delimiter' && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-semibold">Delimiter</label>
            <input
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              value={delimiter}
              onChange={(event) => setDelimiter(event.target.value)}
              placeholder="e.g. --- or ==="
            />
            {delimiter.length === 0 && <span className="text-xs text-danger">Enter a delimiter to split on.</span>}
          </div>
        )}

        {/* Toggles */}
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={inheritTags} onChange={(event) => setInheritTags(event.target.checked)} />
            Apply the original note&rsquo;s tags to each part
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={linkParts} onChange={(event) => setLinkParts(event.target.checked)} />
            Link the parts together
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={keepOriginal} onChange={(event) => setKeepOriginal(event.target.checked)} />
            Keep the original note
          </label>
          {!keepOriginal && (
            <span className="ml-6 text-xs text-warning">The original note will be moved to the trash.</span>
          )}
        </div>

        {/* Preview */}
        <div className="rounded border border-border bg-contrast p-3 text-sm">
          {canSplit ? (
            <span>
              This will create <strong>{partCount}</strong> {partCount === 1 ? 'note' : 'notes'}.
            </span>
          ) : (
            <span className="text-passive-0">
              Nothing to split on yet — this note doesn&rsquo;t contain the chosen split point.
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
})

const SplitNoteModal = ({ application, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[34rem]">
      <SplitNoteModalContent application={application} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(SplitNoteModal)
