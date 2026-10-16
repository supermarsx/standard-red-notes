/** @jest-environment jsdom */
import { act, type ReactNode, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { NoteType } from '@standardnotes/snjs'
import { MessageBubble, type ToolEntry } from './ConversationPanel'
import AssistantChangeDiff from './AssistantChangeDiff'
import AssistantMessageContent from './AssistantMessageContent'

jest.mock('./AssistantMessageActions', () => ({
  __esModule: true,
  default: ({ children }: { children: (ref: RefObject<HTMLDivElement | null>) => ReactNode }) => (
    <div>{children({ current: null })}</div>
  ),
}))
jest.mock('./AssistantChangeDiff', () => ({ __esModule: true, default: jest.fn(() => null) }))
jest.mock('./AssistantMessageContent', () => ({ __esModule: true, default: jest.fn(() => null) }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps historical messages and unchanged tool cards out of repeated stream renders', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const apply = jest.fn()
  const remove = jest.fn()
  const snapshot = { title: 'Note', text: 'old', previewPlain: 'old', noteType: NoteType.Plain }
  const tool: ToolEntry = {
    id: 'change',
    name: 'notes.update',
    args: {},
    outcome: 'succeeded',
    noteChange: {
      noteUuid: 'note',
      noteTitle: 'Note',
      before: snapshot,
      after: snapshot,
      patch: Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n'),
      addedLines: 5000,
      removedLines: 0,
      truncated: false,
    },
  }
  const history = { id: 'old', kind: 'assistant' as const, text: 'Earlier answer', tools: [tool] }
  let active = { id: 'live', kind: 'assistant' as const, text: 'Now', tools: [tool], streaming: true }
  const render = () =>
    root.render(
      <>
        <MessageBubble message={history} onApplyNoteChange={apply} onRemoveMessage={remove} />
        <MessageBubble message={active} onApplyNoteChange={apply} onRemoveMessage={remove} />
      </>,
    )
  try {
    act(render)
    expect(AssistantChangeDiff).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 30; i++) {
      active = { ...active, text: active.text + ' next', tools: [...active.tools] }
      act(render)
    }
    // Both old and active tool references are unchanged; their diff render work stays fixed.
    expect(AssistantChangeDiff).toHaveBeenCalledTimes(2)
    const contentCalls = jest.mocked(AssistantMessageContent).mock.calls
    expect(contentCalls.filter(([props]) => props.text === 'Earlier answer')).toHaveLength(1)
    expect(contentCalls).toHaveLength(32)
    active = { ...active, tools: [{ ...tool, noteChangePending: true }] }
    act(render)
    expect(AssistantChangeDiff).toHaveBeenCalledTimes(3)
  } finally {
    act(() => root.unmount())
  }
})
