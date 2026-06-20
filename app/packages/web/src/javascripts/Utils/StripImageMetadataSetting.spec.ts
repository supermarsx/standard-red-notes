import {
  getStripImageMetadataEnabled,
  setStripImageMetadataEnabled,
  subscribeStripImageMetadata,
} from './StripImageMetadataSetting'

/**
 * Standard Red Notes: tests for the "strip image metadata on upload" local toggle.
 *
 * Covers the safe-by-default semantics (default ON, only explicit 'false'
 * disables), persistence, change-event fan-out, and graceful degradation when
 * localStorage is unavailable.
 */

const STORAGE_KEY = 'sn_strip_image_metadata_on_upload'

beforeEach(() => {
  window.localStorage.clear()
})

describe('getStripImageMetadataEnabled', () => {
  it('defaults to ON when no value is stored', () => {
    expect(getStripImageMetadataEnabled()).toBe(true)
  })

  it('is ON for any value other than the literal string "false"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true')
    expect(getStripImageMetadataEnabled()).toBe(true)
    window.localStorage.setItem(STORAGE_KEY, 'garbage')
    expect(getStripImageMetadataEnabled()).toBe(true)
  })

  it('is OFF only for the literal string "false"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'false')
    expect(getStripImageMetadataEnabled()).toBe(false)
  })

  it('falls back to the default (ON) when localStorage.getItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(getStripImageMetadataEnabled()).toBe(true)
    spy.mockRestore()
  })
})

describe('setStripImageMetadataEnabled', () => {
  it('persists the toggle as "true"/"false" strings', () => {
    setStripImageMetadataEnabled(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')
    setStripImageMetadataEnabled(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false')
    expect(getStripImageMetadataEnabled()).toBe(false)
  })

  it('does not throw when localStorage.setItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => setStripImageMetadataEnabled(true)).not.toThrow()
    spy.mockRestore()
  })
})

describe('subscribeStripImageMetadata', () => {
  it('invokes the callback on same-tab changes via the custom event', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeStripImageMetadata(cb)
    setStripImageMetadataEnabled(false)
    expect(cb).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('invokes the callback on cross-tab changes via the storage event for this key', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeStripImageMetadata(cb)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    expect(cb).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('ignores storage events for unrelated keys', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeStripImageMetadata(cb)
    window.dispatchEvent(new StorageEvent('storage', { key: 'some_other_key' }))
    expect(cb).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops invoking the callback after unsubscribe', () => {
    const cb = jest.fn()
    const unsubscribe = subscribeStripImageMetadata(cb)
    unsubscribe()
    setStripImageMetadataEnabled(true)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    expect(cb).not.toHaveBeenCalled()
  })
})
