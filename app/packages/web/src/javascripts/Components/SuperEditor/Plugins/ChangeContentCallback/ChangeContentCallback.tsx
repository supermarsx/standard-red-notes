import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import React, { useEffect } from 'react'

export type ChangeEditorFunction = (jsonContent: string, onUpdate?: () => void) => void
type ChangeEditorFunctionProvider = (changeEditorFunction: ChangeEditorFunction) => () => void

export function registerLatestChangeEditorFunction(
  target: { current: ChangeEditorFunction | undefined },
  callback: ChangeEditorFunction,
): () => void {
  target.current = callback
  return () => {
    if (target.current === callback) {
      target.current = undefined
    }
  }
}

export function ChangeContentCallbackPlugin({
  providerCallback,
}: {
  providerCallback: ChangeEditorFunctionProvider
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const changeContents: ChangeEditorFunction = (jsonContent: string, onUpdate?: () => void) => {
      editor.update(
        () => {
          const editorState = editor.parseEditorState(jsonContent)
          editor.setEditorState(editorState)
        },
        { discrete: true, onUpdate },
      )
    }

    return providerCallback(changeContents)
  }, [editor, providerCallback])

  return null
}
