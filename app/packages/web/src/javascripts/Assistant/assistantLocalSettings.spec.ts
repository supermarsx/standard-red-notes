/** @jest-environment jsdom */
import {
  persistAssistantContextScope,
  persistAssistantNoticeDismissed,
  readAssistantContextScope,
  readAssistantNoticeDismissed,
} from './assistantLocalSettings'

describe('account-scoped assistant local settings', () => {
  beforeEach(() => localStorage.clear())

  it('does not carry a dismissed exposure notice into another account', () => {
    persistAssistantNoticeDismissed('account-a')
    expect(readAssistantNoticeDismissed('account-a')).toBe(true)
    expect(readAssistantNoticeDismissed('account-b')).toBe(false)
  })

  it('keeps context scope isolated and validates stored values', () => {
    persistAssistantContextScope('account-a', 'all-notes')
    expect(readAssistantContextScope('account-a')).toBe('all-notes')
    expect(readAssistantContextScope('account-b')).toBe('current-note')
  })
})
