import { WebApplication } from '@/Application/WebApplication'
import { AvatarStorageKey } from './avatarCore'
import {
  AvatarChangedEvent,
  getStoredAvatar,
  processAndStoreAvatar,
  removeStoredAvatar,
  setStoredAvatar,
} from './avatarService'

/**
 * Standard Red Notes: tests for the application-bound avatar storage/events.
 *
 * The pure core (avatarCore.ts: validation, normalization, initials) is covered by
 * avatarCore.spec.ts. Here we cover the app storage K/V read/write, the
 * change-event dispatch, and processAndStoreAvatar's validation-rejection path
 * (the canvas pipeline itself needs a real browser canvas and is left to e2e).
 */

const A_VALID_DATA_URL = 'data:image/jpeg;base64,/9j/abc123'

type AppMock = {
  store: Record<string, unknown>
  application: WebApplication
  setValue: jest.Mock
}

const makeApplication = (initial: Record<string, unknown> = {}): AppMock => {
  const store: Record<string, unknown> = { ...initial }
  const setValue = jest.fn((key: string, value: unknown) => {
    store[key] = value
  })
  const application = {
    getValue: <T>(key: string): T => store[key] as T,
    setValue,
  } as unknown as WebApplication
  return { store, application, setValue }
}

describe('getStoredAvatar', () => {
  it('returns null when nothing is stored', () => {
    const { application } = makeApplication()
    expect(getStoredAvatar(application)).toBeNull()
  })

  it('returns a normalized stored data URL', () => {
    const { application } = makeApplication({ [AvatarStorageKey]: A_VALID_DATA_URL })
    expect(getStoredAvatar(application)).toBe(A_VALID_DATA_URL)
  })

  it('returns null for an invalid (non-data-url) stored value', () => {
    const { application } = makeApplication({ [AvatarStorageKey]: 'http://example.com/x.png' })
    expect(getStoredAvatar(application)).toBeNull()
  })

  it('returns null when getValue throws', () => {
    const application = {
      getValue: () => {
        throw new Error('storage error')
      },
    } as unknown as WebApplication
    expect(getStoredAvatar(application)).toBeNull()
  })
})

describe('setStoredAvatar / removeStoredAvatar', () => {
  it('persists the data URL and dispatches the change event', () => {
    const listener = jest.fn()
    window.addEventListener(AvatarChangedEvent, listener)
    const { application, setValue } = makeApplication()

    setStoredAvatar(application, A_VALID_DATA_URL)

    expect(setValue).toHaveBeenCalledWith(AvatarStorageKey, A_VALID_DATA_URL)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(AvatarChangedEvent, listener)
  })

  it('clears the stored value and dispatches the change event on remove', () => {
    const listener = jest.fn()
    window.addEventListener(AvatarChangedEvent, listener)
    const { application, setValue } = makeApplication({ [AvatarStorageKey]: A_VALID_DATA_URL })

    removeStoredAvatar(application)

    expect(setValue).toHaveBeenCalledWith(AvatarStorageKey, undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(AvatarChangedEvent, listener)
  })
})

describe('processAndStoreAvatar validation', () => {
  it('rejects an invalid file type before any processing or storage', async () => {
    const { application, setValue } = makeApplication()
    const file = { type: 'application/pdf', size: 1024 } as unknown as File
    await expect(processAndStoreAvatar(application, file)).rejects.toThrow(/png|jpeg|image/i)
    expect(setValue).not.toHaveBeenCalled()
  })

  it('rejects an oversized file before any processing or storage', async () => {
    const { application, setValue } = makeApplication()
    const file = { type: 'image/png', size: 50 * 1024 * 1024 } as unknown as File
    await expect(processAndStoreAvatar(application, file)).rejects.toThrow(/too large/i)
    expect(setValue).not.toHaveBeenCalled()
  })
})
