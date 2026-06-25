import { FunctionComponent, useCallback, useState } from 'react'
import { SNNote } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import { FilesController } from '@/Controllers/FilesController'
import { HERO_MAX_HEIGHT, HERO_MIN_HEIGHT, HeroHeader, validateHeroSourceFile } from './heroHeader'
import { processCoverImageFile } from './heroHeaderService'
import CoverImageSelectorModal from './CoverImageSelectorModal'

/**
 * Standard Red Notes: hero header (cover banner) UI for a note.
 *
 * Renders ABOVE the note title/editor inside NoteView. When the note has a cover
 * (`hero` is non-null) it shows the full-width image (object-fit: cover) with
 * on-hover controls to change / reposition / remove it. When there is no cover it
 * shows a subtle "Add cover" affordance near the title (only on hover, only when
 * the note is editable). All edits route through the NotesController, which
 * refuses to write while the note is locked.
 */

type Props = {
  note: SNNote
  hero: HeroHeader | null
  notesController: NotesController
  filesController: FilesController
  /** Editing is disabled for locked / readonly / protected-overlay states. */
  disabled?: boolean
  /** Surface a user-facing error message (e.g. oversized / invalid image). */
  onError?: (message: string) => void
}

const HeroHeaderBanner: FunctionComponent<Props> = ({
  note,
  hero,
  notesController,
  filesController,
  disabled,
  onError,
}) => {
  const [busy, setBusy] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const openPicker = useCallback(() => {
    if (disabled || busy) {
      return
    }
    setSelectorOpen(true)
  }, [disabled, busy])

  // Shared route for a file dropped DIRECTLY on the banner/affordance (without
  // opening the selector). Funnels through the same bounded-data-URL pipeline.
  const handleDroppedFile = useCallback(
    async (file: File) => {
      const validationError = validateHeroSourceFile({ type: file.type, size: file.size })
      if (validationError) {
        onError?.(validationError)
        return
      }
      setBusy(true)
      try {
        const dataUrl = await processCoverImageFile(file)
        await notesController.setNoteHeroImage(note, dataUrl)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not set the cover image.'
        onError?.(message)
      } finally {
        setBusy(false)
      }
    },
    [note, notesController, onError],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(false)
      if (disabled || busy) {
        return
      }
      const file = event.dataTransfer.files?.[0]
      if (file) {
        void handleDroppedFile(file)
      }
    },
    [disabled, busy, handleDroppedFile],
  )

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (disabled || busy) {
        return
      }
      event.preventDefault()
      setDragOver(true)
    },
    [disabled, busy],
  )

  const onDragLeave = useCallback(() => setDragOver(false), [])

  const selectorModal = (
    <CoverImageSelectorModal
      note={note}
      filesController={filesController}
      notesController={notesController}
      isOpen={selectorOpen}
      close={() => setSelectorOpen(false)}
      onError={onError}
    />
  )

  const removeCover = useCallback(() => {
    notesController.removeNoteHeroHeader(note).catch(console.error)
    setAdjusting(false)
  }, [note, notesController])

  const onHeightChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      notesController.setNoteHeroHeight(note, Number(event.target.value)).catch(console.error)
    },
    [note, notesController],
  )

  const onFocalChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      // Slider is 0 (bottom) .. 100 (top) for intuition; focalY is 0 (top) .. 1.
      notesController.setNoteHeroFocalY(note, 1 - Number(event.target.value) / 100).catch(console.error)
    },
    [note, notesController],
  )

  // No cover: a subtle "Add cover" affordance, shown only when editable. The
  // affordance is itself a drop target so the user can drop an image without
  // opening the selector.
  if (!hero) {
    if (disabled) {
      return null
    }
    return (
      <div className="group/hero relative w-full" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {selectorModal}
        <button
          type="button"
          onClick={openPicker}
          disabled={busy}
          className={
            'flex items-center gap-1.5 rounded px-2 py-1 text-xs text-passive-1 transition-opacity hover:bg-contrast focus:opacity-100 focus-visible:opacity-100 group-hover/hero:opacity-100 ' +
            (dragOver ? 'opacity-100 ring-2 ring-info' : 'opacity-0')
          }
        >
          <Icon type="file-image" size="small" />
          {busy ? 'Adding cover…' : dragOver ? 'Drop image to set cover' : 'Add cover'}
        </button>
      </div>
    )
  }

  const focalSliderValue = Math.round((1 - (hero.focalY ?? 0.5)) * 100)

  return (
    <div
      className="group/hero relative w-full select-none"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {selectorModal}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-info-backdrop/80 ring-2 ring-inset ring-info">
          <span className="rounded bg-default/90 px-3 py-1.5 text-sm font-semibold text-text shadow">
            Drop image to set cover
          </span>
        </div>
      )}
      <div className="w-full overflow-hidden" style={{ height: `${hero.height}px` }}>
        <img
          src={hero.imageDataUrl}
          alt="Note cover"
          draggable={false}
          className="h-full w-full object-cover"
          style={{ objectPosition: `center ${(hero.focalY ?? 0.5) * 100}%` }}
        />
      </div>

      {!disabled && (
        <div className="absolute right-3 top-3 flex items-center gap-2 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={openPicker}
            disabled={busy}
            title="Change cover"
            className="flex items-center gap-1 rounded bg-default/90 px-2 py-1 text-xs text-text shadow hover:bg-default"
          >
            <Icon type="pencil" size="small" />
            {busy ? 'Working…' : 'Change'}
          </button>
          <button
            type="button"
            onClick={() => setAdjusting((value) => !value)}
            title="Adjust cover"
            className="flex items-center gap-1 rounded bg-default/90 px-2 py-1 text-xs text-text shadow hover:bg-default"
          >
            <Icon type="more" size="small" />
            Adjust
          </button>
          <button
            type="button"
            onClick={removeCover}
            title="Remove cover"
            className="flex items-center gap-1 rounded bg-default/90 px-2 py-1 text-xs text-danger shadow hover:bg-default"
          >
            <Icon type="trash" size="small" />
            Remove
          </button>
        </div>
      )}

      {!disabled && adjusting && (
        <div className="absolute bottom-3 left-1/2 flex w-[min(90%,28rem)] -translate-x-1/2 flex-col gap-2 rounded bg-default/95 px-3 py-2 text-xs text-text shadow">
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0">Height</span>
            <input
              type="range"
              min={HERO_MIN_HEIGHT}
              max={HERO_MAX_HEIGHT}
              value={hero.height}
              onChange={onHeightChange}
              className="flex-grow"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0">Position</span>
            <input
              type="range"
              min={0}
              max={100}
              value={focalSliderValue}
              onChange={onFocalChange}
              className="flex-grow"
            />
          </label>
        </div>
      )}
    </div>
  )
}

export default HeroHeaderBanner
