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
 *
 * ## The feature gate (t111 §C) — four states, not two
 * Covers are opt-in and default OFF (`PrefKey.NoteCoversEnabled`, pinned in
 * ./noteCoversPreference.ts). `coversEnabled` arrives as an explicit PROP rather
 * than being read from preferences here, so this component stays a pure function
 * of its props and every state below is renderable in jsdom with no application,
 * no controller wiring and no preference service.
 *
 * | coversEnabled | stored cover | renders                           |
 * |---------------|--------------|-----------------------------------|
 * | on            | none         | the "Add cover" affordance        |
 * | on            | present      | the cover banner                  |
 * | off           | none         | `null` — the feature is invisible |
 * | off           | present      | the hidden-cover notice           |
 *
 * The last row is the whole reason the gate is not a one-line `if`: turning the
 * setting off makes something the user MADE stop appearing, so the note says so
 * in one line and offers both routes out.
 */

type Props = {
  note: SNNote
  hero: HeroHeader | null
  notesController: NotesController
  filesController: FilesController
  /**
   * Whether the note-covers feature is switched on for this account
   * (`PrefKey.NoteCoversEnabled`, default false). Explicit prop, never read from
   * preferences in here — see the four-state table above.
   */
  coversEnabled: boolean
  /** Editing is disabled for locked / readonly / protected-overlay states. */
  disabled?: boolean
  /** Surface a user-facing error message (e.g. oversized / invalid image). */
  onError?: (message: string) => void
  /**
   * Turn the covers feature back on, from the hidden-cover notice. Writing the
   * preference is the host's job (this component takes no application), which is
   * also what keeps the notice testable.
   */
  onShowCovers?: () => void
}

const HeroHeaderBanner: FunctionComponent<Props> = ({
  note,
  hero,
  notesController,
  filesController,
  coversEnabled,
  disabled,
  onError,
  onShowCovers,
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

  // ── Covers switched OFF ────────────────────────────────────────────────────
  // With no stored cover the feature is simply absent: no affordance, nothing in
  // the tree, nothing to discover. With a stored cover we must NOT silently eat
  // something the user made, so the banner's slot carries a one-line disclosure
  // naming what is hidden and offering both routes out: turn covers back on, or
  // delete the cover for good.
  //
  // DELIBERATE ASYMMETRY with the locked / read-only banners rendered just above
  // this slot (NoteView.tsx): those are WARNINGS and must never scroll out of
  // existence. This is a DISCLOSURE, so it correctly inherits the
  // top-of-document scroll gate introduced by 8a773618 and scrolls away with the
  // banner it stands in for — it is a statement about a decoration, not about
  // what the user is allowed to do.
  //
  // [Remove cover] is omitted on a locked / read-only note (t111 §C, Q-E):
  // `writeNoteHeroHeader` refuses to write while the note is locked, and a
  // disabled button with no route forward is worse than no button. [Show covers]
  // is always offered because it writes a PREFERENCE, not the note.
  if (!coversEnabled) {
    if (!hero) {
      return null
    }
    return (
      <div
        data-note-hero-hidden-notice=""
        className="border-border text-passive-0 flex w-full items-center gap-2 border-b px-3.5 py-1 text-xs"
      >
        <Icon type="file-image" size="small" className="text-passive-1 flex-shrink-0" />
        <span className="flex-grow truncate">This note has a cover image, hidden because covers are off.</span>
        <button type="button" onClick={onShowCovers} className="text-info flex-shrink-0 text-xs hover:underline">
          Show covers
        </button>
        {!disabled && (
          <button type="button" onClick={removeCover} className="text-danger flex-shrink-0 text-xs hover:underline">
            Remove cover
          </button>
        )}
      </div>
    )
  }

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
            'text-passive-1 hover:bg-contrast flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-opacity group-hover/hero:opacity-100 focus:opacity-100 focus-visible:opacity-100 ' +
            (dragOver ? 'ring-info opacity-100 ring-2' : 'opacity-0')
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
        <div className="bg-info-backdrop/80 ring-info pointer-events-none absolute inset-0 z-10 flex items-center justify-center ring-2 ring-inset">
          <span className="bg-default/90 text-text rounded px-3 py-1.5 text-sm font-semibold shadow">
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
        <div className="absolute top-3 right-3 flex items-center gap-2 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={openPicker}
            disabled={busy}
            title="Change cover"
            className="bg-default/90 text-text hover:bg-default flex items-center gap-1 rounded px-2 py-1 text-xs shadow"
          >
            <Icon type="pencil" size="small" />
            {busy ? 'Working…' : 'Change'}
          </button>
          <button
            type="button"
            onClick={() => setAdjusting((value) => !value)}
            title="Adjust cover"
            className="bg-default/90 text-text hover:bg-default flex items-center gap-1 rounded px-2 py-1 text-xs shadow"
          >
            <Icon type="more" size="small" />
            Adjust
          </button>
          <button
            type="button"
            onClick={removeCover}
            title="Remove cover"
            className="bg-default/90 text-danger hover:bg-default flex items-center gap-1 rounded px-2 py-1 text-xs shadow"
          >
            <Icon type="trash" size="small" />
            Remove
          </button>
        </div>
      )}

      {!disabled && adjusting && (
        <div className="bg-default/95 text-text absolute bottom-3 left-1/2 flex w-[min(90%,28rem)] -translate-x-1/2 flex-col gap-2 rounded px-3 py-2 text-xs shadow">
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
