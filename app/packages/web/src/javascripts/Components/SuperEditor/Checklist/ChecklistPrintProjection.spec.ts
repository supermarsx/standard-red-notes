import { sanitizePrintBody } from '../../NoteView/Print/PrintNote'
import { syncChecklistDueShell } from './ChecklistDueControls'
import { createChecklistRecurrence } from './checklistRecurrence'

describe('checklist due print projection', () => {
  it('keeps deadline semantics and removes every editing control', () => {
    const body = document.createElement('div')
    const item = document.createElement('li')
    item.append('Submit release')
    body.appendChild(item)
    const dueAt = '2099-08-12T12:00:00.000Z'
    syncChecklistDueShell(item, dueAt, false, true, createChecklistRecurrence('weekly', dueAt, 'UTC'))

    const printed = sanitizePrintBody(body)
    expect(printed.textContent).toContain('Submit release')
    expect(printed.textContent).toContain('left')
    expect(printed.textContent).toContain('Repeats weekly')
    expect(printed.textContent).toContain('UTC wall time')
    expect(printed.querySelector('button, input, [data-srn-print-exclude]')).toBeNull()
  })
})
