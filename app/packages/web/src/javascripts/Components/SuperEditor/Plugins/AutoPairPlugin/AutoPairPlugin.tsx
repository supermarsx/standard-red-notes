import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  TextNode,
} from 'lexical'
import { useEffect } from 'react'

import { decideBackspace, decideInsertion, Selection } from '../../Utils/AutoPair/autoPair'

/**
 * AutoPairPlugin
 *
 * Auto-pairs brackets and quotes in the Super (Lexical) editor:
 *
 *   - Typing an opener `( [ { " ' \`` with a collapsed caret inserts the matching
 *     closer and leaves the caret between the two.
 *   - Typing an opener while text is selected WRAPS the selection in the pair,
 *     keeping the inner text selected.
 *   - Typing a closer when the very next character is that same closer "types
 *     over" it (advances the caret rather than inserting a duplicate).
 *   - Backspace with a collapsed caret sitting between an empty matching pair
 *     deletes both characters.
 *
 * All decision logic lives in the pure, unit-tested `autoPair` helper. This
 * plugin only adapts the current Lexical selection into the helper's
 * string+offset abstraction (scoped to the caret's own text node) and applies
 * the resulting action through Lexical selection APIs inside a single
 * `editor.update()` so each gesture is one undo step.
 *
 * IME / composition: keystroke insertion is handled via a `beforeinput`
 * listener on the editor root which ignores composing input (`isComposing` and
 * non-`insertText` input types), so multi-key IME composition is never
 * auto-paired. Backspace is handled via Lexical's KEY_BACKSPACE_COMMAND.
 *
 * Key-clash note: this plugin reacts to printable single characters and
 * Backspace only. The Foldable / MultiCursor / Toolbar plugins react to clicks
 * and modifier chords (Cmd/Ctrl+…), so there is no overlap.
 */

type LocalContext = {
  node: TextNode
  text: string
  selection: Selection
}

/**
 * Reads the current selection as a string + offsets scoped to the caret's text
 * node. We deliberately scope to a single text node: it gives correct neighbour
 * characters for the common case and avoids reaching across inline-format runs
 * or block boundaries. Returns null when the selection isn't a simple range with
 * both ends in the same text node.
 */
function $readLocalContext(): LocalContext | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) {
    return null
  }
  const { anchor, focus } = selection
  if (anchor.key !== focus.key) {
    return null
  }
  const node = anchor.getNode()
  if (!$isTextNode(node)) {
    return null
  }
  const text = node.getTextContent()
  const start = Math.min(anchor.offset, focus.offset)
  const end = Math.max(anchor.offset, focus.offset)
  return { node, text, selection: { start, end } }
}

export default function AutoPairPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    /**
     * Handle a printable character before the browser inserts it. The pure
     * helper decides the action; anything other than `none` prevents the default
     * input and is applied through Lexical instead.
     */
    const onBeforeInput = (event: InputEvent) => {
      // Single printable characters only; ignore IME composition + non-inserts.
      if (event.isComposing) {
        return
      }
      if (event.inputType !== 'insertText') {
        return
      }
      const char = event.data
      if (char === null || char.length !== 1) {
        return
      }

      let handled = false
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        const local = $readLocalContext()
        if (!local) {
          return
        }

        const action = decideInsertion(char, { text: local.text, selection: local.selection })
        switch (action.type) {
          case 'insert-pair': {
            selection.insertText(action.open + action.close)
            const after = $getSelection()
            if ($isRangeSelection(after)) {
              const node = after.anchor.getNode()
              if ($isTextNode(node)) {
                const offset = after.anchor.offset - action.close.length
                after.setTextNodeRange(node, offset, node, offset)
              }
            }
            handled = true
            break
          }
          case 'wrap-selection': {
            const inner = selection.getTextContent()
            selection.insertText(action.open + inner + action.close)
            const after = $getSelection()
            if ($isRangeSelection(after)) {
              const node = after.anchor.getNode()
              if ($isTextNode(node)) {
                const end = after.anchor.offset - action.close.length
                const begin = end - inner.length
                after.setTextNodeRange(node, begin, node, end)
              }
            }
            handled = true
            break
          }
          case 'type-over': {
            const offset = local.selection.start + 1
            selection.setTextNodeRange(local.node, offset, local.node, offset)
            handled = true
            break
          }
          case 'none':
          default:
            break
        }
      })

      if (handled) {
        event.preventDefault()
      }
    }

    const onRoot = (root: HTMLElement | null, prevRoot: HTMLElement | null) => {
      prevRoot?.removeEventListener('beforeinput', onBeforeInput as EventListener)
      root?.addEventListener('beforeinput', onBeforeInput as EventListener)
    }

    return mergeRegister(
      editor.registerRootListener(onRoot),
      // Backspace: delete an empty surrounding pair in one undo step.
      editor.registerCommand<KeyboardEvent>(
        KEY_BACKSPACE_COMMAND,
        () => {
          let handled = false
          editor.update(() => {
            const selection = $getSelection()
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
              return
            }
            const local = $readLocalContext()
            if (!local) {
              return
            }
            const action = decideBackspace({ text: local.text, selection: local.selection })
            if (action.type !== 'delete-pair') {
              return
            }
            const node = local.node
            const text = node.getTextContent()
            const caret = local.selection.start
            const updated = text.slice(0, caret - 1) + text.slice(caret + 1)
            node.setTextContent(updated)
            const after = $getSelection()
            if ($isRangeSelection(after)) {
              after.setTextNodeRange(node, caret - 1, node, caret - 1)
            }
            handled = true
          })
          return handled
        },
        COMMAND_PRIORITY_HIGH,
      ),
    )
  }, [editor])

  return null
}
