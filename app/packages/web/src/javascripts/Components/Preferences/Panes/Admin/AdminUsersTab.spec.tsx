/**
 * @jest-environment jsdom
 *
 * AdminUsersTab render guard (MEMORY: verify UI render paths). tsc/jest passing is
 * not proof a section actually mounts — a whole toolbar group vanished twice in
 * this repo behind a filter. So these tests drive the REAL component in jsdom and
 * assert the two new dangerous sections render inside the `user && (...)` block:
 *   - the Suspend section (with a Suspend button),
 *   - the Delete section, whose Delete button stays DISABLED until the admin
 *     types the target's exact email (the type-the-email confirmation gate).
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring TrustedDevices.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

// Treat a response as an error only when it carries an explicit error field.
// `classNames` is re-exported from snjs and used by child components (Dropdown),
// so keep a real implementation — mocking it away breaks the render tree.
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

import AdminUsersTab, { ADMIN_USER_STORAGE_SCOPE } from './AdminUsersTab'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGET_UUID = 'target-user-uuid'
const TARGET_EMAIL = 'target@example.com'

// A DIFFERENT current session user so the self-guard does NOT hide the sections.
const makeApplication = () => ({
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
    adminListUsers: jest.fn().mockResolvedValue({ data: { users: [], total: 0 } }),
    adminGetAvailableRoles: jest.fn().mockResolvedValue({ data: { roleNames: [] } }),
    adminGetUserFeatureFlags: jest.fn().mockResolvedValue({ data: { flags: {}, storage: null } }),
    // Standard Red Notes: the note half of the space report. The default answers
    // a COMPLETE ZERO for every account it is asked about -- what a server holding
    // no items for them really sends -- so the file-half tests below keep testing
    // the file half.
    adminGetUsersItemStorageUsage: jest.fn((userUuids: string[]): Promise<unknown> =>
      Promise.resolve({
        data: {
          usages: userUuids.map((userUuid) => ({
            userUuid,
            itemBytesUsed: 0,
            itemsMeasured: 0,
            itemsUnmeasured: 0,
          })),
        },
      }),
    ),
    adminGetUserUsage: jest.fn().mockResolvedValue({
      data: {
        userUuid: TARGET_UUID,
        source: 'srn-local-metering',
        capturedAt: '2026-08-13T12:00:00.000Z',
        meteringAvailable: true,
        tokenMeasurement: 'provider-reported-or-estimated',
        tokens: {
          fiveHour: { usedTokens: 0, limitTokens: 0, resetsAt: '2026-08-13T12:00:00.000Z' },
          weekly: { usedTokens: 0, limitTokens: 0, resetsAt: '2026-08-13T12:00:00.000Z' },
        },
        history: {
          retentionDays: 7,
          completeLifetimeHistory: false,
          totalEvents: 0,
          truncated: false,
          events: [],
        },
      },
    }),
    adminSetUserFeatureFlag: jest.fn().mockResolvedValue({ data: { success: true } }),
    adminGetUserBanStatus: jest.fn().mockResolvedValue({ data: { banned: false } }),
    adminGetUserSuspensionStatus: jest.fn().mockResolvedValue({ data: { suspended: false } }),
    adminGetUserEffectivePermissions: jest.fn().mockResolvedValue({
      data: { directRoleNames: [], groupRoleNames: [], effectiveRoleNames: [], effectivePermissionNames: [] },
    }),
  },
  sessions: { getUser: () => ({ uuid: 'current-admin-uuid' }) },
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  // jsdom has no matchMedia, and a rendered list row pulls in StyledTooltip ->
  // useMediaQuery. Without this the table render throws rather than failing an
  // assertion, which is how a column defect hides from a render test.
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
})

const renderTab = async (application: ReturnType<typeof makeApplication>) => {
  await act(async () => {
    root.render(
      createElement(AdminUsersTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
        email: TARGET_EMAIL,
        setEmail: jest.fn(),
        user: { uuid: TARGET_UUID, email: TARGET_EMAIL },
        setUser: jest.fn(),
      }),
    )
  })
  // Flush the load effect's Promise.all (flags/usage/ban/suspension/permissions) so
  // flagsLoading clears and the detail sections render.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const buttonWithText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text)) as
    HTMLButtonElement | undefined

// The storage readout and its evidence line, scoped so "contains 0 B" cannot be
// satisfied by some other figure elsewhere on the pane.
const storageReadoutElement = (): Element | null => container.querySelector('[data-test-id="admin-storage-readout"]')
const storageReadout = (): string => storageReadoutElement()?.textContent ?? ''
const storageEvidence = (): string =>
  container.querySelector('[data-test-id="admin-storage-evidence"]')?.textContent ?? ''

/** The storage-limit amount box of the per-user editor. */
const storageLimitInput = (): HTMLInputElement | null => container.querySelector('input[placeholder="e.g. 5"]')

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const aiAccessCheckbox = (): HTMLInputElement => {
  const heading = Array.from(container.querySelectorAll('*')).find(
    (element) => element.children.length === 0 && element.textContent === 'AI access',
  )
  const checkbox = heading?.parentElement?.parentElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!checkbox) {
    throw new Error('AI access switch was not rendered')
  }
  return checkbox
}

describe('AdminUsersTab — Suspend + Delete sections mount and the Delete gate works', () => {
  it('renders the Suspend section with a Suspend button', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(application.legacyApi.adminGetUserSuspensionStatus).toHaveBeenCalledWith(TARGET_EMAIL)
    expect(container.textContent).toContain('Account suspension')
    expect(buttonWithText('Suspend user')).toBeDefined()
  })

  it('renders the Delete section with the Delete button disabled until the exact email is typed', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(container.textContent).toContain('Delete account')

    const deleteButton = buttonWithText('Delete account')
    expect(deleteButton).toBeDefined()
    // Gated: disabled until the confirmation email matches.
    expect(deleteButton?.disabled).toBe(true)

    // Typing a WRONG email keeps it disabled.
    const confirmInput = container.querySelector<HTMLInputElement>(`input[placeholder="${TARGET_EMAIL}"]`)
    expect(confirmInput).not.toBeNull()
    await setInputValue(confirmInput as HTMLInputElement, 'wrong@example.com')
    expect(buttonWithText('Delete account')?.disabled).toBe(true)

    // Typing the EXACT email enables it.
    await setInputValue(confirmInput as HTMLInputElement, TARGET_EMAIL)
    expect(buttonWithText('Delete account')?.disabled).toBe(false)
  })
})

/**
 * N38. One control had four names — "realtime feature flag" in the docs, "Live
 * sync" on this screen, LIVE_SYNC_ENABLED in the settings store and
 * live_sync_enabled in the token — so an admin who read one could not search
 * for any of the others, and a user refused over the socket saw a code that
 * matched nothing they had ever seen.
 */
describe('AdminUsersTab — the live-sync switch is named after the flag it sets', () => {
  it('labels the switch with LIVE_SYNC_ENABLED and names the refusal code it produces', async () => {
    await renderTab(makeApplication())

    expect(container.textContent).toContain('Live sync (LIVE_SYNC_ENABLED)')
    expect(container.textContent).toContain('LIVE_SYNC_DISABLED')
  })
})

describe('AdminUsersTab — durable AI access control', () => {
  it('renders an unset AI gate as effectively enabled', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(aiAccessCheckbox().checked).toBe(true)
  })

  it('locks the switch during persistence and confirms the canonical server readback', async () => {
    let finishWrite: ((value: { data: { success: boolean } }) => void) | undefined
    const pendingWrite = new Promise<{ data: { success: boolean } }>((resolve) => {
      finishWrite = resolve
    })
    const application = makeApplication()
    application.legacyApi.adminSetUserFeatureFlag.mockReturnValueOnce(pendingWrite)
    application.legacyApi.adminGetUserFeatureFlags
      .mockResolvedValueOnce({ data: { flags: {}, storage: null } })
      .mockResolvedValueOnce({ data: { flags: { AI_ENABLED: 'false' }, storage: null } })
    await renderTab(application)

    await act(async () => {
      aiAccessCheckbox().click()
      await Promise.resolve()
    })

    expect(application.legacyApi.adminSetUserFeatureFlag).toHaveBeenCalledWith(TARGET_UUID, 'AI_ENABLED', 'false')
    expect(aiAccessCheckbox().disabled).toBe(true)
    aiAccessCheckbox().click()
    expect(application.legacyApi.adminSetUserFeatureFlag).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishWrite?.({ data: { success: true } })
      await pendingWrite
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledTimes(2)
    expect(aiAccessCheckbox().checked).toBe(false)
    expect(aiAccessCheckbox().disabled).toBe(false)
  })

  it('loads and saves independent per-user token window overrides, with zero clearing to inherit', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: {
        flags: { AI_FIVE_HOUR_TOKEN_LIMIT: '2500', AI_WEEKLY_TOKEN_LIMIT: '12500' },
        storage: null,
      },
    })
    await renderTab(application)

    expect(container.textContent).toContain('Per-user AI token limits')
    expect(container.textContent).toContain('When both request and token limits are configured, both must allow')
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="Inherit"]'))
    expect(inputs).toHaveLength(2)
    expect(inputs[0].value).toBe('2500')
    expect(inputs[1].value).toBe('12500')
    expect(container.textContent).toContain('0 tokens of 2,500 tokens')

    await setInputValue(inputs[0], '0')
    // Editing a draft must not misrepresent it as the effective enforced limit.
    expect(container.textContent).toContain('0 tokens of 2,500 tokens')
    const saveButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Save',
    )
    expect(saveButtons).toHaveLength(2)
    await act(async () => {
      saveButtons[0].click()
      await Promise.resolve()
    })

    expect(application.legacyApi.adminSetUserFeatureFlag).toHaveBeenCalledWith(
      TARGET_UUID,
      'AI_FIVE_HOUR_TOKEN_LIMIT',
      null,
    )
    expect(container.textContent).toContain('0 tokens · unlimited')
  })

  it('ignores a stale quota response after the admin switches users', async () => {
    const application = makeApplication()
    let resolveFirst!: (value: { data: { flags: Record<string, string>; storage: null } }) => void
    let resolveSecond!: (value: { data: { flags: Record<string, string>; storage: null } }) => void
    const first = new Promise<{ data: { flags: Record<string, string>; storage: null } }>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<{ data: { flags: Record<string, string>; storage: null } }>((resolve) => {
      resolveSecond = resolve
    })
    application.legacyApi.adminGetUserFeatureFlags.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const renderUser = async (uuid: string, userEmail: string) => {
      await act(async () => {
        root.render(
          createElement(AdminUsersTab, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            application: application as any,
            noteIfForbidden: jest.fn(),
            email: userEmail,
            setEmail: jest.fn(),
            user: { uuid, email: userEmail },
            setUser: jest.fn(),
          }),
        )
        await Promise.resolve()
      })
    }

    await renderUser('first-user-uuid', 'first@example.com')
    await renderUser('second-user-uuid', 'second@example.com')
    await act(async () => {
      resolveSecond({
        data: {
          flags: { AI_FIVE_HOUR_TOKEN_LIMIT: '300', AI_WEEKLY_TOKEN_LIMIT: '900' },
          storage: null,
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      resolveFirst({
        data: {
          flags: { AI_FIVE_HOUR_TOKEN_LIMIT: '2500', AI_WEEKLY_TOKEN_LIMIT: '12500' },
          storage: null,
        },
      })
      await Promise.resolve()
    })

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="Inherit"]'))
    expect(inputs.map((input) => input.value)).toEqual(['300', '900'])
  })
})

describe('AdminUsersTab — authoritative per-user usage', () => {
  it('renders rolling token limits, retained events, and persisted storage usage/quota', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserUsage.mockResolvedValueOnce({
      data: {
        userUuid: TARGET_UUID,
        source: 'srn-local-metering',
        capturedAt: '2026-08-13T12:00:00.000Z',
        meteringAvailable: true,
        tokenMeasurement: 'provider-reported-or-estimated',
        tokens: {
          fiveHour: { usedTokens: 120, limitTokens: 500, resetsAt: '2026-08-13T16:00:00.000Z' },
          weekly: { usedTokens: 420, limitTokens: 5_000, resetsAt: '2026-08-20T06:00:00.000Z' },
        },
        history: {
          retentionDays: 7,
          completeLifetimeHistory: false,
          totalEvents: 1,
          truncated: false,
          events: [{ occurredAt: '2026-08-13T11:00:00.000Z', tokens: 42 }],
        },
      },
    })
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: {
        flags: { AI_FIVE_HOUR_TOKEN_LIMIT: '300', AI_WEEKLY_TOKEN_LIMIT: '900' },
        storage: { hasSubscription: true, uploadBytesUsed: 2_048, uploadBytesLimit: 4_096 },
      },
    })

    await renderTab(application)

    expect(application.legacyApi.adminGetUserUsage).toHaveBeenCalledWith(TARGET_UUID)
    expect(container.textContent).toContain('AI token usage')
    expect(container.textContent).toContain('120 tokens of 300 tokens')
    expect(container.textContent).toContain('420 tokens of 900 tokens')
    expect(container.textContent).toContain('42 tokens')
    expect(container.textContent).toContain('Only rolling seven-day events are retained')
    // Both storage figures now go through adminHelpers' binary formatter.
    expect(storageReadout()).toContain('2 KB')
    expect(storageReadout()).toContain('4 KB')
  })
})

/**
 * Per-user SERVER storage reporting: absent, zero and failed-to-read must be
 * three visibly different things.
 *
 * FILE_UPLOAD_BYTES_USED is a SUBSCRIPTION setting the auth worker writes only
 * when a FILE_UPLOADED event arrives, so an account whose uploads have never
 * succeeded has no row at all and the admin endpoint answers `null` for it. The
 * limit half has the same shape: `null` means no per-user row, and the plan
 * default that then applies is itself 0 bytes for a plan whose role grants no
 * file-storage permission.
 *
 * The old pane turned four unknowns into one measurement: `storage: null`, a
 * failed read and a never-attempted read were all the value `null`, and `null`
 * printed the limit as the definite allowance 'Unlimited'.
 *
 * The pair that carries the whole point is "absent does NOT render a zero" plus
 * "a genuine zero DOES": either alone passes against a fix that merely relabelled
 * every zero, or against one that merely kept printing zeroes.
 */
describe('AdminUsersTab — per-user storage reporting states', () => {
  it('renders a measured zero AS a zero, and says it was measured', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: 0, uploadBytesLimit: 4_096 } },
    })

    await renderTab(application)

    // Precondition: the read really was attempted for this user.
    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledWith(TARGET_UUID)
    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('0 B')
    expect(storageReadout()).not.toContain('Not reported')
    expect(storageEvidence()).toContain('a measured zero, not a missing figure')
  })

  it('does NOT render an unreported usage as a zero', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: null, uploadBytesLimit: 4_096 } },
    })

    await renderTab(application)

    // Preconditions: the read happened, and it is the ABSENT case that rendered
    // (a reported storage object whose usage figure is null), not a failed one.
    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledWith(TARGET_UUID)
    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('4 KB')
    expect(storageReadout()).not.toContain('could not be read')

    // The defect: this used to be reported as the measurement '0 B'.
    expect(storageReadout()).toContain('Not reported')
    expect(storageReadout()).not.toContain('0 B')
    expect(storageEvidence()).toContain('The server holds no FILE_UPLOAD_BYTES_USED figure for this user')
    expect(storageEvidence()).toContain('NOT a measured zero')
  })

  it('does NOT render an unset limit as an unlimited allowance', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: 2_048, uploadBytesLimit: null } },
    })

    await renderTab(application)

    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('2 KB')
    expect(storageReadout()).toContain('Not set')
    expect(storageReadout()).not.toContain('Unlimited')
    expect(storageEvidence()).toContain('No per-user limit is stored')
  })

  it('reports a FAILED read as a failure with a retry, never as a figure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({
        data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: 1_024, uploadBytesLimit: -1 } },
      })

    await renderTab(application)

    // Precondition: a read was attempted and it is the failed state that rendered.
    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledTimes(1)
    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('could not be read')
    // A failure is not a measurement of any size, and not an allowance either.
    expect(storageReadout()).not.toContain('0 B')
    expect(storageReadout()).not.toContain('Unlimited')
    expect(storageEvidence()).toContain('neither figure above is a measurement')
    expect(consoleError).toHaveBeenCalled()
    // Nothing may be written from an editor that never read the current value.
    expect(buttonWithText('Save storage limit')?.disabled).toBe(true)

    const retry = buttonWithText('Retry storage read')
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledTimes(2)
    expect(storageReadout()).toContain('1 KB')
    expect(storageReadout()).toContain('Unlimited')
    expect(buttonWithText('Retry storage read')).toBeUndefined()
    expect(buttonWithText('Save storage limit')?.disabled).toBe(false)
    consoleError.mockRestore()
  })

  it('reports a server that sent no storage object as reporting nothing, not as unlimited', async () => {
    const application = makeApplication()
    // This is the default stub shape: a 200 whose payload carries storage: null.
    await renderTab(application)

    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledWith(TARGET_UUID)
    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('not reported by this server')
    expect(storageReadout()).not.toContain('Unlimited')
    expect(storageReadout()).not.toContain('0 B')
    expect(storageEvidence()).toContain('This server answered without any storage figures for this user')
    expect(buttonWithText('Save storage limit')?.disabled).toBe(true)
  })

  it('separates a stored limit of zero from an absent one', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: null, uploadBytesLimit: 0 } },
    })

    await renderTab(application)

    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('Not reported')
    expect(storageReadout()).toContain('No allowance (0 B)')
    expect(storageReadout()).not.toContain('Not set')
    expect(storageEvidence()).toContain('refuses every upload')
  })

  it('does not leave one user’s storage figures standing for the next user', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags
      .mockResolvedValueOnce({
        data: {
          flags: {},
          storage: { hasSubscription: true, uploadBytesUsed: 5_242_880, uploadBytesLimit: 2_097_152 },
        },
      })
      .mockRejectedValueOnce(new Error('Network request failed'))

    const renderUser = async (uuid: string, userEmail: string) => {
      await act(async () => {
        root.render(
          createElement(AdminUsersTab, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            application: application as any,
            noteIfForbidden: jest.fn(),
            email: userEmail,
            setEmail: jest.fn(),
            user: { uuid, email: userEmail },
            setUser: jest.fn(),
          }),
        )
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    await renderUser('first-user-uuid', 'first@example.com')
    // Preconditions: the first user's measured figure rendered, and its limit
    // seeded the editor.
    expect(storageReadout()).toContain('5 MB')
    expect(storageLimitInput()?.value).toBe('2')

    // The second user's read FAILS. The old pane kept the previous reading, so
    // one user's measured 5 MB stood as the next user's usage.
    await renderUser('second-user-uuid', 'second@example.com')

    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledTimes(2)
    expect(storageReadoutElement()).not.toBeNull()
    expect(storageReadout()).toContain('could not be read')
    expect(container.textContent).not.toContain('5 MB')
    // Nor may the first user's limit sit in the second user's editor.
    expect(storageLimitInput()?.value).toBe('')
    consoleError.mockRestore()
  })

  it('keeps storage breakdowns in the selected user management section instead of list rows', async () => {
    const application = makeApplication()
    application.legacyApi.adminListUsers.mockResolvedValue({
      data: {
        users: [
          {
            uuid: 'row-zero',
            email: 'zero@example.com',
            roles: [],
            subscription: null,
            banned: false,
            suspended: false,
            mfaEnabled: false,
          },
          {
            uuid: 'row-missing',
            email: 'missing@example.com',
            roles: [],
            subscription: null,
            banned: false,
            suspended: false,
            mfaEnabled: false,
          },
        ],
        total: 2,
      },
    })
    application.legacyApi.adminGetUserStorageUsage.mockImplementation(async (uuid: string) => ({
      data: {
        itemBytesUsed: 0,
        itemsMeasured: 0,
        itemsUnmeasured: 0,
        totalBytesUsed: uuid === 'row-missing' ? null : 0,
        complete: uuid !== 'row-missing',
        components: {
          items: { bytes: 0, count: 0, complete: true },
          files: { bytes: uuid === 'row-missing' ? null : 0, count: 0, complete: uuid !== 'row-missing' },
          revisions: { bytes: 0, count: 0, complete: true },
        },
      },
    }))
    await renderTab(application)
    const table = container.querySelector('table')!
    expect(table.textContent).not.toContain('Space used')
    expect(table.textContent).not.toContain('Total:')
    expect(table.textContent).not.toContain('Uploaded files')
    expect(container.querySelector('[data-test-id="admin-space-readout"]')?.textContent).toContain('Total: 0 B')
    expect(application.legacyApi.adminGetUserStorageUsage).toHaveBeenCalledWith(TARGET_UUID)
    expect(application.legacyApi.adminGetUserStorageUsage).not.toHaveBeenCalledWith('row-zero')
    expect(application.legacyApi.adminGetUserStorageUsage).not.toHaveBeenCalledWith('row-missing')
  })

  // -------------------------------------------------------------------------
  // `hasSubscription: false` — ANSWERED AND DROPPED.
  //
  // Every one of the cases above passes `hasSubscription: true`, and that is
  // exactly why this survived. On the default STANDARD_RED_ENTITLEMENT_MODE=included
  // registration creates no `user_subscriptions` row, so `false` is EVERY account
  // on the deployment this project ships by default. The server answers from the
  // row-less quota scope (the account's own uuid) and the pane threw the figure
  // away: proved live against a single container built from HEAD, where an
  // account with 3 MB uploaded answered {hasSubscription: false,
  // uploadBytesUsed: 3145728} and the panel printed 'not tracked'.
  // -------------------------------------------------------------------------

  it('renders a figure the server reported for an account with NO subscription row', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: false, uploadBytesUsed: 3_145_728, uploadBytesLimit: null } },
    })

    await renderTab(application)

    // Precondition: the read really was attempted and the panel rendered.
    expect(application.legacyApi.adminGetUserFeatureFlags).toHaveBeenCalledWith(TARGET_UUID)
    expect(storageReadoutElement()).not.toBeNull()
    // The figure arrives and is PRINTED, not replaced by a verdict about scope.
    expect(storageReadout()).toContain('3 MB')
    expect(storageReadout()).not.toContain('not tracked')
    // ...and the evidence says where it came from rather than claiming there is
    // nowhere for the server to record it.
    expect(storageEvidence()).toContain('under the account’s own uuid')
    expect(storageEvidence()).not.toContain('nowhere for the server to record')
  })

  it('still refuses to invent a zero for a row-less account with no figure', async () => {
    // The companion to the case above: the fix must not have turned the absent
    // figure into a measurement on its way to being reported.
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: false, uploadBytesUsed: null, uploadBytesLimit: null } },
    })

    await renderTab(application)

    expect(storageReadout()).toContain('Not reported')
    expect(storageReadout()).not.toContain('0 B')
    expect(storageEvidence()).toContain('NOT a measured zero')
  })

  it('reports a row-less account’s EXPLICIT limit instead of overwriting it with Unlimited', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: false, uploadBytesUsed: 1_024, uploadBytesLimit: 4_096 } },
    })

    await renderTab(application)

    // A stored limit binds for a row-less account too — setUserStorageLimit
    // writes it to the same scope and CreateValetToken's free branch reads it.
    expect(storageReadout()).toContain('4 KB')
    expect(storageReadout()).not.toContain('Unlimited')
  })

  it('falls back to Unlimited for a row-less account ONLY when no limit is stored', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: false, uploadBytesUsed: 1_024, uploadBytesLimit: null } },
    })

    await renderTab(application)

    expect(storageReadout()).toContain('Unlimited')
    // ...and the note must not quote the PLAN default, which never applies here.
    expect(storageEvidence()).toContain('minted with an unlimited allowance')
    expect(storageEvidence()).not.toContain('That default is 0 bytes')
  })

  it('still quotes the PLAN default for a SUBSCRIBED account with no stored limit', async () => {
    // The discriminator for the branch above: the two fallbacks are different
    // allowances and must not share a sentence.
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: true, uploadBytesUsed: 1_024, uploadBytesLimit: null } },
    })

    await renderTab(application)

    expect(storageEvidence()).toContain('That default is 0 bytes')
    expect(storageEvidence()).not.toContain('minted with an unlimited allowance')
  })

  it('keeps the storage-limit editor usable for an account with NO subscription row', async () => {
    // It used to be replaced by "the limit cannot be changed here", which was
    // true until `setUserStorageLimit` learned to write to the row-less quota
    // scope. On the default entitlement mode that refusal covered every account,
    // so the pane hid the one control that works.
    const application = makeApplication()
    application.legacyApi.adminGetUserFeatureFlags.mockResolvedValueOnce({
      data: { flags: {}, storage: { hasSubscription: false, uploadBytesUsed: 1_024, uploadBytesLimit: null } },
    })

    await renderTab(application)

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Save storage limit',
    )
    expect(saveButton).toBeDefined()
    expect(saveButton?.disabled).toBe(false)
    // *** PRESENT AND ENABLED IS NOT ENOUGH. *** `Button` spreads its props onto
    // the real `<button>`, so a single `hidden` (or `aria-hidden`) takes the
    // control off the screen while leaving it in the DOM, enabled — and a
    // mutation doing exactly that survived a check that stopped at `disabled`.
    expect(saveButton?.hidden).toBe(false)
    expect(saveButton?.getAttribute('aria-hidden')).toBeNull()
    expect(container.textContent).not.toContain('cannot be changed here')
    // ...and the note that replaces it must state where the limit lives rather
    // than claiming nothing can be done.
    expect(container.textContent).toContain('stored under the account’s own uuid')
  })

  it('states that full storage covers current items, uploaded files and saved revisions', () => {
    expect(ADMIN_USER_STORAGE_SCOPE).toContain('encrypted items')
    expect(ADMIN_USER_STORAGE_SCOPE).toContain('uploaded file data')
    expect(ADMIN_USER_STORAGE_SCOPE).toContain('saved revisions')
    expect(ADMIN_USER_STORAGE_SCOPE).toContain('all components')
    expect(ADMIN_USER_STORAGE_SCOPE).toContain('quota applies only to files')
  })
})
