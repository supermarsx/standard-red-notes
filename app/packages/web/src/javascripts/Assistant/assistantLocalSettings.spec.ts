/** @jest-environment jsdom */
import {
  ASSISTANT_DATA_EXPOSURE_NOTICE_KEY,
  persistAssistantContextScope,
  persistAssistantNoticeDismissed,
  readAssistantContextScope,
  readAssistantNoticeDismissed,
  readAssistantNoticeReminderAt,
} from './assistantLocalSettings'

describe('account-scoped assistant local settings', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => jest.useRealTimers())

  const noticeKey = (scope: string) => `${ASSISTANT_DATA_EXPOSURE_NOTICE_KEY}:${encodeURIComponent(scope)}`

  it('reminds after exactly 15 days and exposes the deadline for an open panel', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-16T12:00:00Z'))
    const now = Date.now()
    persistAssistantNoticeDismissed('account:a', '15-days')
    const remindAt = now + 15 * 24 * 60 * 60 * 1_000
    expect(readAssistantNoticeReminderAt('account:a')).toBe(remindAt)
    expect(readAssistantNoticeDismissed('account:a')).toBe(true)
    expect(readAssistantNoticeDismissed('account-b')).toBe(false)
    jest.setSystemTime(remindAt - 1)
    expect(readAssistantNoticeDismissed('account:a')).toBe(true)
    jest.setSystemTime(remindAt)
    expect(readAssistantNoticeDismissed('account:a')).toBe(false)
    expect(readAssistantNoticeReminderAt('account:a')).toBe(remindAt)
  })

  it('does not persist a just-this-time choice, including when replacing an older choice', () => {
    persistAssistantNoticeDismissed('account-a', 'never')
    persistAssistantNoticeDismissed('account-a', 'once')
    expect(localStorage.getItem(noticeKey('account-a'))).toBeNull()
    expect(readAssistantNoticeDismissed('account-a')).toBe(false)
  })

  it('keeps prior true acknowledgements and explicit never choices compatible', () => {
    localStorage.setItem(noticeKey('legacy'), 'true')
    expect(readAssistantNoticeDismissed('legacy')).toBe(true)
    expect(readAssistantNoticeReminderAt('legacy')).toBeUndefined()
    persistAssistantNoticeDismissed('new', 'never')
    expect(localStorage.getItem(noticeKey('new'))).toBe('true')
  })

  it.each([
    'false',
    '123',
    'null',
    '[]',
    '{',
    '{"mode":"15-days","remindAt":"9999999999999"}',
    '{"mode":"15-days","remindAt":-1}',
    '{"mode":"15-days","remindAt":1.5}',
    '{"mode":"15-days","remindAt":99999999999999999}',
    '{"mode":"never","remindAt":9999999999999}',
  ])('shows the warning for malformed acknowledgement %s', (stored) => {
    localStorage.setItem(noticeKey('account-a'), stored)
    expect(readAssistantNoticeDismissed('account-a')).toBe(false)
    expect(readAssistantNoticeReminderAt('account-a')).toBeUndefined()
  })

  it('treats unavailable local storage as unacknowledged and writes as best effort', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const remove = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(readAssistantNoticeDismissed('account-a')).toBe(false)
      expect(readAssistantNoticeReminderAt('account-a')).toBeUndefined()
      expect(() => persistAssistantNoticeDismissed('account-a', '15-days')).not.toThrow()
      expect(() => persistAssistantNoticeDismissed('account-a', 'once')).not.toThrow()
    } finally {
      get.mockRestore()
      set.mockRestore()
      remove.mockRestore()
    }
  })

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

it.each(['no-note', 'new-note'] as const)('persists %s in this account without changing another account', (scope) => {
  localStorage.clear()
  persistAssistantContextScope('account-a', scope)
  expect(readAssistantContextScope('account-a')).toBe(scope)
  expect(readAssistantContextScope('account-b')).toBe('current-note')
})
