import { NoteType, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: cross-note Todo / checklist aggregate collector.
 *
 * Two todo sources are aggregated:
 *
 *  1. **Super checklist blocks** — a Super note (`noteType === NoteType.Super`)
 *     stores a Lexical JSON tree in `note.text`. A checklist is a `list` node
 *     with `listType: "check"`; each `listitem` child carries a `checked`
 *     boolean and its label is the concatenation of descendant text nodes. We
 *     walk the serialized tree (no Lexical runtime needed) and pull these out.
 *
 *  2. **Advanced Checklist note type** — the community `com.sncommunity.
 *     advanced-checklist` editor (`noteType === NoteType.Task`) stores JSON in
 *     `note.text` shaped roughly as `{ groups: [{ name, tasks: [{ id,
 *     description, completed }] }] }`. We parse that shape defensively.
 *
 * ## Honest limitations
 *  - The advanced-checklist payload is produced by a third-party iframe editor
 *    we do not own; its exact schema can vary by version. We parse the common
 *    `groups[].tasks[]` shape and tolerate a top-level `tasks[]` array, but if a
 *    note uses an unrecognized shape we surface zero todos for it rather than
 *    guessing (it simply won't appear in the aggregate).
 *  - Super "checklist" detection keys purely on `listType: "check"`. Plain
 *    bullet/number lists are intentionally NOT treated as todos.
 *  - Nested checklists are flattened; each checkable item becomes one row.
 *
 * Pure, in-memory, never throws — safe to run on a throttle.
 */

/** A single todo item extracted from a note, with its checked state. */
export type TodoItem = {
  /** Stable-ish id for React keys (source id when available, else positional). */
  id: string
  text: string
  checked: boolean
}

/** All todos from one source note, plus progress, for grouped rendering. */
export type NoteTodos = {
  note: SNNote
  source: 'super' | 'advanced-checklist'
  items: TodoItem[]
  completed: number
  total: number
}

// ---------------------------------------------------------------------------
// Super checklist parsing (Lexical JSON tree walk)
// ---------------------------------------------------------------------------

type LexicalNode = {
  type?: unknown
  listType?: unknown
  checked?: unknown
  text?: unknown
  children?: unknown
}

/** Concatenate descendant text nodes of a Lexical node into a plain label. */
function collectText(node: LexicalNode): string {
  const pieces: string[] = []
  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object') {
      return
    }
    const record = current as LexicalNode
    if (typeof record.text === 'string' && record.text.length > 0) {
      pieces.push(record.text)
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child)
      }
    }
  }
  // Only descend into children — the listitem's own `text` is not set.
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visit(child)
    }
  }
  return pieces.join('').trim()
}

/** Parse Super check-list items from a note's serialized Lexical text. */
export function parseSuperChecklist(noteText: string): TodoItem[] {
  if (!noteText || noteText.length === 0) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(noteText)
  } catch {
    return []
  }

  const items: TodoItem[] = []
  let counter = 0

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    const record = node as LexicalNode
    const isCheckList = record.type === 'list' && record.listType === 'check'
    if (isCheckList && Array.isArray(record.children)) {
      for (const child of record.children) {
        if (child && typeof child === 'object' && (child as LexicalNode).type === 'listitem') {
          const listItem = child as LexicalNode
          const text = collectText(listItem)
          // Skip empty list items (e.g. a trailing blank checklist row).
          if (text.length === 0) {
            // Still descend in case of nested checklists inside the empty item.
            if (Array.isArray(listItem.children)) {
              for (const grandChild of listItem.children) {
                visit(grandChild)
              }
            }
            continue
          }
          counter += 1
          items.push({
            id: `super-${counter}`,
            text,
            checked: listItem.checked === true,
          })
          // Descend for nested checklists within this item.
          if (Array.isArray(listItem.children)) {
            for (const grandChild of listItem.children) {
              if (grandChild && typeof grandChild === 'object' && (grandChild as LexicalNode).type === 'list') {
                visit(grandChild)
              }
            }
          }
        }
      }
      return
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child)
      }
    }
  }

  const root = (parsed as { root?: unknown })?.root
  visit(root ?? parsed)
  return items
}

// ---------------------------------------------------------------------------
// Advanced Checklist parsing (third-party JSON)
// ---------------------------------------------------------------------------

type RawTask = {
  id?: unknown
  description?: unknown
  completed?: unknown
}

function parseTask(raw: unknown, index: number): TodoItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const task = raw as RawTask
  const text = typeof task.description === 'string' ? task.description.trim() : ''
  if (text.length === 0) {
    return null
  }
  return {
    id: typeof task.id === 'string' && task.id.length > 0 ? `adv-${task.id}` : `adv-${index}`,
    text,
    checked: task.completed === true,
  }
}

/** Parse advanced-checklist tasks from a note's JSON text. */
export function parseAdvancedChecklist(noteText: string): TodoItem[] {
  if (!noteText || noteText.length === 0) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(noteText)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') {
    return []
  }

  const items: TodoItem[] = []
  let index = 0

  const groups = (parsed as { groups?: unknown }).groups
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const tasks = group && typeof group === 'object' ? (group as { tasks?: unknown }).tasks : undefined
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          const item = parseTask(task, index)
          index += 1
          if (item) {
            items.push(item)
          }
        }
      }
    }
    return items
  }

  // Fallback: some payload shapes expose a flat top-level `tasks` array.
  const flatTasks = (parsed as { tasks?: unknown }).tasks
  if (Array.isArray(flatTasks)) {
    for (const task of flatTasks) {
      const item = parseTask(task, index)
      index += 1
      if (item) {
        items.push(item)
      }
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** True if a note is an Advanced Checklist (Task) note type. */
export function isAdvancedChecklistNote(note: SNNote): boolean {
  return note.noteType === NoteType.Task
}

/** True if a note is a Super note (may contain checklist blocks). */
export function isSuperNote(note: SNNote): boolean {
  return note.noteType === NoteType.Super
}

/** Build the per-note todo summary, or null if the note has no parseable todos. */
export function todosForNote(note: SNNote): NoteTodos | null {
  let source: NoteTodos['source']
  let items: TodoItem[]

  if (isAdvancedChecklistNote(note)) {
    source = 'advanced-checklist'
    items = parseAdvancedChecklist(note.text)
  } else if (isSuperNote(note)) {
    source = 'super'
    items = parseSuperChecklist(note.text)
  } else {
    return null
  }

  if (items.length === 0) {
    return null
  }

  const completed = items.reduce((count, item) => count + (item.checked ? 1 : 0), 0)
  return { note, source, items, completed, total: items.length }
}

/**
 * Collect todos across all (non-trashed) notes, grouped by source note. Notes
 * without parseable todos are omitted. Ordered with notes that have outstanding
 * (incomplete) items first, then by title, so the most actionable lists surface.
 */
export function collectAllTodos(notes: SNNote[]): NoteTodos[] {
  const result: NoteTodos[] = []
  for (const note of notes) {
    if (note.trashed) {
      continue
    }
    const todos = todosForNote(note)
    if (todos) {
      result.push(todos)
    }
  }
  return result.sort((a, b) => {
    const aOutstanding = a.total - a.completed
    const bOutstanding = b.total - b.completed
    if (aOutstanding !== bOutstanding) {
      return bOutstanding - aOutstanding
    }
    return (a.note.title || '').localeCompare(b.note.title || '')
  })
}

/** Aggregate progress across every collected note. */
export function totalTodoProgress(groups: NoteTodos[]): { completed: number; total: number } {
  let completed = 0
  let total = 0
  for (const group of groups) {
    completed += group.completed
    total += group.total
  }
  return { completed, total }
}
