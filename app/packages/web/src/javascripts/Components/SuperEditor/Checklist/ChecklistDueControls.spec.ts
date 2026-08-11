import { createChecklistDueShell, syncChecklistDueShell } from './ChecklistDueControls'

describe('checklist due controls', () => {
  it('renders a semantic countdown with print-excluded edit controls', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:00:00.000Z'))
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', false, true)

    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('1d 2h left')
    expect(shell.querySelector('[data-srn-print-exclude="true"]')).not.toBeNull()
    expect(shell.querySelector('input')?.getAttribute('type')).toBe('datetime-local')
    expect(shell.querySelector('[data-checklist-due-action="clear"]')?.hasAttribute('hidden')).toBe(false)
    jest.useRealTimers()
  })

  it('hides controls in readonly mode while retaining the due label', () => {
    const item = document.createElement('li')
    item.appendChild(createChecklistDueShell())
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', true, false)
    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('Completed')
    expect((shell.querySelector('[data-srn-print-exclude]') as HTMLElement).hidden).toBe(true)
  })
})
