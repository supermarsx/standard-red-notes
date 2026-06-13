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
        editable: !readonly,
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
