/**
 * @jest-environment jsdom
 *
 * "Recalculate storage quota": what the pane SHOWS and what it SAYS afterwards.
 *
 * The server answers that request when the recount is REQUESTED. On the
 * multi-container build the recount itself runs in a worker and the figure is
 * stored whenever that worker gets to it. The pane used to read the usage once,
 * the moment the request was answered, under a toast promising "the refreshed
 * usage appears here once the server finishes". Measured on a real compose stack
 * with the worker restarting, the figure was stored 18 seconds after the click
 * and the pane, untouched, still read "Not reported" at 30 seconds.
 *
 * These drive the REAL component (react-dom/client + act, as AdminUsersTab.spec
 * does). The server is the only stand-in, and it answers the way the measured
 * one did: the old figure first, the recounted one later.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

jest.mock('@standardnotes/filepicker', () => ({
  formatSizeToReadableString: (bytes: number) => `${bytes} B`,
}))

import { addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import AdminUsersTab, { ADMIN_QUOTA_RECOUNT_REREAD_DELAYS_MS } from './AdminUsersTab'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGET_UUID = 'target-user-uuid'
const TARGET_EMAIL = 'target@example.com'
const OTHER_UUID = 'other-user-uuid'
const OTHER_EMAIL = 'other@example.com'
const WINDOW_MS = ADMIN_QUOTA_RECOUNT_REREAD_DELAYS_MS.reduce((total, delay) => total + delay, 0)

const usageAnswer = (uploadBytesUsed: number | null, uploadBytesLimit: number | null = null) => ({
  data: { flags: {}, storage: { hasSubscription: false, uploadBytesLimit, uploadBytesUsed } },
})

const listRow = (uuid: string, email: string) => ({
  uuid,
  email,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  roles: [],
  subscription: null,
  banned: false,
  suspended: false,
  mfaEnabled: false,
  storageUsedBytes: null,
  storageLimitBytes: null,
})

/**
 * `usageReadings` is what the server stores for the TARGET, read by read: the
 * first is the panel's own load, the second is the read made when the recount
 * request is answered, and each one after that is a later re-read. The last
 * reading repeats for as long as the pane keeps asking.
 */
const makeApplication = (usageReadings: Array<number | null>, uploadBytesLimit: number | null = null) => {
  let targetReads = 0

  return {
    legacyApi: {
      adminGetUserStorageUsage: jest.fn().mockResolvedValue({
        data: {
          itemBytesUsed: 0,
          itemsMeasured: 0,
          itemsUnmeasured: 0,
          totalBytesUsed: 0,
          complete: true,
          components: {
            items: { bytes: 0, count: 0, complete: true },
            files: { bytes: 0, count: 0, complete: true },
            revisions: { bytes: 0, count: 0, complete: true },
          },
        },
      }),
      adminGetUserMfaStatus: jest.fn().mockResolvedValue({
        data: {
          totpConfigured: false,
          securityKeyCount: 0,
          magicLinkEnabled: false,
          recoveryCodesAvailable: false,
          trustedDeviceCount: 0,
          appPasswordCount: 0,
          openSessionCount: 0,
        },
      }),
      getAdminUserSessions: jest.fn().mockResolvedValue({ data: [] }),
      adminListUsers: jest.fn().mockResolvedValue({
        data: { users: [listRow(TARGET_UUID, TARGET_EMAIL), listRow(OTHER_UUID, OTHER_EMAIL)], total: 2 },
      }),
      adminGetAvailableRoles: jest.fn().mockResolvedValue({ data: { roleNames: [] } }),
      adminGetUserFeatureFlags: jest.fn((userUuid: string): Promise<unknown> => {
        if (userUuid !== TARGET_UUID) {
          return Promise.resolve(usageAnswer(777))
        }
        const reading = usageReadings[Math.min(targetReads, usageReadings.length - 1)]
        targetReads += 1

        return Promise.resolve(usageAnswer(reading, uploadBytesLimit))
      }),
      adminFixUserQuota: jest.fn((): Promise<unknown> => Promise.resolve({ data: { success: true } })),
      adminGetUsersItemStorageUsage: jest.fn((userUuids: string[]): Promise<unknown> =>
        Promise.resolve({
          data: {
            usages: userUuids.map((userUuid) => ({ userUuid, itemBytesUsed: 0, itemsMeasured: 0, itemsUnmeasured: 0 })),
          },
        }),
      ),
      adminGetUserUsage: jest.fn().mockResolvedValue({ data: null }),
      adminSetUserFeatureFlag: jest.fn().mockResolvedValue({ data: { success: true } }),
      adminGetUserBanStatus: jest.fn().mockResolvedValue({ data: { banned: false } }),
      adminGetUserSuspensionStatus: jest.fn().mockResolvedValue({ data: { suspended: false } }),
      adminGetUserEffectivePermissions: jest.fn().mockResolvedValue({
        data: { directRoleNames: [], groupRoleNames: [], effectiveRoleNames: [], effectivePermissionNames: [] },
      }),
    },
    sessions: { getUser: () => ({ uuid: 'current-admin-uuid' }) },
  }
}

type Application = ReturnType<typeof makeApplication>

let container: HTMLElement
let root: Root

const flush = async () => {
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  // `resetMocks` clears what the factory above set, so the dialog is accepted here.
  ;(confirmDialog as jest.Mock).mockResolvedValue(true)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  jest.useRealTimers()
})

const renderUser = async (application: Application, uuid: string, email: string) => {
  await act(async () => {
    root.render(
      createElement(AdminUsersTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
        email,
        setEmail: jest.fn(),
        user: { uuid, email },
        setUser: jest.fn(),
      }),
    )
  })
  await act(async () => {
    await flush()
  })
}

/** The pane's own button, then its own confirm dialog (which the stub accepts). */
const requestRecount = async () => {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    (candidate.textContent ?? '').includes('Fix quota'),
  )
  if (!button) {
    throw new Error('The Fix quota button was not rendered')
  }
  await act(async () => {
    button.click()
    await flush()
  })
}

/** Let `ms` pass with nobody touching the pane, and let what that starts finish. */
const wait = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
    await flush()
  })
}

const storageReadout = (): string =>
  container.querySelector('[data-test-id="admin-storage-readout"]')?.textContent ?? ''
const recountStatus = (): string | null =>
  container.querySelector('[data-test-id="admin-quota-recount-status"]')?.textContent ?? null
const filesCellFor = (email: string): string => {
  const row = Array.from(container.querySelectorAll('tbody tr')).find((candidate) =>
    Array.from(candidate.querySelectorAll('td')).some((cell) => cell.textContent === email),
  )
  if (!row) {
    throw new Error(`No list row rendered for ${email}`)
  }

  return row.querySelector('[data-test-id="admin-row-files"]')?.textContent ?? ''
}
const usageReadsFor = (application: Application, uuid: string): number =>
  application.legacyApi.adminGetUserFeatureFlags.mock.calls.filter(([asked]) => asked === uuid).length
const toastMessages = (): string[] =>
  (addToast as jest.Mock).mock.calls.map(([toast]) => (toast as { message: string }).message)

describe('AdminUsersTab — after "Recalculate storage quota"', () => {
  it('shows a figure the server stored AFTER the request was answered, with nobody touching the pane', async () => {
    // Load: none stored. Read on the answer: still none. Then the worker gets there.
    const application = makeApplication([null, null, null, 0])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    expect(storageReadout()).toContain('Current usage: Not reported')

    await requestRecount()

    // The request is answered and the one read the pane always made is back: stale.
    expect(application.legacyApi.adminFixUserQuota).toHaveBeenCalledWith(TARGET_UUID)
    expect(storageReadout()).toContain('Current usage: Not reported')
    expect(recountStatus()).toBe(
      'Recount requested. The stored usage still reads Not reported; this panel re-reads it for up to 30 seconds.',
    )

    await wait(1000)
    expect(storageReadout()).toContain('Current usage: Not reported')

    // Three seconds in, the figure is there, and the pane has it.
    await wait(2000)
    expect(storageReadout()).toContain('Current usage: 0 B')
    expect(recountStatus()).toBe('Recount requested. The stored usage read Not reported before it and 0 B after it.')
  })

  it('stops re-reading as soon as the figure has changed', async () => {
    const application = makeApplication([null, null, 0])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    await wait(1000)
    expect(storageReadout()).toContain('Current usage: 0 B')
    const readsWhenItChanged = usageReadsFor(application, TARGET_UUID)

    await wait(WINDOW_MS)

    expect(usageReadsFor(application, TARGET_UUID)).toBe(readsWhenItChanged)
  })

  it('reads once and does not wait when the figure was already recounted by the time the request answered', async () => {
    // The all-in-one container: the recount has run before the request returns.
    const application = makeApplication([null, 0])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)

    await requestRecount()

    expect(storageReadout()).toContain('Current usage: 0 B')
    expect(recountStatus()).toBe('Recount requested. The stored usage read Not reported before it and 0 B after it.')
    const reads = usageReadsFor(application, TARGET_UUID)
    await wait(WINDOW_MS)
    expect(usageReadsFor(application, TARGET_UUID)).toBe(reads)
  })

  it('keeps upload quota recount separate from the full measured storage total', async () => {
    const application = makeApplication([null, null, 0])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    await wait(1000)
    expect(storageReadout()).toContain('Current usage: 0 B')
    expect(container.querySelector('[data-test-id="storage-total"]')?.textContent).toBe('Total: 0 B')
  })

  it('stops looking after the window and says so, without claiming the recount ran', async () => {
    // A figure that is already right, or a worker that is not running: the pane
    // cannot tell these apart and must not pretend to.
    const application = makeApplication([5_242_880])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)

    await requestRecount()
    expect(recountStatus()).toBe(
      'Recount requested. The stored usage still reads 5 MB; this panel re-reads it for up to 30 seconds.',
    )
    await wait(WINDOW_MS)

    // One load, one read on the answer, one per gap: then no more.
    const expectedReads = 2 + ADMIN_QUOTA_RECOUNT_REREAD_DELAYS_MS.length
    expect(usageReadsFor(application, TARGET_UUID)).toBe(expectedReads)
    expect(recountStatus()).toBe(
      'Recount requested. 30 seconds later the stored usage still read 5 MB. Either that was already right or the recount has not finished: select this user again to re-read it.',
    )
    await wait(60_000)
    expect(usageReadsFor(application, TARGET_UUID)).toBe(expectedReads)
  })

  it('promises nothing it cannot know in the toast', async () => {
    const application = makeApplication([null])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)

    await requestRecount()

    expect(toastMessages()).toEqual([`Recount requested for ${TARGET_EMAIL}.`])
  })

  it('leaves the next user alone when another user is selected while it is still looking', async () => {
    const application = makeApplication([null])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    expect(recountStatus()).not.toBeNull()
    const targetReads = usageReadsFor(application, TARGET_UUID)

    await renderUser(application, OTHER_UUID, OTHER_EMAIL)
    await wait(WINDOW_MS)

    // No further read for the user who is no longer on the panel, nothing of
    // theirs on it, and no recount line about a recount nobody asked for here.
    expect(usageReadsFor(application, TARGET_UUID)).toBe(targetReads)
    expect(storageReadout()).toContain('Current usage: 777 B')
    expect(recountStatus()).toBeNull()
  })

  it('puts nothing of the first user on the panel when another is selected before the request answers', async () => {
    const application = makeApplication([null])
    let answerRequest: (response: unknown) => void = () => undefined
    application.legacyApi.adminFixUserQuota.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerRequest = resolve
        }),
    )
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    const targetReads = usageReadsFor(application, TARGET_UUID)

    await renderUser(application, OTHER_UUID, OTHER_EMAIL)
    await act(async () => {
      answerRequest({ data: { success: true } })
      await flush()
    })
    await wait(WINDOW_MS)

    // The request WAS accepted, and the toast says for whom.
    expect(toastMessages()).toEqual([`Recount requested for ${TARGET_EMAIL}.`])
    // But the panel is the other user's: their figure, no recount line, and no
    // read of the first user's usage into it.
    expect(storageReadout()).toContain('Current usage: 777 B')
    expect(recountStatus()).toBeNull()
    expect(usageReadsFor(application, TARGET_UUID)).toBe(targetReads)
  })

  it('puts no recount line under the next user when they are selected while the usage is being re-read', async () => {
    const application = makeApplication([null])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    // The read made when the request answers stays in flight until released.
    let answerRead: (response: unknown) => void = () => undefined
    application.legacyApi.adminGetUserFeatureFlags.mockImplementation((userUuid: string) => {
      if (userUuid !== TARGET_UUID) {
        return Promise.resolve(usageAnswer(777))
      }

      return new Promise((resolve) => {
        answerRead = resolve
      })
    })
    await requestRecount()

    await renderUser(application, OTHER_UUID, OTHER_EMAIL)
    await act(async () => {
      answerRead(usageAnswer(null))
      await flush()
    })
    await wait(WINDOW_MS)

    expect(storageReadout()).toContain('Current usage: 777 B')
    expect(recountStatus()).toBeNull()
  })

  it('stops looking when the pane is gone', async () => {
    const application = makeApplication([null])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    const reads = usageReadsFor(application, TARGET_UUID)

    act(() => {
      root.unmount()
    })
    await wait(WINDOW_MS)

    expect(usageReadsFor(application, TARGET_UUID)).toBe(reads)
    // afterEach unmounts again; give it a root to unmount.
    root = createRoot(container)
  })

  it('keeps what the administrator is typing while it re-reads', async () => {
    // A stored 5 GB limit, so the limit box is live and seeded with '5'. A re-read
    // that went through the panel's full load would put that '5' back.
    const application = makeApplication([null, null, 0], 5 * 1_073_741_824)
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    await requestRecount()
    const limit = container.querySelector<HTMLInputElement>('input[placeholder="e.g. 5"]')
    if (!limit) {
      throw new Error('The storage-limit box was not rendered')
    }
    expect(limit.value).toBe('5')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(limit, '12')
    await act(async () => {
      limit.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await wait(1000)

    expect(storageReadout()).toContain('Current usage: 0 B')
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. 5"]')?.value).toBe('12')
  })

  it('says the usage could not be re-read when the read after the request fails', async () => {
    const application = makeApplication([null])
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    application.legacyApi.adminGetUserFeatureFlags.mockImplementation(() =>
      Promise.resolve({ error: { message: 'gateway timeout' }, status: 504 }),
    )

    await requestRecount()

    expect(recountStatus()).toBe(
      'Recount requested, but the usage could not be re-read just now. Select this user again to re-read it.',
    )
    const reads = application.legacyApi.adminGetUserFeatureFlags.mock.calls.length
    await wait(WINDOW_MS)
    expect(application.legacyApi.adminGetUserFeatureFlags.mock.calls.length).toBe(reads)
  })

  it('says only that the request was refused when the server refuses it', async () => {
    const application = makeApplication([null])
    application.legacyApi.adminFixUserQuota.mockResolvedValue({
      error: { message: 'refused' },
      data: { error: { message: 'No user with that uuid.' } },
    })
    await renderUser(application, TARGET_UUID, TARGET_EMAIL)
    const reads = usageReadsFor(application, TARGET_UUID)

    await requestRecount()
    await wait(WINDOW_MS)

    expect(toastMessages()).toEqual(['No user with that uuid.'])
    expect(recountStatus()).toBeNull()
    expect(usageReadsFor(application, TARGET_UUID)).toBe(reads)
  })
})
