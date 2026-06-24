/**
 * Font-size helpers for the Super editor toolbar, extracted from the React
 * component so the apply path — including the selection-restore that makes the
 * size field actually take effect after the editor loses focus — is testable
 * with a headless editor. `$`-prefixed functions must run inside editor.update().
 */
import { $getSelection, $isRangeSelection, $setSelection, BaseSelection } from 'lexical'
import { $patchStyleText } from '@lexical/selection'

export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 96
export const FONT_SIZE_STEP = 2
export const DEFAULT_FONT_SIZE = 16
export const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72, 96]

export const parseFontSize = (value: string): number => {
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? DEFAULT_FONT_SIZE : parsed
}

export const clampFontSize = (size: number): number =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))

/**
 * Apply a font size (already clamped by the caller) to the current selection.
 * When the live selection is no longer a range — the toolbar field stole focus
 * from the editor — fall back to the stashed `savedSelection` so the size still
 * lands on the originally-selected text. Returns true if a style was applied.
 */
export const $applyFontSizeToSelection = (sizePx: number, savedSelection: BaseSelection | null): boolean => {
  let selection = $getSelection()
  if (!$isRangeSelection(selection) && savedSelection) {
    selection = savedSelection.clone()
    $setSelection(selection)
  }
  if ($isRangeSelection(selection)) {
    $patchStyleText(selection, { 'font-size': `${sizePx}px` })
    return true
  }
  return false
}
