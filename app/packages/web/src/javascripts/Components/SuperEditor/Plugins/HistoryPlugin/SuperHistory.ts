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

const previewOfState = (editorState: EditorState): string => {
  let preview = ''
  try {
    editorState.read(() => {
      const text = $getRoot().getTextContent()
      const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
      preview = firstLine.trim().slice(0, 60)
    })
  } catch {
    preview = ''
  }
  return preview
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

  /** Previews of the states reachable by undoing 1..limit steps (index 0 == 1 step). */
  getUndoPreviews(limit: number): string[] {
    return this.previews(this.historyState.undoStack, limit)
  }

  getRedoPreviews(limit: number): string[] {
    return this.previews(this.historyState.redoStack, limit)
  }

  private previews(stack: HistoryState['undoStack'], limit: number): string[] {
    const out: string[] = []
    const count = Math.min(limit, stack.length)
    for (let i = 0; i < count; i++) {
      out.push(previewOfState(stack[stack.length - 1 - i].editorState))
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
