/**
 * @jest-environment jsdom
 */
import {
  clearSharedServerAccessKey,
  persistSharedServerAccessKey,
  readSharedServerAccessKey,
  SHARED_SERVER_ACCESS_KEY_HEADER,
} from './SharedServerAccessKey'

const STORAGE_KEY = 'sn_shared_server_access_key'

describe('SharedServerAccessKey', () => {
  afterEach(() => {
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('should pin the header name the gateway gate expects', () => {
    expect(SHARED_SERVER_ACCESS_KEY_HEADER).toBe('X-Shared-Server-Key')
  })

  it('should return undefined when nothing has been persisted', () => {
    expect(readSharedServerAccessKey()).toBeUndefined()
  })

  it('should round-trip a persisted key', () => {
    persistSharedServerAccessKey('operator-key')

    expect(localStorage.getItem(STORAGE_KEY)).toBe('operator-key')
    expect(readSharedServerAccessKey()).toBe('operator-key')
  })

  it('should clear the persisted key', () => {
    persistSharedServerAccessKey('operator-key')

    clearSharedServerAccessKey()

    expect(readSharedServerAccessKey()).toBeUndefined()
  })

  it('should fail open when reading throws, e.g. private browsing', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(readSharedServerAccessKey()).toBeUndefined()
  })

  it('should swallow a write failure rather than breaking the caller', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => persistSharedServerAccessKey('operator-key')).not.toThrow()
  })

  it('should swallow a removal failure rather than breaking the caller', () => {
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => clearSharedServerAccessKey()).not.toThrow()
  })
})
