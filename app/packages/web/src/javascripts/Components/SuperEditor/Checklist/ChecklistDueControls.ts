import { setDOMUnmanaged } from 'lexical'
import { checklistDueAtToLocalInput, formatChecklistDue, resolveChecklistDueAtLocalInput } from './checklistDueDate'
import {
  CHECKLIST_RECURRENCE_MAX_INTERVAL,
  checklistRecurrenceSummary,
  normalizeChecklistRecurrence,
  type ChecklistRecurrence,
  type ChecklistRecurrenceChoice,
  type ChecklistRecurrenceUnit,
} from './checklistRecurrence'

export const CHECKLIST_DUE_SHELL_ATTR = 'data-checklist-due-shell'
export const CHECKLIST_DUE_ACTION_ATTR = 'data-checklist-due-action'
export const CHECKLIST_DUE_INPUT_ATTR = 'data-checklist-due-input'
export const CHECKLIST_SCHEDULE_PANEL_ATTR = 'data-checklist-schedule-panel'
export const CHECKLIST_RECURRENCE_PRESET_ATTR = 'data-checklist-recurrence-preset'
export const CHECKLIST_RECURRENCE_INTERVAL_ATTR = 'data-checklist-recurrence-interval'
export const CHECKLIST_RECURRENCE_UNIT_ATTR = 'data-checklist-recurrence-unit'
export const CHECKLIST_RECURRENCE_CUSTOM_ATTR = 'data-checklist-recurrence-custom'
export const CHECKLIST_SCHEDULE_STATUS_ATTR = 'data-checklist-schedule-status'

const PRINT_EXCLUDE_ATTR = 'data-srn-print-exclude'
let schedulePanelSequence = 0

function createButton(action: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(CHECKLIST_DUE_ACTION_ATTR, action)
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('aria-label', label)
  return button
}

function option(value: string, label: string): HTMLOptionElement {
  const result = document.createElement('option')
  result.value = value
  result.textContent = label
  return result
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

  const edit = createButton('edit-schedule', 'Add due date and recurrence')
  edit.className = 'checklist-due-button'
  edit.textContent = 'Add schedule'
  edit.setAttribute('aria-haspopup', 'dialog')
  edit.setAttribute('aria-expanded', 'false')
  controls.appendChild(edit)

  const panel = document.createElement('span')
  panel.id = `srn-checklist-schedule-${++schedulePanelSequence}`
  edit.setAttribute('aria-controls', panel.id)
  panel.setAttribute(CHECKLIST_SCHEDULE_PANEL_ATTR, 'true')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'false')
  panel.setAttribute('aria-label', 'Checklist schedule')
  panel.className = 'checklist-schedule-panel'
  panel.hidden = true

  const dueLabel = document.createElement('label')
  dueLabel.className = 'checklist-schedule-field'
  dueLabel.append('Due ')
  const input = document.createElement('input')
  input.type = 'datetime-local'
  input.setAttribute(CHECKLIST_DUE_INPUT_ATTR, 'true')
  input.setAttribute('contenteditable', 'false')
  input.setAttribute('aria-label', 'Checklist due date and time')
  input.className = 'checklist-due-input'
  dueLabel.appendChild(input)
  panel.appendChild(dueLabel)

  const presetLabel = document.createElement('label')
  presetLabel.className = 'checklist-schedule-field'
  presetLabel.append('Repeat ')
  const preset = document.createElement('select')
  preset.setAttribute(CHECKLIST_RECURRENCE_PRESET_ATTR, 'true')
  preset.setAttribute('aria-label', 'Checklist recurrence')
  preset.className = 'checklist-recurrence-select'
  preset.append(
    option('none', 'Never'),
    option('daily', 'Daily'),
    option('weekdays', 'Weekdays'),
    option('weekly', 'Weekly'),
    option('monthly', 'Monthly'),
    option('yearly', 'Yearly'),
    option('custom', 'Custom interval'),
  )
  presetLabel.appendChild(preset)
  panel.appendChild(presetLabel)

  const custom = document.createElement('span')
  custom.setAttribute(CHECKLIST_RECURRENCE_CUSTOM_ATTR, 'true')
  custom.className = 'checklist-recurrence-custom'
  custom.hidden = true
  custom.append('Every ')
  const interval = document.createElement('input')
  interval.type = 'number'
  interval.min = '1'
  interval.max = String(CHECKLIST_RECURRENCE_MAX_INTERVAL)
  interval.step = '1'
  interval.value = '1'
  interval.setAttribute(CHECKLIST_RECURRENCE_INTERVAL_ATTR, 'true')
  interval.setAttribute('aria-label', 'Custom recurrence interval')
  interval.className = 'checklist-recurrence-interval'
  custom.appendChild(interval)
  const unit = document.createElement('select')
  unit.setAttribute(CHECKLIST_RECURRENCE_UNIT_ATTR, 'true')
  unit.setAttribute('aria-label', 'Custom recurrence unit')
  unit.className = 'checklist-recurrence-select'
  unit.append(option('day', 'days'), option('week', 'weeks'), option('month', 'months'), option('year', 'years'))
  custom.appendChild(unit)
  panel.appendChild(custom)

  const save = createButton('save-schedule', 'Save checklist schedule')
  save.className = 'checklist-due-button checklist-schedule-save'
  save.textContent = 'Save'
  panel.appendChild(save)
  const cancel = createButton('cancel-schedule', 'Cancel schedule changes')
  cancel.className = 'checklist-due-button'
  cancel.textContent = 'Cancel'
  panel.appendChild(cancel)
  const clear = createButton('clear-schedule', 'Clear due date and recurrence')
  clear.className = 'checklist-due-button checklist-due-clear'
  clear.textContent = 'Clear schedule'
  panel.appendChild(clear)

  const status = document.createElement('span')
  status.setAttribute(CHECKLIST_SCHEDULE_STATUS_ATTR, 'true')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.className = 'checklist-recurrence-status'
  status.hidden = true
  panel.appendChild(status)

  controls.appendChild(panel)
  shell.appendChild(controls)
  return shell
}

export function syncChecklistDueShell(
  itemElement: HTMLElement,
  dueAt: string | undefined,
  checked: boolean,
  editable: boolean,
  recurrenceValue?: ChecklistRecurrence,
  now = Date.now(),
): HTMLSpanElement {
  const existing = itemElement.querySelector<HTMLSpanElement>(`:scope > [${CHECKLIST_DUE_SHELL_ATTR}]`)
  const shell = existing ?? createChecklistDueShell()
  const label = shell.querySelector<HTMLElement>('[data-checklist-due-label]')
  const controls = shell.querySelector<HTMLElement>(`[${PRINT_EXCLUDE_ATTR}]`)
  const edit = shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="edit-schedule"]`)
  const panel = shell.querySelector<HTMLElement>(`[${CHECKLIST_SCHEDULE_PANEL_ATTR}]`)
  const input = shell.querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`)
  const clear = shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="clear-schedule"]`)
  const display = dueAt ? formatChecklistDue(dueAt, checked, now) : undefined
  const recurrence = display ? normalizeChecklistRecurrence(recurrenceValue) : undefined
  const recurrenceSummary = recurrence ? checklistRecurrenceSummary(recurrence, true) : undefined

  if (label) {
    label.textContent = display
      ? `Due ${display.dateLabel} · ${display.relativeLabel}${recurrenceSummary ? ` · ${recurrenceSummary}` : ''}`
      : ''
    label.hidden = !display
    label.className = `checklist-due-label${display ? ` checklist-due-label--${display.state}` : ''}`
    label.title = display ? `${display.accessibleLabel}${recurrenceSummary ? `; ${recurrenceSummary}` : ''}` : ''
  }
  if (controls) {
    controls.hidden = !editable
  }
  if (edit) {
    edit.textContent = display ? 'Edit schedule' : 'Add schedule'
    edit.setAttribute(
      'aria-label',
      display
        ? `Edit checklist schedule. ${display.accessibleLabel}${recurrenceSummary ? `; ${recurrenceSummary}` : ''}`
        : 'Add checklist due date and recurrence',
    )
  }
  if (clear) {
    clear.hidden = !display
  }

  if (panel?.hidden) {
    if (input) {
      input.value = dueAt ? checklistDueAtToLocalInput(dueAt) : ''
    }
    const preset = panel.querySelector<HTMLSelectElement>(`[${CHECKLIST_RECURRENCE_PRESET_ATTR}]`)
    const interval = panel.querySelector<HTMLInputElement>(`[${CHECKLIST_RECURRENCE_INTERVAL_ATTR}]`)
    const unit = panel.querySelector<HTMLSelectElement>(`[${CHECKLIST_RECURRENCE_UNIT_ATTR}]`)
    if (preset) {
      preset.value = recurrence?.frequency ?? 'none'
    }
    if (interval) {
      interval.value = recurrence?.frequency === 'custom' ? String(recurrence.interval) : '1'
    }
    if (unit) {
      unit.value = recurrence?.frequency === 'custom' ? recurrence.unit : 'day'
    }
    syncChecklistRecurrenceCustomVisibility(shell)
  }

  if (!existing) {
    const nestedList = Array.from(itemElement.children).find(
      (child) => child.tagName === 'UL' || child.tagName === 'OL',
    )
    itemElement.insertBefore(shell, nestedList ?? null)
  }
  return shell
}

export function setChecklistSchedulePanelOpen(shell: HTMLElement, open: boolean): void {
  const panel = shell.querySelector<HTMLElement>(`[${CHECKLIST_SCHEDULE_PANEL_ATTR}]`)
  const button = shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="edit-schedule"]`)
  if (panel) {
    panel.hidden = !open
  }
  if (button) {
    button.hidden = open
  }
  button?.setAttribute('aria-expanded', String(open))
}

export function setChecklistScheduleStatus(shell: HTMLElement, message?: string): void {
  const status = shell.querySelector<HTMLElement>(`[${CHECKLIST_SCHEDULE_STATUS_ATTR}]`)
  if (!status) {
    return
  }
  status.textContent = message ?? ''
  status.hidden = !message
}

export function syncChecklistRecurrenceCustomVisibility(shell: HTMLElement): void {
  const preset = shell.querySelector<HTMLSelectElement>(`[${CHECKLIST_RECURRENCE_PRESET_ATTR}]`)
  const custom = shell.querySelector<HTMLElement>(`[${CHECKLIST_RECURRENCE_CUSTOM_ATTR}]`)
  if (custom) {
    custom.hidden = preset?.value !== 'custom'
  }
}

export type ChecklistRecurrenceControlResult =
  { ok: true; choice?: ChecklistRecurrenceChoice } | { ok: false; reason: string }

export function readChecklistRecurrenceControl(shell: HTMLElement): ChecklistRecurrenceControlResult {
  const preset = shell.querySelector<HTMLSelectElement>(`[${CHECKLIST_RECURRENCE_PRESET_ATTR}]`)?.value
  if (preset === 'none') {
    return { ok: true }
  }
  if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(String(preset))) {
    return { ok: true, choice: preset as Exclude<ChecklistRecurrence['frequency'], 'custom'> }
  }
  if (preset !== 'custom') {
    return { ok: false, reason: 'Choose a recurrence option.' }
  }
  const interval = Number(shell.querySelector<HTMLInputElement>(`[${CHECKLIST_RECURRENCE_INTERVAL_ATTR}]`)?.value)
  const unit = shell.querySelector<HTMLSelectElement>(`[${CHECKLIST_RECURRENCE_UNIT_ATTR}]`)?.value
  if (!Number.isInteger(interval) || interval < 1 || interval > CHECKLIST_RECURRENCE_MAX_INTERVAL) {
    return { ok: false, reason: `Enter an interval from 1 to ${CHECKLIST_RECURRENCE_MAX_INTERVAL}.` }
  }
  if (!['day', 'week', 'month', 'year'].includes(String(unit))) {
    return { ok: false, reason: 'Choose days, weeks, months, or years.' }
  }
  return { ok: true, choice: { frequency: 'custom', interval, unit: unit as ChecklistRecurrenceUnit } }
}

export type ChecklistScheduleControlResult =
  { ok: true; dueAt: string; recurrenceChoice?: ChecklistRecurrenceChoice } | { ok: false; reason: string }

export function readChecklistScheduleControl(
  shell: HTMLElement,
  expectedDueAt?: string,
): ChecklistScheduleControlResult {
  const localDueAt = shell.querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`)?.value ?? ''
  const dueAt = resolveChecklistDueAtLocalInput(localDueAt, expectedDueAt)
  if (!dueAt) {
    return { ok: false, reason: 'Choose a valid due date and time.' }
  }
  const recurrence = readChecklistRecurrenceControl(shell)
  return recurrence.ok ? { ok: true, dueAt, recurrenceChoice: recurrence.choice } : recurrence
}

export function removeChecklistDueShell(itemElement: HTMLElement): void {
  itemElement.querySelector(`:scope > [${CHECKLIST_DUE_SHELL_ATTR}]`)?.remove()
}
