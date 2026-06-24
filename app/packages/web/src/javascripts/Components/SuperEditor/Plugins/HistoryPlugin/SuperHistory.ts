/**
 * Standard Red Notes: an introspectable undo/redo history store for the Super
 * editor. It owns the Lexical `HistoryState` (so the undo/redo stacks can be
 * read), caps each stack at MAX_HISTORY entries, and exposes a small subscribable
 * snapshot plus helpers to preview recent steps and jump back/forward many steps
 * at once (the toolbar's undo/redo dropdowns).
 *
 * One store per editor instance; the SuperHistoryPlugin activates it and the
 * ToolbarPlugin reads it. In collaboration mode the plugin is not mounted, so the
 * store stays empty (depth 0) and the dropdown arrows are greyed out while single
 * undo/redo still flows through the Yjs binding.
 */
import { $getRoot, LexicalEditor, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { createEmptyHistoryState, HistoryState } from '@lexical/history'
import type { EditorState } from 'lexical'

export const MAX_HISTORY = 500
export const HISTORY_DROPDOWN_LIMIT = 25

export type HistorySnapshot = { undoDepth: number; redoDepth: number }

type StateInfo = { text: string; blocks: number }

const infoOfState = (editorState: EditorState): StateInfo => {
  let info: StateInfo = { text: '', blocks: 0 }
  try {
    editorState.read(() => {
      const root = $getRoot()
      info = { text: root.getTextContent(), blocks: root.getChildrenSize() }
    })
  } catch {
    info = { text: '', blocks: 0 }
  }
  return info
}

const snippet = (value: string): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > 22 ? `${collapsed.slice(0, 22)}…` : collapsed
}

/**
 * Describe the action that turned `before` into `after` (the forward edit), so
 * the undo/redo dropdown shows what actually happened — "Typed …", "Deleted …",
 * "Inserted block" — rather than a snapshot of the note's first line.
 */
const describeAction = (before: StateInfo, after: StateInfo): string => {
  if (before.text !== after.text) {
    // Isolate the changed span via common prefix/suffix.
    const a = before.text
    const b = after.text
    let start = 0
    const minLen = Math.min(a.length, b.length)
    while (start < minLen && a[start] === b[start]) {
      start++
    }
    let endA = a.length
    let endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--
      endB--
    }
    const removed = a.slice(start, endA)
    const added = b.slice(start, endB)
    if (added && !removed) {
      return `Typed “${snippet(added)}”`
    }
    if (removed && !added) {
      return `Deleted “${snippet(removed)}”`
    }
    return `Replaced “${snippet(removed)}” → “${snippet(added)}”`
  }
  if (after.blocks > before.blocks) {
    return after.blocks - before.blocks === 1 ? 'Inserted block' : `Inserted ${after.blocks - before.blocks} blocks`
  }
  if (after.blocks < before.blocks) {
    return before.blocks - after.blocks === 1 ? 'Removed block' : `Removed ${before.blocks - after.blocks} blocks`
  }
  return 'Formatting change'
}

export class SuperHistoryStore {
  readonly historyState: HistoryState = createEmptyHistoryState()
  private editor: LexicalEditor | null = null
  private listeners = new Set<() => void>()
  private snapshot: HistorySnapshot = { undoDepth: 0, redoDepth: 0 }

  activate(editor: LexicalEditor): void {
    this.editor = editor
  }

  deactivate(editor: LexicalEditor): void {
    if (this.editor !== editor) {
      return
    }
    this.editor = null
    this.historyState.undoStack.length = 0
    this.historyState.redoStack.length = 0
    this.historyState.current = null
    this.refresh()
  }

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  getSnapshot = (): HistorySnapshot => this.snapshot

  /** Cap the stacks at MAX_HISTORY and re-publish the snapshot if depths changed. */
  refresh = (): void => {
    const { undoStack, redoStack } = this.historyState
    if (undoStack.length > MAX_HISTORY) {
      undoStack.splice(0, undoStack.length - MAX_HISTORY)
    }
    if (redoStack.length > MAX_HISTORY) {
      redoStack.splice(0, redoStack.length - MAX_HISTORY)
    }
    if (undoStack.length === this.snapshot.undoDepth && redoStack.length === this.snapshot.redoDepth) {
      return
    }
    this.snapshot = { undoDepth: undoStack.length, redoDepth: redoStack.length }
    this.listeners.forEach((listener) => listener())
  }

  /** Labels of the actions reverted by undoing 1..limit steps (index 0 == 1 step). */
  getUndoPreviews(limit: number): string[] {
    const stack = this.historyState.undoStack
    const out: string[] = []
    const count = Math.min(limit, stack.length)
    for (let i = 0; i < count; i++) {
      const target = stack[stack.length - 1 - i] // state landed on after undoing i+1 steps
      const newer = i === 0 ? this.historyState.current : stack[stack.length - i]
      // The forward action (target -> newer) is the one this row's undo reverts.
      out.push(newer ? describeAction(infoOfState(target.editorState), infoOfState(newer.editorState)) : 'Edit')
    }
    return out
  }

  /** Labels of the actions re-applied by redoing 1..limit steps (index 0 == 1 step). */
  getRedoPreviews(limit: number): string[] {
    const stack = this.historyState.redoStack
    const out: string[] = []
    const count = Math.min(limit, stack.length)
    for (let i = 0; i < count; i++) {
      const target = stack[stack.length - 1 - i] // state redone to after redoing i+1 steps
      const older = i === 0 ? this.historyState.current : stack[stack.length - i]
      // The forward action (older -> target) is the one this row's redo re-applies.
      out.push(older ? describeAction(infoOfState(older.editorState), infoOfState(target.editorState)) : 'Edit')
    }
    return out
  }

  undo(steps: number): void {
    this.run(UNDO_COMMAND, Math.min(steps, this.snapshot.undoDepth))
  }

  redo(steps: number): void {
    this.run(REDO_COMMAND, Math.min(steps, this.snapshot.redoDepth))
  }

  private run(command: typeof UNDO_COMMAND | typeof REDO_COMMAND, steps: number): void {
    const editor = this.editor
    if (!editor) {
      return
    }
    const count = Math.max(0, steps)
    for (let i = 0; i < count; i++) {
      editor.dispatchCommand(command, undefined)
    }
  }
}

const stores = new WeakMap<LexicalEditor, SuperHistoryStore>()

export const getSuperHistoryStore = (editor: LexicalEditor): SuperHistoryStore => {
  let store = stores.get(editor)
  if (!store) {
    store = new SuperHistoryStore()
    stores.set(editor, store)
  }
  return store
}
