import { addToast, ToastType } from '@standardnotes/toast'
import {
  getNotificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  showNotification,
} from './notificationService'

/**
 * Standard Red Notes: tests for the framework-agnostic notification service.
 *
 * `@standardnotes/toast` is mapped to identity-obj-proxy by jest.config.js, so we
 * mock it here to assert on the in-app toast fallback. The Web Notification API is
 * stubbed per-test on `window.Notification`.
 */

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: {
    Regular: 'regular',
    Success: 'success',
    Error: 'error',
  },
}))

const mockedAddToast = addToast as unknown as jest.Mock

type NotificationStub = jest.Mock & {
  permission: NotificationPermission
  requestPermission: jest.Mock
}

const originalNotification = (window as unknown as { Notification?: unknown }).Notification

const setNotification = (value: unknown): void => {
  Object.defineProperty(window, 'Notification', {
    value,
    configurable: true,
    writable: true,
  })
}

/** Build a stub Notification constructor with a controllable permission. */
const makeNotificationStub = (permission: NotificationPermission): NotificationStub => {
  const ctor = jest.fn(function (this: Record<string, unknown>) {
    this.onclick = null
    this.close = jest.fn()
  }) as unknown as NotificationStub
  ctor.permission = permission
  ctor.requestPermission = jest.fn()
  return ctor
}

afterEach(() => {
  setNotification(originalNotification)
})

describe('notificationsSupported / getNotificationPermission', () => {
  it('reports unsupported when window.Notification is absent', () => {
    setNotification(undefined)
    expect(notificationsSupported()).toBe(false)
    expect(getNotificationPermission()).toBe('unsupported')
  })

  it('reads the current permission when supported', () => {
    setNotification(makeNotificationStub('granted'))
    expect(notificationsSupported()).toBe(true)
    expect(getNotificationPermission()).toBe('granted')

    setNotification(makeNotificationStub('denied'))
    expect(getNotificationPermission()).toBe('denied')
  })
})

describe('requestNotificationPermission', () => {
  it('returns unsupported without prompting when unsupported', async () => {
    setNotification(undefined)
    await expect(requestNotificationPermission()).resolves.toBe('unsupported')
  })

  it('does not re-prompt when permission is already granted or denied', async () => {
    const granted = makeNotificationStub('granted')
    setNotification(granted)
    await expect(requestNotificationPermission()).resolves.toBe('granted')
    expect(granted.requestPermission).not.toHaveBeenCalled()

    const denied = makeNotificationStub('denied')
    setNotification(denied)
    await expect(requestNotificationPermission()).resolves.toBe('denied')
    expect(denied.requestPermission).not.toHaveBeenCalled()
  })

  it('prompts when permission is default and returns the result', async () => {
    const stub = makeNotificationStub('default')
    stub.requestPermission.mockResolvedValue('granted')
    setNotification(stub)
    await expect(requestNotificationPermission()).resolves.toBe('granted')
    expect(stub.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('falls back to the current permission when requestPermission throws', async () => {
    const stub = makeNotificationStub('default')
    stub.requestPermission.mockImplementation(() => {
      throw new Error('legacy callback form')
    })
    setNotification(stub)
    // getNotificationPermission() still reads 'default' off the stub.
    await expect(requestNotificationPermission()).resolves.toBe('default')
  })
})

describe('showNotification', () => {
  it('shows an OS notification AND a toast when permission is granted', () => {
    const stub = makeNotificationStub('granted')
    setNotification(stub)

    const result = showNotification('Hello', { body: 'World', tag: 'r1' })

    expect(stub).toHaveBeenCalledWith('Hello', { body: 'World', tag: 'r1' })
    expect(result).toEqual({ osNotificationShown: true, toastShown: true })
    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    expect(mockedAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hello', message: 'World', type: ToastType.Regular }),
    )
  })

  it('only shows the toast fallback when permission is not granted', () => {
    setNotification(makeNotificationStub('denied'))
    const result = showNotification('Hi')
    expect(result).toEqual({ osNotificationShown: false, toastShown: true })
    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    // Empty body becomes an empty toast message, never undefined.
    expect(mockedAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: '' }))
  })

  it('only shows the toast fallback when unsupported', () => {
    setNotification(undefined)
    const result = showNotification('Hi', { toastType: ToastType.Error })
    expect(result.osNotificationShown).toBe(false)
    expect(result.toastShown).toBe(true)
    expect(mockedAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Error }))
  })

  it('still shows the toast when the OS Notification constructor throws', () => {
    const throwingCtor = jest.fn(() => {
      throw new Error('blocked')
    }) as unknown as NotificationStub
    throwingCtor.permission = 'granted'
    setNotification(throwingCtor)

    const result = showNotification('Hi', { body: 'x' })
    expect(result).toEqual({ osNotificationShown: false, toastShown: true })
    expect(mockedAddToast).toHaveBeenCalledTimes(1)
  })

  it('wires onClick to focus the window and close the notification', () => {
    const closeSpy = jest.fn()
    const focusSpy = jest.spyOn(window, 'focus').mockImplementation(() => undefined)
    const created: Record<string, unknown>[] = []
    const ctor = jest.fn(function (this: Record<string, unknown>) {
      this.onclick = null
      this.close = closeSpy
      created.push(this)
    }) as unknown as NotificationStub
    ctor.permission = 'granted'
    setNotification(ctor)

    const onClick = jest.fn()
    showNotification('Hi', { onClick })

    const instance = created[0]
    expect(typeof instance.onclick).toBe('function')
    ;(instance.onclick as () => void)()

    expect(focusSpy).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    focusSpy.mockRestore()
  })

  it('passes toast actions through to the fallback toast', () => {
    setNotification(makeNotificationStub('denied'))
    const actions = [{ label: 'Open', handler: jest.fn() }]
    showNotification('Hi', { toastActions: actions })
    expect(mockedAddToast).toHaveBeenCalledWith(expect.objectContaining({ actions }))
  })
})
