import { isInteractiveChecklistEditorOwner } from './ChecklistOwnerMode'

describe('detached checklist editor owner capabilities', () => {
  it('disables global editor commands and interactive focus behavior', () => {
    expect(isInteractiveChecklistEditorOwner(true)).toBe(false)
    expect(isInteractiveChecklistEditorOwner(false)).toBe(true)
  })
})
