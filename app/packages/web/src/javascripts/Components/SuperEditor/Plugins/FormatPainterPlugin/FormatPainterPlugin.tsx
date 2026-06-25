import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  createCommand,
  LexicalCommand,
  SELECTION_CHANGE_COMMAND,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import { useEffect } from 'react'
import { formatPainterStore } from './formatPainterStore'
import { $applyCapturedFormatToSelection, $captureFormatFromSelection } from './applyCapturedFormat'

/**
 * Payload for {@link FORMAT_PAINTER_TOGGLE}.
 * - `undefined` / `{}`     -> single-use arm (Word single click). Toggles off if
 *                              already armed.
 * - `{ lock: true }`       -> sticky arm (Word double click): stays armed and
 *                              keeps painting until toggled off again.
 */
export type FormatPainterTogglePayload = { lock?: boolean } | undefined

/**
 * Toggle the format painter. When fired with no capture pending it captures the
 * current selection's inline formatting and arms; when already armed it disarms.
 */
export const FORMAT_PAINTER_TOGGLE: LexicalCommand<FormatPainterTogglePayload> =
  createCommand('FORMAT_PAINTER_TOGGLE')

export default function FormatPainterPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    // When the editor that owns this plugin tears down, drop any armed state so
    // a fresh editor doesn't inherit a stale painter.
    const teardown = () => formatPainterStore.reset()

    return mergeRegister(
      editor.registerCommand<FormatPainterTogglePayload>(
        FORMAT_PAINTER_TOGGLE,
        (payload) => {
          const { armed } = formatPainterStore.getSnapshot()
          // A second activation always cancels (Word: click the lit button to stop).
          if (armed) {
            formatPainterStore.disarm()
            return true
          }
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) {
            return false
          }
          formatPainterStore.arm($captureFormatFromSelection(selection), Boolean(payload?.lock))
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      // Apply the captured format the next time the user makes a (non-collapsed)
      // selection. Runs at LOW priority and returns false so it never blocks the
      // toolbar's own SELECTION_CHANGE handling.
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const { armed, captured } = formatPainterStore.getSnapshot()
          if (!armed || !captured) {
            return false
          }
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || selection.isCollapsed()) {
            return false
          }
          // Defer the mutation out of the read-only command phase.
          editor.update(() => {
            const current = $getSelection()
            if ($isRangeSelection(current) && !current.isCollapsed()) {
              $applyCapturedFormatToSelection(current, captured)
            }
          })
          formatPainterStore.afterApply()
          return false
        },
        COMMAND_PRIORITY_LOW,
      ),
      teardown,
    )
  }, [editor])

  return null
}
