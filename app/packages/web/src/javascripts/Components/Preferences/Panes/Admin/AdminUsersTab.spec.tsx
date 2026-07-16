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
  // Flush the load effect's Promise.all (flags/ban/suspension/permissions) so
  // flagsLoading clears and the detail sections render.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const buttonWithText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text)) as
    HTMLButtonElement | undefined

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
