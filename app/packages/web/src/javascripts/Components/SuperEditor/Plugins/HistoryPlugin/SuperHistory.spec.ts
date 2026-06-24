/**
 * @jest-environment jsdom
 *
 * Headless-editor tests for the Super editor's introspectable history store:
 * stack-depth tracking, the 500-entry cap, multi-step undo/redo jumps, step
 * previews, and reset on deactivate. These drive a real Lexical editor +
 * registerHistory so we verify the store reflects actual undo/redo behavior.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { registerHistory } from '@lexical/history'
import { mergeRegister } from '@lexical/utils'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'

import { MAX_HISTORY, SuperHistoryStore } from './SuperHistory'

const makeEditorWithStore = () => {
  const editor = createHeadlessEditor({
    namespace: 'SuperHistoryTest',
    nodes: [],
    onError: (error) => {
      throw error
    },
  })
  const store = new SuperHistoryStore()
  store.activate(editor)
  // delay 0 so each discrete edit is its own undo step (no time-based coalescing).
  const unregister = mergeRegister(
    registerHistory(editor, store.historyState, 0),
    editor.registerUpdateListener(() => store.refresh()),
  )
  // Seed an initial paragraph so the first content edit has a prior state.
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('seed')))
    },
    { discrete: true },
  )
  const typeLine = (text: string) =>
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode(text)))
      },
      { discrete: true },
    )
  return { editor, store, unregister, typeLine }
}

describe('SuperHistoryStore depth tracking', () => {
  it('increases undo depth as edits are made and reflects it in the snapshot', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    const before = store.getSnapshot().undoDepth
    typeLine('a')
    typeLine('b')
    typeLine('c')
    expect(store.getSnapshot().undoDepth).toBeGreaterThan(before)
    expect(store.getSnapshot().undoDepth).toBeGreaterThanOrEqual(3)
    unregister()
  })

  it('notifies subscribers when depth changes', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    const listener = jest.fn()
    const unsub = store.subscribe(listener)
    typeLine('x')
    expect(listener).toHaveBeenCalled()
    unsub()
    unregister()
  })
})

describe('SuperHistoryStore 500-entry cap', () => {
  it('never lets the undo stack exceed MAX_HISTORY', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    for (let i = 0; i < MAX_HISTORY + 120; i++) {
      typeLine(`line-${i}`)
    }
    expect(store.getSnapshot().undoDepth).toBe(MAX_HISTORY)
    unregister()
  })
})

describe('SuperHistoryStore multi-step jumps', () => {
  it('undo(n) moves n entries from the undo stack to the redo stack', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    typeLine('c')
    typeLine('d')
    const undoBefore = store.getSnapshot().undoDepth
    store.undo(3)
    expect(store.getSnapshot().undoDepth).toBe(undoBefore - 3)
    expect(store.getSnapshot().redoDepth).toBe(3)
    unregister()
  })

  it('redo(n) replays from the redo stack', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    typeLine('c')
    store.undo(2)
    const redoBefore = store.getSnapshot().redoDepth
    store.redo(2)
    expect(store.getSnapshot().redoDepth).toBe(redoBefore - 2)
    unregister()
  })

  it('clamps a jump larger than the available depth', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    expect(() => store.undo(999)).not.toThrow()
    expect(store.getSnapshot().undoDepth).toBe(0)
    unregister()
  })

  it('reflects the undone content in the editor after a multi-step undo', () => {
    const { editor, store, unregister, typeLine } = makeEditorWithStore()
    typeLine('first')
    typeLine('second')
    typeLine('third')
    store.undo(2)
    const text = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toContain('first')
    expect(text).not.toContain('third')
    unregister()
  })
})

describe('SuperHistoryStore action labels', () => {
  it('returns up to `limit` action labels, most-recent first', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('alpha')
    typeLine('bravo')
    typeLine('charlie')
    const previews = store.getUndoPreviews(2)
    expect(previews).toHaveLength(2)
    // The most recent action describes what actually happened (the typed text),
    // not just a snapshot of the note's first line.
    expect(previews[0]).toContain('charlie')
    expect(previews[0].toLowerCase()).toMatch(/typed|inserted/)
    unregister()
  })

  it('describes a deletion as a delete, not a snapshot', () => {
    const { editor, store, unregister, typeLine } = makeEditorWithStore()
    typeLine('keepme')
    // Remove the last paragraph to produce a deletion-style action.
    editor.update(
      () => {
        const last = $getRoot().getLastChild()
        last?.remove()
      },
      { discrete: true },
    )
    const label = store.getUndoPreviews(1)[0]
    expect(label.toLowerCase()).toMatch(/deleted|removed/)
    unregister()
  })
})

describe('SuperHistoryStore edge cases', () => {
  it('a new edit after an undo discards the redo stack', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    typeLine('c')
    store.undo(2)
    expect(store.getSnapshot().redoDepth).toBeGreaterThan(0)
    typeLine('divergent') // a fresh edit invalidates the redo branch
    expect(store.getSnapshot().redoDepth).toBe(0)
    unregister()
  })

  it('undo / redo at the boundary are safe no-ops', () => {
    const { store, unregister } = makeEditorWithStore()
    expect(store.getSnapshot().undoDepth).toBe(0)
    expect(() => store.undo(1)).not.toThrow()
    expect(() => store.redo(1)).not.toThrow()
    expect(store.getSnapshot()).toEqual({ undoDepth: 0, redoDepth: 0 })
    unregister()
  })

  it('undo(0) and negative steps do nothing', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    const before = store.getSnapshot().undoDepth
    store.undo(0)
    store.undo(-3)
    expect(store.getSnapshot().undoDepth).toBe(before)
    unregister()
  })

  it('getUndoPreviews never returns more than the stack depth', () => {
    const { store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    const depth = store.getSnapshot().undoDepth
    expect(store.getUndoPreviews(100).length).toBe(depth)
    expect(store.getUndoPreviews(0)).toEqual([])
  })

  it('a fresh store (never activated) is inert', () => {
    const store = new SuperHistoryStore()
    expect(store.getSnapshot()).toEqual({ undoDepth: 0, redoDepth: 0 })
    expect(() => store.undo(5)).not.toThrow()
    expect(store.getUndoPreviews(10)).toEqual([])
  })
})

describe('SuperHistoryStore deactivate', () => {
  it('clears the stacks and resets the snapshot', () => {
    const { editor, store, unregister, typeLine } = makeEditorWithStore()
    typeLine('a')
    typeLine('b')
    expect(store.getSnapshot().undoDepth).toBeGreaterThan(0)
    store.deactivate(editor)
    expect(store.getSnapshot()).toEqual({ undoDepth: 0, redoDepth: 0 })
    // After deactivate, jumps are a no-op (no editor bound).
    store.undo(1)
    expect(store.getSnapshot().undoDepth).toBe(0)
    unregister()
  })
})
