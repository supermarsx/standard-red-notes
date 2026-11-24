import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $addUpdateTag,
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  HISTORY_PUSH_TAG,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
  type RangeSelection,
  type TextNode,
} from 'lexical'
import { useEffect } from 'react'
import { decideBackspace, decideInsertion, type Selection } from '../../Utils/AutoPair/autoPair'

type LocalContext = { node?: TextNode; text: string; selection: Selection }

/** Neighbours for a collapsed caret, including the empty paragraph before its first keystroke. */
function $readLocalContext(selection: RangeSelection): LocalContext | undefined {
  const { anchor, focus } = selection
  if (anchor.key !== focus.key) {
    return undefined
  }
  const node = anchor.getNode()
  if ($isTextNode(node)) {
    return {
      node,
      text: node.getTextContent(),
      selection: { start: Math.min(anchor.offset, focus.offset), end: Math.max(anchor.offset, focus.offset) },
    }
  }
  if ($isElementNode(node) && node.isEmpty()) {
    return { text: '', selection: { start: 0, end: 0 } }
  }
  return undefined
}

/** Insert only the boundaries: never replace selected runs, links, list structure or their formatting. */
function $wrapSelection(selection: RangeSelection, open: string, close: string): boolean {
  const backward = selection.isBackward()
  const textNodes = selection.extract().filter($isTextNode)
  const first = textNodes[0]
  const last = textNodes[textNodes.length - 1]
  if (!first || !last) {
    return false
  }
  first.insertBefore($createTextNode(open))
  last.insertAfter($createTextNode(close))
  if (backward) {
    selection.setTextNodeRange(last, last.getTextContentSize(), first, 0)
  } else {
    selection.setTextNodeRange(first, 0, last, last.getTextContentSize())
  }
  return true
}

/** Pair through Lexical's input commands, before its ordinary insertion can alter the selection. */
export function registerAutoPair(editor: LexicalEditor): () => void {
  const insert = (char: string): boolean => {
    if (!editor.isEditable() || editor.isComposing() || char.length !== 1) {
      return false
    }
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      return false
    }
    if (!selection.isCollapsed()) {
      const text = selection.getTextContent()
      const action = decideInsertion(char, { text, selection: { start: 0, end: text.length } })
      if (action.type !== 'wrap-selection') {
        return false
      }
      const handled = $wrapSelection(selection, action.open, action.close)
      if (handled) {
        $addUpdateTag(HISTORY_PUSH_TAG)
      }
      return handled
    }
    const local = $readLocalContext(selection)
    if (!local) {
      return false
    }
    const action = decideInsertion(char, local)
    if (action.type === 'insert-pair') {
      $addUpdateTag(HISTORY_PUSH_TAG)
      selection.insertText(action.open + action.close)
      const after = $getSelection()
      if ($isRangeSelection(after)) {
        const node = after.anchor.getNode()
        if ($isTextNode(node)) {
          const offset = after.anchor.offset - action.close.length
          after.setTextNodeRange(node, offset, node, offset)
        }
      }
      return true
    }
    if (action.type === 'type-over' && local.node) {
      const offset = local.selection.start + 1
      selection.setTextNodeRange(local.node, offset, local.node, offset)
      return true
    }
    return false
  }

  return mergeRegister(
    editor.registerCommand(
      BEFORE_INPUT_COMMAND,
      (event) => {
        if (event.isComposing || event.inputType !== 'insertText' || !event.data || !insert(event.data)) {
          return false
        }
        event.preventDefault()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // Covers input engines that deliver controlled insertion without beforeinput.
    // Replacement text, paste and composition remain ordinary editor operations.
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      (eventOrText) => {
        if (typeof eventOrText === 'string') {
          return insert(eventOrText)
        }
        if (
          eventOrText.isComposing ||
          eventOrText.inputType !== 'insertText' ||
          eventOrText.dataTransfer ||
          !eventOrText.data
        ) {
          return false
        }
        const handled = insert(eventOrText.data)
        if (handled) {
          eventOrText.preventDefault()
        }
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      () => {
        if (!editor.isEditable() || editor.isComposing()) {
          return false
        }
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false
        }
        const local = $readLocalContext(selection)
        if (!local?.node || decideBackspace(local).type !== 'delete-pair') {
          return false
        }
        $addUpdateTag(HISTORY_PUSH_TAG)
        const caret = local.selection.start
        local.node.spliceText(caret - 1, 2, '')
        selection.setTextNodeRange(local.node, caret - 1, local.node, caret - 1)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    ),
  )
}

/** Auto-pair brackets and quotes, preserving selected content, formatting and IME input. */
export default function AutoPairPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerAutoPair(editor), [editor])
  return null
}
