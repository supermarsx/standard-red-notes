import { FunctionComponent, useEffect, useRef } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { EditorState } from 'lexical'

type Props = {
  editable: boolean
  canonicalReady: boolean
  collaborationLifetimeKey?: string
  onCanonicalState?(editorState: EditorState): void
}

/**
 * Keep Lexical closed until the exact provider lifetime owns canonical state.
 * When that transition succeeds, hand the already-established editor snapshot
 * to ordinary encrypted persistence exactly once. Reading/serializing this
 * state does not create another Lexical or Yjs update.
 */
export const CollaborationEditabilityPlugin: FunctionComponent<Props> = ({
  editable,
  canonicalReady,
  collaborationLifetimeKey,
  onCanonicalState,
}) => {
  const [editor] = useLexicalComposerContext()
  const previousLifetime = useRef<string | undefined>(undefined)
  const wasCanonicalReady = useRef(false)

  useEffect(() => {
    const lifetimeChanged = previousLifetime.current !== collaborationLifetimeKey
    const becameCanonical =
      Boolean(collaborationLifetimeKey) && canonicalReady && (!wasCanonicalReady.current || lifetimeChanged)

    editor.setEditable(editable)
    previousLifetime.current = collaborationLifetimeKey
    wasCanonicalReady.current = canonicalReady

    if (becameCanonical) {
      onCanonicalState?.(editor.getEditorState())
    }
  }, [canonicalReady, collaborationLifetimeKey, editable, editor, onCanonicalState])

  return null
}
