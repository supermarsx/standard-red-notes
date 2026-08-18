import {
  AssistantLiveSuperSnapshot,
  prepareAssistantLiveSuperPatch,
  readAssistantLiveSuperStructure,
  registerAssistantSuperNoteLiveBridge,
} from '@/Assistant/assistantSuperNoteLiveBridge'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getRoot, $isElementNode, LexicalNode } from 'lexical'
import { useEffect } from 'react'

function captureSnapshot(editor: ReturnType<typeof useLexicalComposerContext>[0]): AssistantLiveSuperSnapshot {
  const editorState = editor.getEditorState()
  let text = ''
  const pathsByNodeKey = new Map<string, readonly number[]>()
  editorState.read(() => {
    text = JSON.stringify(editorState.toJSON())
    const visit = (node: LexicalNode, path: readonly number[]) => {
      pathsByNodeKey.set(node.getKey(), path)
      if ($isElementNode(node)) {
        node.getChildren().forEach((child, index) => visit(child, [...path, index]))
      }
    }
    visit($getRoot(), [])
  })
  return { text, pathsByNodeKey }
}

/**
 * Bridge assistant structural reads to the mounted interactive Lexical editor.
 * It deliberately prepares rather than directly commits patches: the tool owns
 * the single item mutation/audit boundary, and SuperEditor's existing
 * AssistantChanged observer commits that mutation into Lexical/Yjs history.
 */
export function AssistantStructuralBridgePlugin({ noteUuid }: { noteUuid: string }): null {
  const [editor] = useLexicalComposerContext()

  useEffect(
    () =>
      registerAssistantSuperNoteLiveBridge(noteUuid, {
        read: (options) => readAssistantLiveSuperStructure(captureSnapshot(editor), options),
        preparePatch: (request, options) => prepareAssistantLiveSuperPatch(captureSnapshot(editor), request, options),
      }),
    [editor, noteUuid],
  )

  return null
}
