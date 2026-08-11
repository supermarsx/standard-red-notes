import { FunctionComponent } from 'react'
import { LexicalComposer, InitialEditorStateType } from '@lexical/react/LexicalComposer'
import BlocksEditorTheme from './Lexical/Theme/Theme'
import { BlockEditorNodes } from './Lexical/Nodes/AllNodes'
import { Klass, LexicalNode } from 'lexical'

type BlocksEditorComposerProps = {
  initialValue: InitialEditorStateType | undefined
  children: React.ReactNode
  nodes?: Array<Klass<LexicalNode>>
  readonly?: boolean
  /**
   * When co-editing, the shared yjs doc — not initialValue — is the source of
   * truth, so the composer must start with a null editorState and let
   * CollaborationPlugin seed/sync content (otherwise content double-applies).
   */
  collaborating?: boolean
}

export const BlocksEditorComposer: FunctionComponent<BlocksEditorComposerProps> = ({
  initialValue,
  children,
  readonly,
  nodes = [],
  collaborating = false,
}) => {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'BlocksEditor',
        theme: BlocksEditorTheme,
        // A collaboration composer starts with an intentionally empty Y.Doc.
        // Keep Lexical itself non-editable until the encrypted provider proves
        // that canonical state was seeded or received; a DOM-only readonly flag
        // would still leave command/plugin mutation paths open.
        editable: !readonly && !collaborating,
        onError: (error: Error) => console.error(error),
        editorState: collaborating
          ? null
          : typeof initialValue === 'string' && initialValue.length === 0
            ? undefined
            : initialValue,
        nodes: [...nodes, ...BlockEditorNodes],
      }}
    >
      <>{children}</>
    </LexicalComposer>
  )
}
