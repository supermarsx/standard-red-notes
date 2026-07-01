/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNearestNodeOfType } from '@lexical/utils'
import { $isListItemNode, ListItemNode } from '@lexical/list'
import { $isCodeNode, CodeNode } from '@lexical/code'
import {
  $createTabNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  LexicalEditor,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical'
import { useEffect } from 'react'

/**
 * Registers the Super editor's Tab behavior on a given editor and returns the
 * unregister function. Extracted from the React plugin so it can be exercised
 * directly in headless tests (see TabIndentation.spec.ts).
 *
 * Standard Red Notes: Tab inserts a real tab character at the caret (the
 * expected behavior in a document) rather than indenting/outdenting the whole
 * block. The ONE exception is inside a list, where Tab / Shift+Tab nest /
 * outdent the list item — but ONLY when that item can actually nest/outdent.
 *
 * THE BUG THIS FIXES (Tab fully hangs the app):
 * The previous version indented whenever the caret was anywhere in a list. But a
 * list item that is the FIRST item of its list has no preceding sibling to nest
 * under, so dispatching INDENT_CONTENT_COMMAND there asks Lexical to perform an
 * impossible nest. In the browser the resulting DOM reconcile of the un-nestable
 * indent never settles and the main thread spins forever (the freeze). Headless
 * Lexical doesn't reconcile DOM, which is why it only reproduces in the app /
 * Playwright. The fix: only nest when the item HAS a previous list-item sibling,
 * and only outdent when the item is actually nested (indent > 0 or its parent
 * list is itself nested). Otherwise fall through to inserting a tab character,
 * which is this editor's primary, documented Tab behavior anyway.
 */
export function registerTabIndentation(editor: LexicalEditor): () => void {
  return editor.registerCommand<KeyboardEvent>(
    KEY_TAB_COMMAND,
    (event) => {
      const selection = $getSelection()

      if (!$isRangeSelection(selection)) {
        return false
      }

      // Resolve the enclosing list item, if any.
      const listItem = $getNearestNodeOfType(selection.anchor.getNode(), ListItemNode)
      if ($isListItemNode(listItem)) {
        if (event.shiftKey) {
          // Outdent only when the item is genuinely nested; otherwise a tab is the
          // safe, non-looping choice (Shift+Tab on a top-level item is a no-op
          // here, leaving focus navigation to the browser).
          const canOutdent = listItem.getIndent() > 0 || $isListItemNode(listItem.getParent()?.getParent())
          if (canOutdent) {
            event.preventDefault()
            editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)
            return true
          }
          return false
        }

        // Indent (nest) ONLY when there is a previous list-item sibling to nest
        // under. Indenting an un-nestable first item is exactly what froze the UI.
        const canIndent = $isListItemNode(listItem.getPreviousSibling())
        if (canIndent) {
          // Dispatch the indent and only consume the Tab if a handler actually
          // applied it. If the indent is blocked (e.g. already at the editor's
          // max indent depth), `dispatchCommand` reports unhandled — in that case
          // we must NOT preventDefault/return true, or Tab would be silently
          // swallowed at max depth (a no-op). Instead fall through and insert a
          // tab character so Tab always does something.
          const indented = editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)
          if (indented) {
            event.preventDefault()
            return true
          }
        }
        // Not nestable (or indent blocked at max depth): fall through and insert a
        // tab character instead.
      }

      // Inside a Super CODE BLOCK, defer to @lexical/code's own KEY_TAB_COMMAND
      // handler (registered by registerCodeHighlighting at COMMAND_PRIORITY_LOW)
      // which performs code-aware line indent/outdent. Returning false here lets
      // that lower-priority handler run; otherwise Tab would just drop a literal
      // TabNode and Shift+Tab would do nothing inside code.
      const anchorNode = selection.anchor.getNode()
      const codeNode = $isCodeNode(anchorNode) ? anchorNode : $getNearestNodeOfType(anchorNode, CodeNode)
      if ($isCodeNode(codeNode)) {
        return false
      }

      // Outside a list (or a non-nestable list item): a literal tab character.
      // Shift+Tab is a no-op (we don't change the element), so let the browser
      // handle focus navigation if needed.
      if (event.shiftKey) {
        return false
      }
      event.preventDefault()
      // Insert a real TabNode rather than `insertText('\t')`. Lexical models a
      // tab as a dedicated, unmergeable TabNode (exactly what rich-text's
      // INSERT_TAB_COMMAND does); pushing a raw '\t' string through
      // selection.insertText is not the supported representation.
      $insertNodes([$createTabNode()])
      return true
    },
    COMMAND_PRIORITY_EDITOR,
  )
}

export function TabIndentationPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return registerTabIndentation(editor)
  }, [editor])

  return null
}
