import { setDOMUnmanaged } from 'lexical'
import { checklistDueAtToLocalInput, formatChecklistDue } from './checklistDueDate'

export const CHECKLIST_DUE_SHELL_ATTR = 'data-checklist-due-shell'
export const CHECKLIST_DUE_ACTION_ATTR = 'data-checklist-due-action'
export const CHECKLIST_DUE_INPUT_ATTR = 'data-checklist-due-input'

const PRINT_EXCLUDE_ATTR = 'data-srn-print-exclude'

function createButton(action: 'edit' | 'clear', label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(CHECKLIST_DUE_ACTION_ATTR, action)
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('aria-label', label)
  return button
}

export function createChecklistDueShell(): HTMLSpanElement {
  const shell = document.createElement('span')
  shell.setAttribute(CHECKLIST_DUE_SHELL_ATTR, 'true')
  shell.setAttribute('contenteditable', 'false')
  shell.className = 'checklist-due-shell'
  setDOMUnmanaged(shell)

  const label = document.createElement('span')
  label.setAttribute('data-checklist-due-label', 'true')
  label.className = 'checklist-due-label'
  shell.appendChild(label)

  const controls = document.createElement('span')
  controls.setAttribute(PRINT_EXCLUDE_ATTR, 'true')
  controls.className = 'checklist-due-controls'

  const edit = createButton('edit', 'Add due date and time')
  edit.className = 'checklist-due-button'
  controls.appendChild(edit)

  const input = document.createElement('input')
  input.type = 'datetime-local'
  input.setAttribute(CHECKLIST_DUE_INPUT_ATTR, 'true')
  input.setAttribute('contenteditable', 'false')
  input.setAttribute('aria-label', 'Checklist due date and time')
  input.className = 'checklist-due-input'
  input.hidden = true
  controls.appendChild(input)

  const clear = createButton('clear', 'Clear due date and time')
  clear.className = 'checklist-due-button checklist-due-clear'
  clear.textContent = 'Clear'
  controls.appendChild(clear)

  shell.appendChild(controls)
  return shell
}

export function syncChecklistDueShell(
  itemElement: HTMLElement,
  dueAt: string | undefined,
  checked: boolean,
  editable: boolean,
  now = Date.now(),
): HTMLSpanElement {
  const existing = itemElement.querySelector<HTMLSpanElement>(`:scope > [${CHECKLIST_DUE_SHELL_ATTR}]`)
  const shell = existing ?? createChecklistDueShell()
  const label = shell.querySelector<HTMLElement>('[data-checklist-due-label]')
  const controls = shell.querySelector<HTMLElement>(`[${PRINT_EXCLUDE_ATTR}]`)
  const edit = shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="edit"]`)
  const input = shell.querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`)
  const clear = shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="clear"]`)
  const display = dueAt ? formatChecklistDue(dueAt, checked, now) : undefined

  if (label) {
    label.textContent = display ? `Due ${display.dateLabel} · ${display.relativeLabel}` : ''
    label.hidden = !display
    label.className = `checklist-due-label${display ? ` checklist-due-label--${display.state}` : ''}`
    label.title = display?.accessibleLabel ?? ''
  }
  if (controls) {
    controls.hidden = !editable
  }
  if (edit) {
    edit.textContent = display ? 'Edit date' : 'Add date'
    edit.setAttribute('aria-label', display ? `Edit due date. ${display.accessibleLabel}` : 'Add due date and time')
  }
  if (input && document.activeElement !== input) {
    input.value = dueAt ? checklistDueAtToLocalInput(dueAt) : ''
  }
  if (clear) {
    clear.hidden = !display
  }

  if (!existing) {
    const nestedList = Array.from(itemElement.children).find(
      (child) => child.tagName === 'UL' || child.tagName === 'OL',
    )
    itemElement.insertBefore(shell, nestedList ?? null)
  }
  return shell
}

export function removeChecklistDueShell(itemElement: HTMLElement): void {
  itemElement.querySelector(`:scope > [${CHECKLIST_DUE_SHELL_ATTR}]`)?.remove()
}
