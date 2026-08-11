/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $createTextNode, $getRoot, type EditorState, type LexicalEditor } from 'lexical'
import { BlocksEditorComposer } from './BlocksEditorComposer'
import { CollaborationEditabilityPlugin } from './Collaboration/CollaborationEditabilityPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CaptureEditor = ({ capture }: { capture(editor: LexicalEditor): void }) => {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    capture(editor)
  }, [capture, editor])

  return null
}

describe('BlocksEditorComposer collaboration editability', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it.each([
    ['a collaborating editor awaiting canonical state', true, false, false],
    ['an ordinary writable editor', false, false, true],
    ['an ordinary readonly editor', false, true, false],
  ])('starts %s with Lexical editability set to %s', async (_description, collaborating, readonly, expected) => {
    let editor: LexicalEditor | undefined

    await act(async () => {
      root.render(
        <BlocksEditorComposer initialValue={undefined} collaborating={collaborating} readonly={readonly}>
          <CaptureEditor capture={(value) => (editor = value)} />
        </BlocksEditorComposer>,
      )
      await Promise.resolve()
    })

    expect(editor?.isEditable()).toBe(expected)
  })

  it('persists the remote-established snapshot once when its exact lease becomes canonical', async () => {
    let editor: LexicalEditor | undefined
    const persistedText: string[] = []
    const persist = (editorState: EditorState) => {
      editorState.read(() => persistedText.push($getRoot().getTextContent()))
    }
    const View = ({ ready }: { ready: boolean }) => (
      <BlocksEditorComposer initialValue={undefined} collaborating>
        <CaptureEditor capture={(value) => (editor = value)} />
        <CollaborationEditabilityPlugin
          editable={ready}
          canonicalReady={ready}
          collaborationLifetimeKey="note-a:lease-a"
          onCanonicalState={persist}
        />
      </BlocksEditorComposer>
    )

    await act(async () => {
      root.render(<View ready={false} />)
      await Promise.resolve()
    })
    act(() => {
      editor?.update(() => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('remote edit before sender disappears')))
      })
    })
    expect(persistedText).toEqual([])

    await act(async () => {
      root.render(<View ready />)
      await Promise.resolve()
    })
    expect(editor?.isEditable()).toBe(true)
    expect(persistedText).toEqual(['remote edit before sender disappears'])

    await act(async () => {
      root.render(<View ready />)
      await Promise.resolve()
    })
    expect(persistedText).toHaveLength(1)

    await act(async () => {
      root.render(<View ready={false} />)
      await Promise.resolve()
    })
    act(() => {
      editor?.update(() => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('remote edit after reconnect')))
      })
    })
    await act(async () => {
      root.render(<View ready />)
      await Promise.resolve()
    })
    expect(persistedText).toEqual(['remote edit before sender disappears', 'remote edit after reconnect'])
  })
})
