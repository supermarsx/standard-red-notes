import Icon from '@/Components/Icon/Icon'
import { FunctionComponent, useCallback } from 'react'
import { SNNote } from '@standardnotes/snjs'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import { iconClass } from './ClassNames'
import {
  getNoteAppearanceColors,
  noteHasCustomAppearance,
  NoteAppearancePresets,
} from '@/Utils/NoteAppearance'

const DefaultBackgroundSwatch = '#ffffff'
const DefaultTextSwatch = '#000000'

export const NoteAppearanceOptions: FunctionComponent<{
  notesController: NotesController
  note: SNNote
  disabled?: boolean
}> = ({ notesController, note, disabled }) => {
  const { backgroundColor, textColor } = getNoteAppearanceColors(note)
  const hasOverride = noteHasCustomAppearance(note)

  const setBackgroundColor = useCallback(
    (value: string | undefined) => {
      notesController.setNoteAppearanceColors(note, { backgroundColor: value }).catch(console.error)
    },
    [note, notesController],
  )

  const setTextColor = useCallback(
    (value: string | undefined) => {
      notesController.setNoteAppearanceColors(note, { textColor: value }).catch(console.error)
    },
    [note, notesController],
  )

  const applyPreset = useCallback(
    (preset: { backgroundColor: string; textColor: string }) => {
      notesController
        .setNoteAppearanceColors(note, {
          backgroundColor: preset.backgroundColor,
          textColor: preset.textColor,
        })
        .catch(console.error)
    },
    [note, notesController],
  )

  const resetToTheme = useCallback(() => {
    notesController.resetNoteAppearance(note).catch(console.error)
  }, [note, notesController])

  return (
    <div className="flex flex-col px-3 py-1.5">
      <div className="flex items-center">
        <Icon type="rich-text" className={iconClass} />
        <span className="text-mobile-menu-item md:text-tablet-menu-item lg:text-menu-item">Note appearance</span>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Background color</span>
          <span className="flex items-center gap-2">
            {backgroundColor && <span className="text-xs text-passive-1">{backgroundColor}</span>}
            <input
              type="color"
              aria-label="Note background color"
              disabled={disabled}
              value={backgroundColor ?? DefaultBackgroundSwatch}
              onChange={(event) => setBackgroundColor(event.target.value)}
              className="h-9 w-11 cursor-pointer touch-manipulation rounded border border-border bg-transparent p-0 md:h-6 md:w-8"
            />
          </span>
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Text color</span>
          <span className="flex items-center gap-2">
            {textColor && <span className="text-xs text-passive-1">{textColor}</span>}
            <input
              type="color"
              aria-label="Note text color"
              disabled={disabled}
              value={textColor ?? DefaultTextSwatch}
              onChange={(event) => setTextColor(event.target.value)}
              className="h-9 w-11 cursor-pointer touch-manipulation rounded border border-border bg-transparent p-0 md:h-6 md:w-8"
            />
          </span>
        </label>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-2 md:gap-1.5">
        {NoteAppearancePresets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            title={preset.name}
            aria-label={`Apply ${preset.name} colors`}
            disabled={disabled}
            onClick={() => applyPreset(preset)}
            className="flex h-9 w-9 touch-manipulation items-center justify-center rounded border border-border disabled:cursor-not-allowed disabled:opacity-60 md:h-6 md:w-6"
            style={{ backgroundColor: preset.backgroundColor, color: preset.textColor }}
          >
            <span className="text-xs font-bold">A</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={disabled || !hasOverride}
        onClick={resetToTheme}
        className="mt-2.5 self-start touch-manipulation rounded px-2 py-2 text-sm text-info enabled:hover:underline disabled:cursor-not-allowed disabled:text-passive-1 md:py-1"
      >
        Reset to theme
      </button>
    </div>
  )
}
