import {
  getChecklistAutoMoveEnabled,
  setChecklistAutoMoveEnabled,
  subscribeChecklistAutoMove,
} from './autoMoveSetting'

/**
 * Standard Red Notes: tests for the "move completed checklist tasks" local toggle.
 *
 * Unlike the strip-metadata toggle, this one defaults OFF: only the literal string
 * 'true' enables it. Covers persistence, default behaviour, change-event fan-out,
 * and localStorage-unavailable degradation.
 */

const STORAGE_KEY = 'sn_super_checklist_auto_move_completed'

beforeEach(() => {
  window.localStorage.clear()
})

describe('getChecklistAutoMoveEnabled', () => {
  it('defaults to OFF when nothing is stored', () => {
    expect(getChecklistAutoMoveEnabled()).toBe(false)
  })

  it('is ON only for the literal string "true"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true')
    expect(getChecklistAutoMoveEnabled()).toBe(true)
    window.localStorage.setItem(STORAGE_KEY, 'false')
    expect(getChecklistAutoMoveEnabled()).toBe(false)
    window.localStorage.setItem(STORAGE_KEY, 'garbage')
    expect(getChecklistAutoMoveEnabled()).toBe(false)
  })

  it('falls back to OFF when localStorage.getItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(getChecklistAutoMoveEnabled()).toBe(false)
    spy.mockRestore()
  })
})

describe('setChecklistAutoMoveEnabled', () => {
  it('persists the toggle and round-trips', () => {
    setChecklistAutoMoveEnabled(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')
    expect(getChecklistAutoMoveEnabled()).toBe(true)
    setChecklistAutoMoveEnabled(false)
    expect(getChecklistAutoMoveEnabled()).toBe(false)
  })

  it('does not throw when localStorage.setItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => setChecklistAutoMoveEnabled(true)).not.toThrow()
    spy.mockRestore()
  })
})

describe('subscribeChecklistAutoMove', () => {
  it('fires on same-tab changes and on storage events for this key', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeChecklistAutoMove(cb)
    setChecklistAutoMoveEnabled(true)
    expect(cb).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    expect(cb).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('ignores storage events for unrelated keys', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeChecklistAutoMove(cb)
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(cb).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops firing after unsubscribe', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeChecklistAutoMove(cb)
    unsubscribe()
    setChecklistAutoMoveEnabled(true)
    expect(cb).not.toHaveBeenCalled()
  })
})
