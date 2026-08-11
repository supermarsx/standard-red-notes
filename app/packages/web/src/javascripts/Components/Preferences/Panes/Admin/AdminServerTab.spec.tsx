/**
 * @jest-environment jsdom
 *
 * AdminServerTab render guard (MEMORY: verify UI render paths). tsc/jest passing
 * is NOT proof a subtab actually mounts — a whole toolbar group vanished twice in
 * this repo behind a filter. This tab was refactored from one long scroll into a
 * 6-subtab bar (general / registration / health / integrations / email / logging), so we
 * drive the REAL component in jsdom, click every subtab, and assert each subtab
 * label + a piece of its panel content mounts. Two extra tests round-trip the new
 * signup-cap fields and the log-level dropdown through adminSetServerSettings.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring AdminUsersTab.spec).
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

// Drive the log-level Dropdown as a native <select> so its onChange is testable
// in jsdom (the real Ariakit Select relies on layout/portals).
jest.mock('@/Components/Dropdown/Dropdown', () => {
  const { createElement: h } = jest.requireActual('react')
  return {
    __esModule: true,
    default: ({
      label,
      items,
      value,
      onChange,
      disabled,
    }: {
      label: string
      items: { label: string; value: string }[]
      value: string
      onChange: (value: string) => void
      disabled?: boolean
    }) =>
      h(
        'select',
        {
          'aria-label': label,
          value,
          disabled,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        },
        items.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
      ),
  }
})

import AdminServerTab from './AdminServerTab'
import { confirmDialog } from '@standardnotes/ui-services'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mockedConfirmDialog = confirmDialog as jest.MockedFunction<typeof confirmDialog>

const SETTINGS = {
  updateCheck: { url: null },
  plugins: { repoUrl: '', sameOriginRendering: false },
  nextcloudBackups: { enabled: false },
  emailDelivery: {
    host: 'smtp.example.com',
    port: 587,
    username: 'smtp-user',
    passwordConfigured: true,
    from: 'notes@example.com',
    tlsMode: 'starttls' as const,
    configured: true,
  },
  registration: {
    defaultRole: 'CORE_USER',
    domainMode: 'off',
    domainList: [],
    assignableRoles: ['CORE_USER', 'PRO_USER', 'VAULTS_USER'],
    emailConfirmationEnabled: false,
    signupsPerIpMax: 0,
    signupsPerIpWindowHours: 24,
    signupsPerWeekMax: 0,
    signupsPerDeviceMax: 0,
    signupsPerDeviceWindowHours: 24,
    // t69 invite-URL signup control overlay keys.
    inviteOnly: false,
    approvalRequired: false,
    maxTotalAccounts: 0,
    signupsOpenAt: null,
    signupsCloseAt: null,
    invitesPerUser: 0,
  },
  logging: { level: 'info' },
  ocr: { serverEnabled: false, clientEnabled: false },
  workflows: { enabled: false },
}

// t69: sample invite-link + pending-user rows for the data-driven sections.
const SAMPLE_INVITE_LINK = {
  uuid: 'link-uuid-1',
  label: 'Design team',
  maxUses: 2,
  usedCount: 1,
  remainingUses: 1,
  expiresAt: null,
  revoked: false,
  status: 'active' as const,
  defaultRole: null,
  allowedDomain: 'example.com',
  createdAt: '2026-07-01T00:00:00.000Z',
}
const SAMPLE_PENDING_USER = {
  uuid: 'user-uuid-1',
  email: 'pending@example.com',
  createdAt: '2026-07-02T00:00:00.000Z',
}

const makeApplication = (
  options: {
    inviteLinks?: unknown[]
    pendingUsers?: unknown[]
    createdInviteLink?: unknown
  } = {},
) => ({
  legacyApi: {
    adminGetRegistrationFlag: jest.fn().mockResolvedValue({
      data: { registrationDisabled: false, env: { registrationDisabled: null, nextcloudBackupsEnabled: null } },
    }),
    adminGetServerStatus: jest
      .fn()
      .mockResolvedValue({ data: { services: [], masterSwitches: {}, health: {}, network: {} } }),
    adminGetServerSettings: jest.fn().mockResolvedValue({ data: { settings: SETTINGS, sources: {} } }),
    adminListServices: jest.fn().mockResolvedValue({ data: { available: false, programs: [], docker: {} } }),
    adminSetServerSettings: jest.fn().mockResolvedValue({ data: { settings: SETTINGS, sources: {} } }),
    adminTestEmailDelivery: jest.fn().mockResolvedValue({ data: { ok: true } }),
    // t69 invite-link management + approval queue.
    adminListInviteLinks: jest.fn().mockResolvedValue({ data: { inviteLinks: options.inviteLinks ?? [] } }),
    adminCreateInviteLink: jest.fn().mockResolvedValue({
      data: {
        inviteLink: options.createdInviteLink ?? {
          ...SAMPLE_INVITE_LINK,
          uuid: 'link-uuid-new',
          usedCount: 0,
          remainingUses: 2,
          token: 'a'.repeat(64),
          path: `/?invite=${'a'.repeat(64)}`,
        },
      },
    }),
    adminRevokeInviteLink: jest.fn().mockResolvedValue({ data: { success: true, uuid: 'link-uuid-1' } }),
    listPendingUsers: jest
      .fn()
      .mockResolvedValue({ data: { users: options.pendingUsers ?? [], total: (options.pendingUsers ?? []).length } }),
    approveUser: jest.fn().mockResolvedValue({ data: { success: true, userUuid: 'user-uuid-1' } }),
    rejectUser: jest.fn().mockResolvedValue({ data: { success: true, userUuid: 'user-uuid-1' } }),
  },
})

let container: HTMLElement
let root: Root

const flushPromises = async (times = 4) => {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  mockedConfirmDialog.mockClear()
  mockedConfirmDialog.mockResolvedValue(true)
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
      createElement(AdminServerTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
      }),
    )
  })
  // Flush the mount loaders (registration flag / status / settings / services).
  await flushPromises()
}

const buttonWithExactText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as
    HTMLButtonElement | undefined

const tabWithText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => (b.textContent ?? '').includes(text)) as
    HTMLButtonElement | undefined

const clickSubtab = async (label: string) => {
  const tab = tabWithText(label)
  if (!tab) {
    throw new Error(`subtab not found: ${label}`)
  }
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flushPromises()
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const setSelectValue = async (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  await act(async () => {
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('AdminServerTab — 6 subtabs mount with content (vanish guard)', () => {
  it('renders every subtab label', async () => {
    const application = makeApplication()
    await renderTab(application)

    for (const label of [
      'General',
      'Registration & signups',
      'Health & services',
      'Integrations',
      'Email delivery',
      'Logging',
    ]) {
      expect(tabWithText(label)).toBeDefined()
    }
  })

  it('mounts each subtab panel content when its tab is active', async () => {
    const application = makeApplication()
    await renderTab(application)

    // General is the default tab.
    expect(container.textContent).toContain('Feature master switches')
    expect(container.textContent).toContain('Client IP resolution')
    expect(container.textContent).toContain('Update check URL')

    await clickSubtab('Registration & signups')
    expect(container.textContent).toContain('Disable new signups')
    expect(container.textContent).toContain('Signup rate caps')
    expect(container.textContent).toContain('Default role for new users')
    expect(container.textContent).toContain('Per-device (soft)')

    await clickSubtab('Health & services')
    expect(container.textContent).toContain('Server health')

    await clickSubtab('Integrations')
    expect(container.textContent).toContain('OCR (text extraction)')
    expect(container.textContent).toContain('Workflows')

    await clickSubtab('Email delivery')
    expect(container.textContent).toContain('Ready to send')
    expect(container.textContent).toContain('Password: configured (write-only)')
    expect(container.textContent).toContain('Send a test email')

    await clickSubtab('Logging')
    expect(container.textContent).toContain('Log level')
    expect(container.textContent).toContain('takes effect within about 30 seconds')
    expect(container.textContent).toContain('api-gateway')
    expect(container.textContent).toContain('in-process WebSocket gateway')
    expect(container.textContent).toContain('auth')
    expect(container.textContent).toContain('syncing')
    expect(container.textContent).toContain('files')
    expect(container.textContent).toContain('revisions')
    expect(container.textContent).toContain('including their worker processes')
    expect(container.textContent).toContain('home-server')
    expect(container.textContent).not.toContain('until a later release')
  })
})

describe('AdminServerTab — new config forms round-trip a partial PUT', () => {
  it('PUTs registration.signupsPerIpMax from the per-IP cap field', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    // The per-IP max cap field is the first "max" input (placeholder shared by the
    // three cap-max rows); typing here must round-trip as signupsPerIpMax.
    const capInput = container.querySelector<HTMLInputElement>('input[placeholder="0 (unlimited)"]')
    expect(capInput).not.toBeNull()
    await setInputValue(capInput as HTMLInputElement, '5')

    const save = buttonWithExactText('Save')
    expect(save).toBeDefined()
    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      registration: { signupsPerIpMax: 5 },
    })
  })

  it('PUTs logging.level from the log-level dropdown', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Logging')

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Server log level"]')
    expect(select).not.toBeNull()
    await setSelectValue(select as HTMLSelectElement, 'debug')

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({ logging: { level: 'debug' } })
  })
})

// ===== Standard Red Notes: t69 invite-URL signup control admin sections =====

// Find the Ariakit checkbox belonging to the toggle row whose heading matches.
// Scope to the tight toggle row (`.items-center.justify-between`) so the shared
// subtab root — which contains every heading — never causes a false match.
const toggleCheckboxNear = (headingText: string): HTMLInputElement | undefined =>
  Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => {
    const row = input.closest('div.items-center.justify-between')
    return Boolean(row && (row.textContent ?? '').includes(headingText))
  })

const clickButtonExact = async (text: string) => {
  const button = buttonWithExactText(text)
  if (!button) {
    throw new Error(`button not found: ${text}`)
  }
  await act(async () => {
    button.click()
  })
  await flushPromises(8)
}

const clickButtonInRow = async (rowText: string, buttonText: string) => {
  const row = Array.from(container.querySelectorAll('tr')).find((candidate) => {
    return (candidate.textContent ?? '').includes(rowText)
  })
  if (!row) {
    throw new Error(`row not found: ${rowText}`)
  }
  const button = Array.from(row.querySelectorAll('button')).find((candidate) => {
    return (candidate.textContent ?? '').trim() === buttonText
  })
  if (!button) {
    throw new Error(`button not found in row: ${buttonText}`)
  }
  await act(async () => {
    button.click()
  })
  await flushPromises(8)
}

const clickButtonNearInput = async (input: HTMLInputElement, text: string) => {
  let element: HTMLElement | null = input
  while (element && element !== container) {
    const button = Array.from(element.querySelectorAll('button')).find((candidate) => {
      return (candidate.textContent ?? '').trim() === text
    })
    if (button) {
      await act(async () => {
        button.click()
      })
      await flushPromises()
      return
    }
    element = element.parentElement
  }
  throw new Error(`button not found near input: ${text}`)
}

describe('AdminServerTab — invite-URL signup control sections mount (vanish guard)', () => {
  it('renders the invite-only, invite-links, approval-queue and limits sections', async () => {
    const application = makeApplication({ inviteLinks: [SAMPLE_INVITE_LINK], pendingUsers: [SAMPLE_PENDING_USER] })
    await renderTab(application)
    await clickSubtab('Registration & signups')

    // Invite-only + invite links.
    expect(container.textContent).toContain('Invite-only signups')
    expect(container.textContent).toContain('Create an invite link')
    expect(container.textContent).toContain('Existing invite links')
    // Approval queue.
    expect(container.textContent).toContain('Approval queue')
    expect(container.textContent).toContain('Pending approvals')
    // Account limits + signup window (with the server-UTC-now note).
    expect(container.textContent).toContain('Account limits & signup window')
    expect(container.textContent).toContain('Maximum total accounts')
    expect(container.textContent).toContain('Signup window')
    expect(container.textContent).toContain('Invites per user')
    expect(container.textContent).toContain('Current UTC time')
    expect(container.querySelector('input[aria-label="Signup window opens at (UTC)"]')).not.toBeNull()

    // The data rows render.
    expect(container.textContent).toContain('Design team')
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('example.com')
    expect(container.textContent).toContain('pending@example.com')
  })
})

describe('AdminServerTab — invite links create/list/revoke round-trip legacyApi', () => {
  it('creates an invite link and shows the one-time URL', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    await clickButtonExact('Create invite link')

    expect(application.legacyApi.adminCreateInviteLink).toHaveBeenCalledWith({
      maxUses: 1,
      expiresInHours: null,
      label: null,
      defaultRole: null,
      allowedDomain: null,
    })
    // The one-time URL panel shows the absolute invite URL + the "once" warning.
    expect(container.textContent).toContain('shown only once')
    expect(container.textContent).toContain('/?invite=')
  })

  it('revokes an invite link by uuid', async () => {
    const application = makeApplication({ inviteLinks: [SAMPLE_INVITE_LINK] })
    await renderTab(application)
    await clickSubtab('Registration & signups')

    await clickButtonInRow('Design team', 'Revoke')

    expect(mockedConfirmDialog).toHaveBeenCalled()
    expect(application.legacyApi.adminRevokeInviteLink).toHaveBeenCalledWith('link-uuid-1')
  })
})

describe('AdminServerTab — approval queue round-trips legacyApi', () => {
  it('approves and rejects a pending user by uuid', async () => {
    const application = makeApplication({ pendingUsers: [SAMPLE_PENDING_USER] })
    await renderTab(application)
    await clickSubtab('Registration & signups')

    await clickButtonExact('Approve')
    expect(application.legacyApi.approveUser).toHaveBeenCalledWith('user-uuid-1')

    await clickButtonInRow('pending@example.com', 'Reject')
    expect(mockedConfirmDialog).toHaveBeenCalled()
    expect(application.legacyApi.rejectUser).toHaveBeenCalledWith('user-uuid-1')
  })
})

describe('AdminServerTab — invite-URL overlay PUTs fire with the right shapes', () => {
  it('toggles registration.inviteOnly', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    const checkbox = toggleCheckboxNear('Invite-only signups')
    expect(checkbox).toBeDefined()
    await act(async () => {
      ;(checkbox as HTMLInputElement).click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({ registration: { inviteOnly: true } })
  })

  it('PUTs registration.maxTotalAccounts from its field', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    const capInput = container.querySelector<HTMLInputElement>('input[placeholder="0 (no cap)"]')
    expect(capInput).not.toBeNull()
    await setInputValue(capInput as HTMLInputElement, '100')
    await clickButtonNearInput(capInput as HTMLInputElement, 'Save')

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      registration: { maxTotalAccounts: 100 },
    })
  })

  it('PUTs registration.invitesPerUser from its field', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    const input = container.querySelector<HTMLInputElement>('input[placeholder="0 (disabled)"]')
    expect(input).not.toBeNull()
    await setInputValue(input as HTMLInputElement, '5')
    await clickButtonNearInput(input as HTMLInputElement, 'Save')

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      registration: { invitesPerUser: 5 },
    })
  })

  it('PUTs registration.signupsOpenAt as a UTC ISO instant from the datetime picker', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Registration & signups')

    const opensAt = container.querySelector<HTMLInputElement>('input[aria-label="Signup window opens at (UTC)"]')
    expect(opensAt).not.toBeNull()
    await setInputValue(opensAt as HTMLInputElement, '2030-01-01T00:00')

    await clickButtonExact('Save open time')

    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      registration: { signupsOpenAt: '2030-01-01T00:00:00.000Z' },
    })
  })
})
