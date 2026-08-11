import { sanitizePrintBody } from '../../NoteView/Print/PrintNote'
import { syncChecklistDueShell } from './ChecklistDueControls'

describe('checklist due print projection', () => {
  it('keeps deadline semantics and removes every editing control', () => {
    const body = document.createElement('div')
    const item = document.createElement('li')
    item.append('Submit release')
    body.appendChild(item)
    syncChecklistDueShell(item, '2099-08-12T12:00:00.000Z', false, true)

    const printed = sanitizePrintBody(body)
    expect(printed.textContent).toContain('Submit release')
    expect(printed.textContent).toContain('left')
    expect(printed.querySelector('button, input, [data-srn-print-exclude]')).toBeNull()
  })
})
