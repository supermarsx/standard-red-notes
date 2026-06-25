import {
  getFormattingMarksEnabled,
  setFormattingMarksEnabled,
  toggleFormattingMarksEnabled,
  subscribeFormattingMarks,
  SHOW_FORMATTING_MARKS_CLASS,
} from './formattingMarksSetting'

/**
 * Standard Red Notes: tests for the "show formatting marks" (¶) local toggle.
 *
 * Defaults OFF: only the literal string 'true' enables it. Covers persistence,
 * default behaviour, toggle, change-event fan-out, and localStorage-unavailable
 * degradation. Mirrors autoMoveSetting.spec.ts.
 */

const STORAGE_KEY = 'sn_super_show_formatting_marks'

beforeEach(() => {
  window.localStorage.clear()
})

describe('getFormattingMarksEnabled', () => {
  it('defaults to OFF when nothing is stored', () => {
    expect(getFormattingMarksEnabled()).toBe(false)
  })

  it('is ON only for the literal string "true"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true')
    expect(getFormattingMarksEnabled()).toBe(true)
    window.localStorage.setItem(STORAGE_KEY, 'false')
    expect(getFormattingMarksEnabled()).toBe(false)
    window.localStorage.setItem(STORAGE_KEY, 'garbage')
    expect(getFormattingMarksEnabled()).toBe(false)
  })

  it('falls back to OFF when localStorage.getItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(getFormattingMarksEnabled()).toBe(false)
    spy.mockRestore()
  })
})

describe('setFormattingMarksEnabled', () => {
  it('persists the toggle and round-trips', () => {
    setFormattingMarksEnabled(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')
    expect(getFormattingMarksEnabled()).toBe(true)
    setFormattingMarksEnabled(false)
    expect(getFormattingMarksEnabled()).toBe(false)
  })

  it('does not throw when localStorage.setItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => setFormattingMarksEnabled(true)).not.toThrow()
    spy.mockRestore()
  })
})

describe('toggleFormattingMarksEnabled', () => {
  it('flips the value and returns the new state', () => {
    expect(getFormattingMarksEnabled()).toBe(false)
    expect(toggleFormattingMarksEnabled()).toBe(true)
    expect(getFormattingMarksEnabled()).toBe(true)
    expect(toggleFormattingMarksEnabled()).toBe(false)
    expect(getFormattingMarksEnabled()).toBe(false)
  })
})

describe('subscribeFormattingMarks', () => {
  it('fires on same-tab changes and on storage events for this key', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeFormattingMarks(cb)
    setFormattingMarksEnabled(true)
    expect(cb).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    expect(cb).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('ignores storage events for unrelated keys', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeFormattingMarks(cb)
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(cb).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops firing after unsubscribe', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeFormattingMarks(cb)
    unsubscribe()
    setFormattingMarksEnabled(true)
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('SHOW_FORMATTING_MARKS_CLASS', () => {
  it('is the stable class name used by the CSS', () => {
    expect(SHOW_FORMATTING_MARKS_CLASS).toBe('show-formatting-marks')
  })
})
