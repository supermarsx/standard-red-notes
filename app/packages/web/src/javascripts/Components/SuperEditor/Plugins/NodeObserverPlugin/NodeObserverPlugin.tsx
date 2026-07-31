import { useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $nodesOfType, EditorState, LexicalEditor } from 'lexical'
import { mergeRegister } from '@lexical/utils'
import { FileNode } from '../EncryptedFilePlugin/Nodes/FileNode'
import { BubbleNode } from '../ItemBubblePlugin/Nodes/BubbleNode'

export type EditorReferenceChanges = Readonly<{
  added: readonly string[]
  removed: readonly string[]
}>

export type EditorReferenceCounts = ReadonlyMap<string, number>

/**
 * Counts every item reference represented in the committed editor state. A UUID
 * may occur more than once, and may be represented by both a BubbleNode and a
 * FileNode. Relationship mutations therefore happen on zero-to-one and
 * one-to-zero transitions, rather than on individual node mutations.
 */
export function getEditorReferenceCounts(editorState: EditorState): EditorReferenceCounts {
  return editorState.read(() => {
    const counts = new Map<string, number>()
    const referencedUuids = [
      ...$nodesOfType(BubbleNode).map((node) => node.getId()),
      ...$nodesOfType(FileNode).map((node) => node.getId()),
    ]

    for (const uuid of referencedUuids) {
      counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
    }

    return counts
  })
}

export function diffEditorReferenceCounts(
  previous: EditorReferenceCounts,
  current: EditorReferenceCounts,
): EditorReferenceChanges {
  const added = [...current.keys()].filter((uuid) => !previous.has(uuid))
  const removed = [...previous.keys()].filter((uuid) => !current.has(uuid))

  return { added, removed }
}

/**
 * Observes complete committed states instead of individual destroyed-node
 * callbacks. This makes duplicate references safe, handles BubbleNode/FileNode
 * mixtures as one set, and naturally emits the inverse transition on undo/redo.
 * No node-key bookkeeping survives a commit or an editor unmount.
 */
export function registerEditorReferenceObserver(
  editor: LexicalEditor,
  onChange: (changes: EditorReferenceChanges) => void,
): () => void {
  return mergeRegister(
    // Registering these listeners makes Lexical include per-class mutations in
    // the update payload. skipInitialization avoids treating the loaded note as
    // a user-created set of references.
    editor.registerMutationListener(BubbleNode, () => undefined, { skipInitialization: true }),
    editor.registerMutationListener(FileNode, () => undefined, { skipInitialization: true }),
    editor.registerUpdateListener(({ editorState, mutatedNodes, prevEditorState }) => {
      const hasBubbleMutation = (mutatedNodes?.get(BubbleNode)?.size ?? 0) > 0
      const hasFileMutation = (mutatedNodes?.get(FileNode)?.size ?? 0) > 0

      // Ordinary typing, selection, and formatting commits do not touch item
      // nodes. Avoid an O(document-size) scan on that editor hot path.
      if (!hasBubbleMutation && !hasFileMutation) {
        return
      }

      const changes = diffEditorReferenceCounts(
        getEditorReferenceCounts(prevEditorState),
        getEditorReferenceCounts(editorState),
      )

      if (changes.added.length > 0 || changes.removed.length > 0) {
        onChange(changes)
      }
    }),
  )
}

type ObserverProps = {
  onChange: (changes: EditorReferenceChanges) => void
}

export function NodeObserverPlugin({ onChange }: ObserverProps) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerEditorReferenceObserver(editor, onChange), [editor, onChange])

  return null
}
