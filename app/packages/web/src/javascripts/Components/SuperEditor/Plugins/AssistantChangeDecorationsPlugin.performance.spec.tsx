/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $createTextNode, $getRoot, LexicalEditor } from 'lexical'
import { NoteType } from '@standardnotes/snjs'
import { AssistantChangeDecorationsPlugin } from './AssistantChangeDecorationsPlugin'

let mockLedger: unknown
jest.mock('@/Assistant/useAssistantChangeLedger', () => ({ useAssistantChangeLedger: () => mockLedger }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('skips full-document serialization for selection-only updates while retaining content-change validation', () => {
  jest.useFakeTimers()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let editor: LexicalEditor
  let serialize: jest.SpyInstance | undefined
  function Seed() {
    const [current] = useLexicalComposerContext()
    useEffect(() => {
      editor = current
      current.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Assistant text'))), {
        discrete: true,
      })
      const after = {
        title: 'Test note',
        text: JSON.stringify(current.getEditorState().toJSON()),
        previewPlain: 'Assistant text',
        noteType: NoteType.Super,
      }
      mockLedger = {
        note: { uuid: 'note', ...after, preview_plain: after.previewPlain },
        records: [
          {
            changeId: 'change',
            noteUuid: 'note',
            status: 'applied',
            createdAt: new Date().toISOString(),
            operations: [{ affected: [{ path: [0] }] }],
            undo: { after },
          },
        ],
      }
    }, [current])
    return null
  }
  mockLedger = { records: [] }
  const render = () =>
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: 'ai-highlight-performance',
          onError: (error) => {
            throw error
          },
        }}
      >
        <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
        <Seed />
        <AssistantChangeDecorationsPlugin noteUuid="note" />
      </LexicalComposer>,
    )
  try {
    act(render)
    act(render)
    act(() => jest.advanceTimersByTime(0))
    expect(container.querySelector('[data-assistant-change-marker]')).not.toBeNull()
    serialize = jest.spyOn(Object.getPrototypeOf(editor!.getEditorState()), 'toJSON')
    act(() => editor!.update(() => $getRoot().getFirstChild()?.selectEnd(), { discrete: true }))
    expect(serialize).not.toHaveBeenCalled()
    act(() =>
      editor!.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Human edit'))), {
        discrete: true,
      }),
    )
    expect(serialize).toHaveBeenCalled()
  } finally {
    serialize?.mockRestore()
    act(() => root.unmount())
    container.remove()
    jest.useRealTimers()
  }
})
