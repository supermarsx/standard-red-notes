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

import AdminUsersTab from './AdminUsersTab'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGET_UUID = 'target-user-uuid'
const TARGET_EMAIL = 'target@example.com'

// A DIFFERENT current session user so the self-guard does NOT hide the sections.
const makeApplication = () => ({
  legacyApi: {
    adminListUsers: jest.fn().mockResolvedValue({ data: { users: [], total: 0 } }),
    adminGetAvailableRoles: jest.fn().mockResolvedValue({ data: { roleNames: [] } }),
    adminGetUserFeatureFlags: jest.fn().mockResolvedValue({ data: { flags: {}, storage: null } }),
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

/** The Storage cell (last column) of the list row whose Email cell is `email`. */
const storageCellForRow = (email: string): string => {
  const row = Array.from(container.querySelectorAll('tbody tr')).find((candidate) =>
    Array.from(candidate.querySelectorAll('td')).some((cell) => cell.textContent === email),
  )
  if (!row) {
    throw new Error(`No list row rendered for ${email}`)
  }
  const cells = Array.from(row.querySelectorAll('td'))
  return cells[cells.length - 1].textContent ?? ''
}

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

  it('distinguishes the two in the users LIST column, in one render', async () => {
    const application = makeApplication()
    const baseRow = {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      roles: [],
      subscription: null,
      banned: false,
      suspended: false,
      mfaEnabled: false,
    }
    application.legacyApi.adminListUsers.mockResolvedValue({
      data: {
        users: [
          {
            ...baseRow,
            uuid: 'row-absent',
            email: 'absent@example.com',
            storageUsedBytes: null,
            storageLimitBytes: null,
          },
          { ...baseRow, uuid: 'row-zero', email: 'zero@example.com', storageUsedBytes: 0, storageLimitBytes: -1 },
        ],
        total: 2,
      },
    })

    await renderTab(application)

    // Precondition: both rows actually rendered.
    expect(application.legacyApi.adminListUsers).toHaveBeenCalled()
    const absentCell = storageCellForRow('absent@example.com')
    const zeroCell = storageCellForRow('zero@example.com')
    expect(absentCell).toBe('Not reported / Not set')
    expect(zeroCell).toBe('0 B / Unlimited')
    // The complaint this column produced: a whole column of 0 B measurements.
    expect(absentCell).not.toContain('0 B')
    expect(absentCell).not.toContain('Unlimited')
    expect(absentCell).not.toBe(zeroCell)
  })
})
