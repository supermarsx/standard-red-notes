/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNearestNodeOfType } from '@lexical/utils'
import { ListNode } from '@lexical/list'
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical'
import { useEffect } from 'react'

/**
 * Standard Red Notes: Tab inserts a real tab character at the caret (the expected
 * behavior in a document) rather than indenting/outdenting the whole block. The
 * ONE exception is inside a list, where Tab / Shift+Tab nest / outdent the list
 * item — the universal, element-appropriate behavior people expect there.
 */
export function TabIndentationPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand<KeyboardEvent>(
      KEY_TAB_COMMAND,
      (event) => {
        const selection = $getSelection()

        if (!$isRangeSelection(selection)) {
          return false
        }

        // Inside a list, keep nest/outdent (Tab nests, Shift+Tab outdents).
        const inList = $getNearestNodeOfType(selection.anchor.getNode(), ListNode) !== null
        if (inList) {
          event.preventDefault()
          return editor.dispatchCommand(event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND, undefined)
        }

        // Everywhere else: a literal tab character. Shift+Tab is a no-op (we don't
        // change the element), so let the browser/default handle focus if needed.
        if (event.shiftKey) {
          return false
        }
        event.preventDefault()
        selection.insertText('\t')
        return true
      },
      COMMAND_PRIORITY_EDITOR,
    )
  })

  return null
}
