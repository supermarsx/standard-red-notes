/**
 * Standard Red Notes: FormattingMarksPlugin — Word's ¶ button.
 *
 * Toggles a `show-formatting-marks` class on the Lexical editor root element.
 * The accompanying FormattingMarks.css renders pilcrows after blocks, soft
 * line-break arrows, and (optionally) space middots purely via pseudo-elements,
 * so the SAVED note content is never touched — only the on-screen rendering.
 *
 * Exposes:
 *  - <FormattingMarksPlugin/>            — drop-in plugin that keeps the root
 *                                          element's class in sync with state and
 *                                          registers the toggle command.
 *  - TOGGLE_FORMATTING_MARKS_COMMAND     — Lexical command to flip the toggle.
 *  - useFormattingMarks()                — hook returning [enabled, toggle] for a
 *                                          toolbar button's active state + action.
 *
 * Pattern mirrors AutoFocusPlugin (root-element side effect) and
 * CheckListAutoMovePlugin/autoMoveSetting (web-local persisted toggle + pub/sub).
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_LOW, createCommand, LexicalCommand } from 'lexical'
import { useCallback, useEffect, useState } from 'react'
import './FormattingMarks.css'
import {
  getFormattingMarksEnabled,
  setFormattingMarksEnabled,
  SHOW_FORMATTING_MARKS_CLASS,
  subscribeFormattingMarks,
  toggleFormattingMarksEnabled,
} from './formattingMarksSetting'

/**
 * Toggle the formatting marks. Payload:
 *  - `boolean`  -> set to that explicit value
 *  - `undefined`-> flip the current value
 */
export const TOGGLE_FORMATTING_MARKS_COMMAND: LexicalCommand<boolean | undefined> = createCommand(
  'TOGGLE_FORMATTING_MARKS_COMMAND',
)

/**
 * React hook exposing the current state and a toggle, kept in sync across tabs
 * and other consumers via the shared pub/sub. Use this to drive a toolbar
 * button's `active` flag and `onSelect`.
 */
export function useFormattingMarks(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(() => getFormattingMarksEnabled())

  useEffect(() => subscribeFormattingMarks(() => setEnabled(getFormattingMarksEnabled())), [])

  const toggle = useCallback(() => {
    toggleFormattingMarksEnabled()
  }, [])

  return [enabled, toggle]
}

export default function FormattingMarksPlugin(): null {
  const [editor] = useLexicalComposerContext()
  const [enabled, setEnabled] = useState(() => getFormattingMarksEnabled())

  // Keep local state in sync with the persisted setting (same-tab + cross-tab).
  useEffect(() => subscribeFormattingMarks(() => setEnabled(getFormattingMarksEnabled())), [])

  // Allow toggling via a Lexical command so other UI (toolbar, shortcuts) can
  // drive it without importing the setting module directly.
  useEffect(() => {
    return editor.registerCommand<boolean | undefined>(
      TOGGLE_FORMATTING_MARKS_COMMAND,
      (payload) => {
        const next = typeof payload === 'boolean' ? payload : !getFormattingMarksEnabled()
        // setFormattingMarksEnabled fires the change event, which updates `enabled`
        // through the subscription above (and any useFormattingMarks consumers).
        setFormattingMarksEnabled(next)
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor])

  // Reflect `enabled` onto the current root element. registerRootListener fires
  // immediately with the current root and again whenever it changes, so the
  // class survives editor re-mounts. We also reconcile on `enabled` changes.
  useEffect(() => {
    const apply = (root: HTMLElement | null) => {
      if (!root) {
        return
      }
      root.classList.toggle(SHOW_FORMATTING_MARKS_CLASS, enabled)
    }

    apply(editor.getRootElement())

    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.classList.remove(SHOW_FORMATTING_MARKS_CLASS)
      apply(rootElement)
    })
  }, [editor, enabled])

  return null
}
