/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NoteType } from '@standardnotes/snjs'
import { ToolActivity, ToolEntry } from './ConversationPanel'

jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => <span /> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('assistant note change activity', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the git-style diff and exposes guarded undo and redo controls', () => {
    const onApply = jest.fn()
    const tool: ToolEntry = {
      id: 'call-1',
      name: 'notes.update',
      args: { uuid: 'redacted' },
      outcome: 'succeeded',
      noteChangePosition: 'after',
      noteChange: {
        noteUuid: 'note-1',
        noteTitle: 'Plan',
        before: {
          title: 'Plan',
          text: 'old',
          previewPlain: 'old',
          noteType: NoteType.Plain,
        },
        after: {
          title: 'Plan',
          text: 'new',
          previewPlain: 'new',
          noteType: NoteType.Plain,
        },
        patch: 'diff --git a/note.md b/note.md\n--- a/note.md\n+++ b/note.md\n@@ -1,1 +1,1 @@\n-old\n+new',
        addedLines: 1,
        removedLines: 1,
        truncated: false,
      },
    }

    act(() => root.render(<ToolActivity tool={tool} onApplyNoteChange={onApply} />))

    expect(container.textContent).toContain('Changes · +1 −1')
    expect(container.querySelector('pre')?.textContent).toContain('-old+new')
    const [undo, redo] = Array.from(container.querySelectorAll('button'))
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
    act(() => undo.click())
    expect(onApply).toHaveBeenCalledWith('call-1', 'undo')
  })
})
