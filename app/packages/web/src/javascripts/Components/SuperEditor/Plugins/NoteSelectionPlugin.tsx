import { useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  LexicalEditor,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { createDOMRange } from '@lexical/selection'
import { ownSuperEditorElement } from '../ownSuperEditorElements'
import { $selectAllText } from './ToolbarPlugin/selectAllText'

/** Select note contents in both Lexical and the browser, including read mode. */
export function selectNoteContents(editor: LexicalEditor, textOnly = false): boolean {
  const root = editor.getRootElement()
  if (!root) {
    return false
  }
  root.focus({ preventScroll: true })
  editor.update(
    () => {
      if (textOnly) {
        $selectAllText()
      } else {
        const document = $getRoot()
        document.select(0, document.getChildrenSize())
      }
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
  const range = editor.getEditorState().read(() => {
    const selection = $getSelection()
    return $isRangeSelection(selection)
      ? createDOMRange(
          editor,
          selection.anchor.getNode(),
          selection.anchor.offset,
          selection.focus.getNode(),
          selection.focus.offset,
        )
      : null
  })
  if (range) {
    const selection = root.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  return true
}

export function registerNoteSelection(editor: LexicalEditor): () => void {
  let cleanup: () => void = () => undefined
  const stop = editor.registerRootListener((root) => {
    cleanup()
    if (!root) {
      cleanup = () => undefined
      return
    }
    const document = root.ownerDocument
    const originalTabIndex = root.getAttribute('tabindex')
    if (originalTabIndex === null) {
      root.tabIndex = 0
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== 'a' ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      ) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [role="textbox"]:not(.ContentEditable__root)')) {
        return
      }
      const nestedEditor = target?.closest('[contenteditable="true"], [contenteditable="plaintext-only"]')
      if (nestedEditor && nestedEditor !== root) {
        return
      }
      const surface = ownSuperEditorElement(root) ?? root
      const selection = document.getSelection()
      const inNote = target && surface.contains(target)
      const selectionInNote =
        (target === document.body || target === document.documentElement) &&
        root.contains(selection?.anchorNode ?? null) &&
        root.contains(selection?.focusNode ?? null)
      if (!inNote && !selectionInNote) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      selectNoteContents(editor)
    }
    const selectionChanged = () => {
      if (editor.isEditable()) {
        return
      }
      const selection = document.getSelection()
      if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        return
      }
      const range = selection.getRangeAt(0)
      editor.update(
        () => {
          const next = $createRangeSelection()
          try {
            next.applyDOMRange(range)
          } catch {
            return
          }
          const current = $getSelection()
          if (!current?.is(next)) {
            $setSelection(next)
          }
        },
        { tag: SKIP_DOM_SELECTION_TAG },
      )
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('selectionchange', selectionChanged)
    cleanup = () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('selectionchange', selectionChanged)
      if (originalTabIndex === null && root.getAttribute('tabindex') === '0') {
        root.removeAttribute('tabindex')
      }
    }
  })
  return () => {
    stop()
    cleanup()
  }
}

export default function NoteSelectionPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerNoteSelection(editor), [editor])
  return null
}
