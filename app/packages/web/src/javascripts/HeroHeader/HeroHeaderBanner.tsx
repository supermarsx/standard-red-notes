import { FunctionComponent, useCallback, useRef, useState } from 'react'
import { SNNote } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import {
  ACCEPTED_HERO_IMAGE_TYPES,
  HERO_MAX_HEIGHT,
  HERO_MIN_HEIGHT,
  HeroHeader,
} from './heroHeader'
import { processCoverImageFile } from './heroHeaderService'

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
  /** Editing is disabled for locked / readonly / protected-overlay states. */
  disabled?: boolean
  /** Surface a user-facing error message (e.g. oversized / invalid image). */
  onError?: (message: string) => void
}

const acceptAttribute = ACCEPTED_HERO_IMAGE_TYPES.join(',')

const HeroHeaderBanner: FunctionComponent<Props> = ({ note, hero, notesController, disabled, onError }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [adjusting, setAdjusting] = useState(false)

  const openPicker = useCallback(() => {
    if (disabled || busy) {
      return
    }
    fileInputRef.current?.click()
  }, [disabled, busy])

  const onFileChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Reset the input so picking the same file again still fires a change.
      event.target.value = ''
      if (!file) {
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

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={acceptAttribute}
      className="hidden"
      onChange={(event) => {
        onFileChosen(event).catch(console.error)
      }}
    />
  )

  // No cover: a subtle "Add cover" affordance, shown only when editable.
  if (!hero) {
    if (disabled) {
      return null
    }
    return (
      <div className="group/hero relative w-full">
        {hiddenInput}
        <button
          type="button"
          onClick={openPicker}
          disabled={busy}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-passive-1 opacity-0 transition-opacity hover:bg-contrast focus:opacity-100 focus-visible:opacity-100 group-hover/hero:opacity-100"
        >
          <Icon type="file-image" size="small" />
          {busy ? 'Adding cover…' : 'Add cover'}
        </button>
      </div>
    )
  }

  const focalSliderValue = Math.round((1 - (hero.focalY ?? 0.5)) * 100)

  return (
    <div className="group/hero relative w-full select-none">
      {hiddenInput}
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
