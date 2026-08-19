import { createEditor, isDOMCapturingSelection } from 'lexical'
import {
  createChecklistDueShell,
  readChecklistScheduleControl,
  setChecklistSchedulePanelOpen,
  syncChecklistDueShell,
  syncChecklistRecurrenceCustomVisibility,
} from './ChecklistDueControls'
import { createChecklistRecurrence } from './checklistRecurrence'
import {
  checklistDueAtToLocalInput,
  resolveChecklistDueAtLocalInput,
  splitChecklistDueLocalInput,
} from './checklistDueDate'

describe('checklist due controls', () => {
  it('renders a semantic countdown with print-excluded edit controls', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:00:00.000Z'))
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', false, true)

    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('1d 2h left')
    expect(shell.querySelector('[data-srn-print-exclude="true"]')).not.toBeNull()
    expect(shell.querySelector('[data-checklist-due-input]')?.getAttribute('type')).toBe('date')
    expect(shell.querySelector('[data-checklist-due-time-input]')?.getAttribute('type')).toBe('time')
    expect(shell.querySelector('[data-checklist-due-action="clear-schedule"]')?.hasAttribute('hidden')).toBe(false)
    jest.useRealTimers()
  })

  it('hides controls in readonly mode while retaining the due label', () => {
    const item = document.createElement('li')
    item.appendChild(createChecklistDueShell())
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', true, false)
    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('Completed')
    expect((shell.querySelector('[data-srn-print-exclude]') as HTMLElement).hidden).toBe(true)
  })

  it('edits a due date and recurrence together in one accessible schedule group', () => {
    const item = document.createElement('li')
    const recurrence = createChecklistRecurrence('monthly', '2026-08-31T12:00:00.000Z', 'UTC')!
    const shell = syncChecklistDueShell(item, '2026-08-31T12:00:00.000Z', false, true, recurrence)

    expect(shell.textContent).toContain('Repeats monthly')
    const panel = shell.querySelector('[data-checklist-schedule-panel]') as HTMLElement
    const trigger = shell.querySelector('[data-checklist-due-action="edit-schedule"]') as HTMLButtonElement
    expect(panel.hidden).toBe(true)
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    setChecklistSchedulePanelOpen(shell, true)
    expect(panel.hidden).toBe(false)
    expect(trigger.hidden).toBe(true)
    expect((shell.querySelector('[data-checklist-recurrence-preset]') as HTMLSelectElement).value).toBe('monthly')

    const preset = shell.querySelector('[data-checklist-recurrence-preset]') as HTMLSelectElement
    preset.value = 'custom'
    ;(shell.querySelector('[data-checklist-recurrence-interval]') as HTMLInputElement).value = '3'
    ;(shell.querySelector('[data-checklist-recurrence-unit]') as HTMLSelectElement).value = 'week'
    syncChecklistRecurrenceCustomVisibility(shell)
    expect((shell.querySelector('[data-checklist-recurrence-custom]') as HTMLElement).hidden).toBe(false)
    expect(readChecklistScheduleControl(shell)).toMatchObject({
      ok: true,
      recurrenceChoice: { frequency: 'custom', interval: 3, unit: 'week' },
    })
  })

  it('accepts a date with no time and schedules it for local 00:00', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value = '2026-08-20'
    expect((shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value).toBe('')

    const result = readChecklistScheduleControl(shell)
    expect(result.ok).toBe(true)
    const dueAt = (result as { ok: true; dueAt: string }).dueAt
    expect(checklistDueAtToLocalInput(dueAt)).toBe('2026-08-20T00:00')
  })

  it('rejects a schedule with a time but no date, and says the time is optional', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value = '09:30'

    expect(readChecklistScheduleControl(shell)).toEqual({
      ok: false,
      reason: 'Choose a valid due date. Leave the time blank for 00:00.',
    })
  })

  it('keeps an explicitly entered time untouched', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value = '2026-08-20'
    ;(shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value = '17:45'

    const result = readChecklistScheduleControl(shell)
    expect(result.ok).toBe(true)
    expect(checklistDueAtToLocalInput((result as { ok: true; dueAt: string }).dueAt)).toBe('2026-08-20T17:45')
  })

  it('keeps the focused schedule form outside Lexical selection ownership', () => {
    const editor = createEditor({
      namespace: 'checklist-schedule-selection',
      onError: (error) => {
        throw error
      },
    })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)

    const item = document.createElement('li')
    root.appendChild(item)
    const shell = syncChecklistDueShell(item, undefined, false, true)
    const input = shell.querySelector('[data-checklist-due-input]') as HTMLInputElement

    setChecklistSchedulePanelOpen(shell, true)
    input.focus()

    const inputRetainedFocus = document.activeElement === input
    const formOwnsItsSelection = isDOMCapturingSelection(input, editor)

    editor.setRootElement(null)
    root.remove()

    expect(inputRetainedFocus).toBe(true)
    expect(formOwnsItsSelection).toBe(true)
  })

  it('preserves the exact fold offset, seconds, and milliseconds when Save is a no-op', () => {
    const exactSecondFoldInstant = '2026-11-01T06:30:45.123Z'
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, exactSecondFoldInstant, false, true)
    const localParts = splitChecklistDueLocalInput(checklistDueAtToLocalInput(exactSecondFoldInstant))
    expect((shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value).toBe(localParts.date)
    expect((shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value).toBe(localParts.time)
    expect(readChecklistScheduleControl(shell, exactSecondFoldInstant)).toMatchObject({
      ok: true,
      dueAt: exactSecondFoldInstant,
    })
    // America/New_York repeats 01:30 on this date. Passing the captured wall
    // value makes the regression independent of the Jest host time zone.
    expect(resolveChecklistDueAtLocalInput('2026-11-01T01:30', exactSecondFoldInstant, '2026-11-01T01:30')).toBe(
      exactSecondFoldInstant,
    )
  })
})
