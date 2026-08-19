import {
  countTodoMatches,
  DUE_FILTER_LABEL,
  SOURCE_FILTER_LABEL,
  todoRowIndentLevel,
  todoTagLabel,
  TODO_MAX_INDENT_LEVEL,
  type TodoFilters,
  type TodoRow,
  type TodoTag,
} from './todoFilters'
import { formatChecklistDue } from '../SuperEditor/Checklist/checklistDueDate'

/**
 * Standard Red Notes: the Todos view's printable projection.
 *
 * Printing this view used to fail with "Open a note before printing" because the
 * print path resolved its target out of the note editor's DOM, which a view tab
 * replaces. The fix is a projection, not a clone: the printed page is BUILT FROM
 * THE SAME ROWS THE TABLE IS RENDERING rather than screen-scraped, so the two
 * cannot drift and no interactive control can reach paper by accident.
 *
 * Three properties are load-bearing, in the order they matter:
 *
 * 1. **What is on screen is what prints.** The caller hands over the already
 *    filtered and sorted rows. A filtered view that printed everything would be
 *    worse than the old error, because the user could not tell it happened.
 * 2. **Omission is stated.** When any filter is on, the page says so and says
 *    how many todos it is showing out of how many exist. A printed list that
 *    silently drops rows is a misleading document.
 * 3. **Completion is legible in ink.** A real checkbox prints as an empty box on
 *    most printers, making done and not-done identical. The rows carry the
 *    ☒ / ☐ text markers the note print path already uses for checklists.
 *
 * Interactive chrome is excluded structurally: nothing here emits a button,
 * input or select, and the whole tree is still handed to `sanitizePrintBody`,
 * whose `[data-srn-print-exclude]` + control denylist is the app's one print
 * exclusion mechanism.
 */

/** Heading of the printed page — the view's own name, not a note title. */
export const TODO_PRINT_TITLE = 'Todos'

export const TODO_PRINT_LIST_CLASS = 'srn-print-todo-list'
export const TODO_PRINT_ROW_CLASS = 'srn-print-todo'
export const TODO_PRINT_SUMMARY_CLASS = 'srn-print-todo-summary'

/**
 * Screen and paper must indent identically, so this is the row cell's own
 * formula rather than a second one that could drift from it.
 */
export function todoPrintIndentRem(depth: number): number {
  const indentLevel = todoRowIndentLevel(depth)
  return Math.min(indentLevel, 4) * 0.85 + Math.max(indentLevel - 4, 0) * 0.4
}

const SOURCE_ROW_LABEL: Record<TodoRow['group']['source'], string> = {
  super: 'Super checklist',
  'advanced-checklist': 'Advanced Checklist',
}

/**
 * One human sentence per ACTIVE filter, in the bar's own order. Empty when
 * nothing is filtering, which is how the caller decides whether to print the
 * omission notice at all.
 */
export function describeActiveTodoFilters(filters: TodoFilters, tagOptions: TodoTag[]): string[] {
  const descriptions: string[] = []

  const query = filters.query.trim()
  if (query.length > 0) {
    descriptions.push(`search “${query}”`)
  }

  if (filters.tagUuids.length > 0) {
    const labels = new Map(tagOptions.map((tag) => [tag.uuid, todoTagLabel(tag)]))
    // A stored uuid can name a folder that no longer exists or that no visible
    // todo uses. Count it rather than printing a raw uuid at the reader.
    const named = filters.tagUuids.map((uuid) => labels.get(uuid)).filter((label): label is string => !!label)
    const unnamed = filters.tagUuids.length - named.length
    const parts = [...named, ...(unnamed > 0 ? [`${unnamed} unavailable`] : [])]
    descriptions.push(`folders & tags: ${parts.join(', ')}`)
  }

  if (filters.groupNames.length > 0) {
    descriptions.push(`checklist sections: ${filters.groupNames.join(', ')}`)
  }

  if (filters.source !== 'all') {
    descriptions.push(`source: ${SOURCE_FILTER_LABEL[filters.source]}`)
  }

  if (filters.due !== 'all') {
    descriptions.push(`due: ${DUE_FILTER_LABEL[filters.due]}`)
  }

  if (filters.hideCompleted) {
    descriptions.push('completed todos hidden')
  }

  return descriptions
}

/** The line printed above the list, stating both the scope and any omission. */
export function todoPrintSummaryText(
  filters: TodoFilters,
  tagOptions: TodoTag[],
  visibleCount: number,
  totalCount: number,
): string {
  const active = describeActiveTodoFilters(filters, tagOptions)
  if (active.length === 0) {
    return `${totalCount} ${totalCount === 1 ? 'todo' : 'todos'}.`
  }
  return `Showing ${visibleCount} of ${totalCount} todos — filtered by ${active.join('; ')}.`
}

export type TodoPrintProjectionInput = {
  /** Exactly the rows the table is rendering: already filtered, already sorted. */
  rows: TodoRow[]
  filters: TodoFilters
  /** Every folder/tag present in the unfiltered data, for naming selected uuids. */
  tagOptions: TodoTag[]
  /** Unfiltered row count, so the summary can state what was left out. */
  totalCount: number
  now: number
  targetDocument?: Document
}

const appendMeta = (target: HTMLElement, parts: string[]): void => {
  if (parts.length === 0) {
    return
  }
  const meta = target.ownerDocument.createElement('span')
  meta.className = 'srn-print-todo-meta'
  meta.textContent = ` — ${parts.join(' · ')}`
  target.appendChild(meta)
}

/**
 * Build the detached body element for the printed Todos page. Static tree only:
 * no controls, no event handlers, nothing that needs the live view to exist.
 */
export function buildTodoPrintBody({
  rows,
  filters,
  tagOptions,
  totalCount,
  now,
  targetDocument = document,
}: TodoPrintProjectionInput): HTMLElement {
  const body = targetDocument.createElement('div')

  const summary = targetDocument.createElement('p')
  summary.className = TODO_PRINT_SUMMARY_CLASS
  summary.textContent = todoPrintSummaryText(filters, tagOptions, countTodoMatches(rows), totalCount)
  body.appendChild(summary)

  if (rows.length === 0) {
    const empty = targetDocument.createElement('p')
    empty.className = 'srn-print-todo-empty'
    empty.textContent = 'No todos match the current filters.'
    body.appendChild(empty)
    return body
  }

  const list = targetDocument.createElement('ul')
  list.className = TODO_PRINT_LIST_CLASS

  for (const row of rows) {
    const entry = targetDocument.createElement('li')
    entry.className = TODO_PRINT_ROW_CLASS
    if (row.item.checked) {
      entry.classList.add('srn-print-todo--done')
    }
    if (!row.isMatch) {
      entry.classList.add('srn-print-todo--context')
    }
    // Depth survives as data as well as as indentation: past the indent ceiling
    // the row stops moving right, exactly as it does on screen.
    entry.setAttribute('data-todo-depth', String(row.depth))
    entry.setAttribute('data-todo-checked', row.item.checked ? 'true' : 'false')
    entry.style.marginInlineStart = `${todoPrintIndentRem(row.depth)}rem`

    // The note print path's own checklist marker, so a printed checkbox is never
    // an empty box that reads the same whether or not the task is done.
    const marker = targetDocument.createElement('span')
    marker.className = 'srn-print-checkbox'
    marker.setAttribute('role', 'img')
    marker.setAttribute('aria-label', row.item.checked ? 'Checked' : 'Unchecked')
    marker.textContent = row.item.checked ? '☒' : '☐'
    entry.appendChild(marker)

    const text = targetDocument.createElement('span')
    text.className = 'srn-print-todo-text'
    text.textContent = row.item.text
    entry.appendChild(text)

    if (row.depth > TODO_MAX_INDENT_LEVEL) {
      const level = targetDocument.createElement('span')
      level.className = 'srn-print-todo-level'
      level.textContent = ` L${row.depth}`
      entry.appendChild(level)
    }

    const due = row.item.dueAt ? formatChecklistDue(row.item.dueAt, row.item.checked, now) : undefined
    appendMeta(entry, [
      row.noteTitle,
      SOURCE_ROW_LABEL[row.group.source],
      ...(row.item.groupName ? [row.item.groupName] : []),
      ...(due ? [`due ${due.dateLabel}`] : []),
      // Stated in words: on paper a muted color is not a reliable distinction.
      ...(row.isMatch ? [] : ['shown as the parent of a match']),
    ])

    list.appendChild(entry)
  }

  body.appendChild(list)
  return body
}
