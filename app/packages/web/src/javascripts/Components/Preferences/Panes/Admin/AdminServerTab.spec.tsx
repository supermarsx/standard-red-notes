/**
 * @jest-environment jsdom
 *
 * AdminServerTab render guard (MEMORY: verify UI render paths). tsc/jest passing
 * is NOT proof a subtab actually mounts — a whole toolbar group vanished twice in
 * this repo behind a filter. This tab was refactored from one long scroll into a
 * 5-subtab bar (general / registration / health / integrations / logging), so we
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
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS = {
  updateCheck: { url: null },
  plugins: { repoUrl: '', sameOriginRendering: false },
  nextcloudBackups: { enabled: false },
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
  },
  logging: { level: 'info' },
  ocr: { serverEnabled: false, clientEnabled: false },
  workflows: { enabled: false },
}

const makeApplication = () => ({
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
  },
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
      createElement(AdminServerTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
      }),
    )
  })
  // Flush the mount loaders (registration flag / status / settings / services).
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const buttonWithExactText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as
    | HTMLButtonElement
    | undefined

const tabWithText = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => (b.textContent ?? '').includes(text)) as
    | HTMLButtonElement
    | undefined

const clickSubtab = async (label: string) => {
  const tab = tabWithText(label)
  if (!tab) {
    throw new Error(`subtab not found: ${label}`)
  }
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
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

describe('AdminServerTab — 5 subtabs mount with content (vanish guard)', () => {
  it('renders every subtab label', async () => {
    const application = makeApplication()
    await renderTab(application)

    for (const label of ['General', 'Registration & signups', 'Health & services', 'Integrations', 'Logging']) {
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

    await clickSubtab('Logging')
    expect(container.textContent).toContain('Log level')
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
