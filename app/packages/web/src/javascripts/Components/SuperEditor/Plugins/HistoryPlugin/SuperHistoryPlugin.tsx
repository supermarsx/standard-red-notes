/**
 * Drop-in replacement for @lexical/react's HistoryPlugin that routes undo/redo
 * through a SuperHistoryStore, so the stacks are capped (MAX_HISTORY) and the
 * toolbar can show how many steps are available + jump back/forward many at once.
 */
import { useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { registerHistory } from '@lexical/history'
import { mergeRegister } from '@lexical/utils'
import { getSuperHistoryStore } from './SuperHistory'

export default function SuperHistoryPlugin({ delay = 1000 }: { delay?: number }): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const store = getSuperHistoryStore(editor)
    store.activate(editor)
    return mergeRegister(
      registerHistory(editor, store.historyState, delay),
      editor.registerUpdateListener(() => store.refresh()),
      () => store.deactivate(editor),
    )
  }, [editor, delay])

  return null
}
