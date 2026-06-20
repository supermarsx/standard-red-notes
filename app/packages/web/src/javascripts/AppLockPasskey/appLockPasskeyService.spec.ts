import { WebApplication } from '@/Application/WebApplication'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { AppLockPasskeyCredential, AppLockPasskeyStorageKey } from './appLockPasskey'
import {
  authenticateAppLockPasskey,
  getAppLockPasskeyCredential,
  isAppLockPasskeyRegistered,
  isAppLockPasskeySupported,
  registerAppLockPasskey,
  removeAppLockPasskey,
} from './appLockPasskeyService'

/**
 * Standard Red Notes: tests for the application-bound passkey app-lock service.
 *
 * The pure core (appLockPasskey.ts) is covered by appLockPasskey.spec.ts. Here we
 * mock the WebAuthn ceremonies (`@simplewebauthn/browser`) and the app storage K/V
 * to cover register/unlock/remove, support detection, and cancel/mismatch paths.
 */

jest.mock('@simplewebauthn/browser', () => ({
  startRegistration: jest.fn(),
  startAuthentication: jest.fn(),
}))

const mockedStartRegistration = startRegistration as jest.Mock
const mockedStartAuthentication = startAuthentication as jest.Mock

type AppMock = {
  store: Record<string, unknown>
  application: WebApplication
  removeValue: jest.Mock
}

const makeApplication = (opts: { isNativeMobileWeb?: boolean; stored?: unknown } = {}): AppMock => {
  const store: Record<string, unknown> = {}
  if (opts.stored !== undefined) {
    store[AppLockPasskeyStorageKey] = opts.stored
  }
  const removeValue = jest.fn((key: string) => {
    delete store[key]
    return Promise.resolve()
  })
  const application = {
    getValue: <T>(key: string): T => store[key] as T,
    setValue: (key: string, value: unknown) => {
      store[key] = value
    },
    removeValue,
    isNativeMobileWeb: () => opts.isNativeMobileWeb ?? false,
  } as unknown as WebApplication
  return { store, application, removeValue }
}

const credential = (overrides: Partial<AppLockPasskeyCredential> = {}): AppLockPasskeyCredential => ({
  credentialId: 'cred-1',
  label: 'This device',
  registeredAt: 1000,
  ...overrides,
})

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('getAppLockPasskeyCredential / isAppLockPasskeyRegistered', () => {
  it('returns null and false when nothing is stored', () => {
    const { application } = makeApplication()
    expect(getAppLockPasskeyCredential(application)).toBeNull()
    expect(isAppLockPasskeyRegistered(application)).toBe(false)
  })

  it('returns the normalized credential when registered', () => {
    const { application } = makeApplication({ stored: credential() })
    expect(getAppLockPasskeyCredential(application)).toEqual(credential())
    expect(isAppLockPasskeyRegistered(application)).toBe(true)
  })
})

describe('isAppLockPasskeySupported', () => {
  const originalPKC = (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential

  afterEach(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: originalPKC, configurable: true })
  })

  const setPKC = (value: unknown) =>
    Object.defineProperty(window, 'PublicKeyCredential', { value, configurable: true })

  it('is false on native mobile web', () => {
    setPKC(function () {})
    const { application } = makeApplication({ isNativeMobileWeb: true })
    expect(isAppLockPasskeySupported(application)).toBe(false)
  })

  it('is false when the WebAuthn API is unavailable', () => {
    setPKC(undefined)
    const { application } = makeApplication()
    expect(isAppLockPasskeySupported(application)).toBe(false)
  })

  it('is true on a desktop browser with WebAuthn', () => {
    setPKC(function () {})
    const { application } = makeApplication()
    expect(isAppLockPasskeySupported(application)).toBe(true)
  })
})

describe('registerAppLockPasskey', () => {
  it('persists and returns the credential on a successful ceremony', async () => {
    mockedStartRegistration.mockResolvedValue({ id: 'new-cred' })
    const app = makeApplication()
    const result = await registerAppLockPasskey(app.application, 'My Laptop')
    expect(result).toMatchObject({ credentialId: 'new-cred', label: 'My Laptop' })
    expect(app.store[AppLockPasskeyStorageKey]).toMatchObject({ credentialId: 'new-cred' })
  })

  it('returns null and stores nothing when the user cancels', async () => {
    mockedStartRegistration.mockRejectedValue(new Error('cancelled'))
    const app = makeApplication()
    expect(await registerAppLockPasskey(app.application)).toBeNull()
    expect(app.store[AppLockPasskeyStorageKey]).toBeUndefined()
  })

  it('returns null when the ceremony yields no credential id', async () => {
    mockedStartRegistration.mockResolvedValue({ id: '' })
    const app = makeApplication()
    expect(await registerAppLockPasskey(app.application)).toBeNull()
    expect(app.store[AppLockPasskeyStorageKey]).toBeUndefined()
  })
})

describe('removeAppLockPasskey', () => {
  it('removes the stored credential', async () => {
    const app = makeApplication({ stored: credential() })
    await removeAppLockPasskey(app.application)
    expect(app.removeValue).toHaveBeenCalledWith(AppLockPasskeyStorageKey)
    expect(app.store[AppLockPasskeyStorageKey]).toBeUndefined()
  })
})

describe('authenticateAppLockPasskey', () => {
  it('returns false immediately when no credential is registered', async () => {
    const app = makeApplication()
    expect(await authenticateAppLockPasskey(app.application)).toBe(false)
    expect(mockedStartAuthentication).not.toHaveBeenCalled()
  })

  it('returns true when the assertion matches the registered credential id', async () => {
    mockedStartAuthentication.mockResolvedValue({ id: 'cred-1' })
    const app = makeApplication({ stored: credential() })
    expect(await authenticateAppLockPasskey(app.application)).toBe(true)
  })

  it('returns false when the assertion id does not match', async () => {
    mockedStartAuthentication.mockResolvedValue({ id: 'different' })
    const app = makeApplication({ stored: credential() })
    expect(await authenticateAppLockPasskey(app.application)).toBe(false)
  })

  it('returns false when the unlock ceremony is cancelled/fails', async () => {
    mockedStartAuthentication.mockRejectedValue(new Error('cancelled'))
    const app = makeApplication({ stored: credential() })
    expect(await authenticateAppLockPasskey(app.application)).toBe(false)
  })
})
