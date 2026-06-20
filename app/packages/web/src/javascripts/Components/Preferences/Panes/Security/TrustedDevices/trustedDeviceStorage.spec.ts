import {
  clearTrustedDeviceToken,
  getTrustedDeviceToken,
  persistTrustedDeviceToken,
} from './trustedDeviceStorage'

/**
 * Standard Red Notes: tests for the trusted-device-token local store.
 *
 * Covers persist/read/clear round-trips and the fail-safe behaviour when
 * localStorage is unavailable (read returns null; writes are swallowed).
 */

const STORAGE_KEY = 'sn_trusted_device_token'

beforeEach(() => {
  window.localStorage.clear()
})

describe('persist / get / clear trusted device token', () => {
  it('returns null when no token is stored', () => {
    expect(getTrustedDeviceToken()).toBeNull()
  })

  it('persists and reads back a token', () => {
    persistTrustedDeviceToken('tok-123')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('tok-123')
    expect(getTrustedDeviceToken()).toBe('tok-123')
  })

  it('clears the stored token', () => {
    persistTrustedDeviceToken('tok-123')
    clearTrustedDeviceToken()
    expect(getTrustedDeviceToken()).toBeNull()
  })
})

describe('fail-safe behaviour when localStorage is unavailable', () => {
  it('getTrustedDeviceToken returns null when getItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(getTrustedDeviceToken()).toBeNull()
    spy.mockRestore()
  })

  it('persistTrustedDeviceToken swallows setItem errors', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => persistTrustedDeviceToken('tok')).not.toThrow()
    spy.mockRestore()
  })

  it('clearTrustedDeviceToken swallows removeItem errors', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'removeItem').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => clearTrustedDeviceToken()).not.toThrow()
    spy.mockRestore()
  })
})
