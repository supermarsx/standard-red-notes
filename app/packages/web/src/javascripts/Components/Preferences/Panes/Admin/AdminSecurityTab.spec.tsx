/**
 * @jest-environment jsdom
 *
 * AdminSecurityTab render guard (MEMORY: verify UI render paths). This tab was
 * exposes a 4-subtab bar (overview / antiabuse / lockout / auth), with the live
 * anti-abuse controls and locked accounts on dedicated subtabs. We drive the REAL component in jsdom,
 * click every subtab, and assert each subtab label + a piece of its panel content
 * mounts — tsc/jest green is not proof a restructured panel actually renders.
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

import AdminSecurityTab from './AdminSecurityTab'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const websocketTraffic = {
  frameCapacity: 1024,
  frameRefillPerSecond: 256,
  byteCapacity: 33_554_432,
  byteRefillPerSecond: 8_388_608,
  maxQueuedFrames: 64,
  maxQueuedBytes: 16_777_216,
}

const makeApplication = () => ({
  legacyApi: {
    adminGetRegistrationFlag: jest
      .fn()
      .mockResolvedValue({ data: { registrationDisabled: false, env: { registrationDisabled: null } } }),
    adminGetServerStatus: jest.fn().mockResolvedValue({ data: { masterSwitches: {}, health: {} } }),
    adminListUsers: jest.fn().mockResolvedValue({ data: { total: 1 } }),
    adminGetAuditLog: jest.fn().mockResolvedValue({ data: { entries: [] } }),
    adminGetAntiAbuse: jest.fn().mockResolvedValue({
      data: {
        available: true,
        config: {
          enabled: true,
          windowSeconds: 60,
          loginMax: 5,
          registrationMax: 3,
          userWindowSeconds: 60,
          userMax: 0,
          adaptiveEscalation: false,
        },
        ipLists: { allow: [], block: [] },
        websocketTraffic,
        metrics: { tierHits: {}, blockHits: 0, recent: [] },
      },
    }),
    adminGetLockedAccounts: jest.fn().mockResolvedValue({ data: { available: true, accounts: [] } }),
    adminSetServerSettings: jest.fn().mockResolvedValue({ data: { settings: { security: { websocketTraffic } } } }),
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

const goToTab = jest.fn()

const renderTab = async (application: ReturnType<typeof makeApplication>) => {
  await act(async () => {
    root.render(
      createElement(AdminSecurityTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
        goToTab,
      }),
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

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
  await act(async () => {
    await Promise.resolve()
  })
}

const wsInput = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const setNumber = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const clickButton = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label)!
  await act(async () => button.click())
}

describe('WebSocket traffic controls and throttle attribution', () => {
  it('loads all reported rate, burst and queue limits and saves only their security patch', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Anti-abuse & rate limits')
    expect(wsInput('Frame rate (frames/sec)').value).toBe('256')
    expect(wsInput('Frame burst capacity').value).toBe('1024')
    expect(wsInput('Byte rate (bytes/sec)').value).toBe('8388608')
    expect(wsInput('Byte burst capacity').value).toBe('33554432')
    expect(wsInput('Maximum queued frames').value).toBe('64')
    expect(wsInput('Maximum queued bytes').value).toBe('16777216')
    await setNumber(wsInput('Frame burst capacity'), '2048')
    await clickButton('Save WebSocket limits')
    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      security: { websocketTraffic: { ...websocketTraffic, frameCapacity: 2048 } },
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('within five seconds')
  })
  it.each(['', '0', '1.5', '65537'])('refuses invalid burst capacity %s before sending settings', async (value) => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Anti-abuse & rate limits')
    await setNumber(wsInput('Frame burst capacity'), value)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('whole numbers')
    await clickButton('Save WebSocket limits')
    expect(application.legacyApi.adminSetServerSettings).not.toHaveBeenCalled()
  })
  it('resets only WebSocket overrides and applies effective values from the server', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickSubtab('Anti-abuse & rate limits')
    await clickButton('Reset WebSocket overrides')
    expect(application.legacyApi.adminSetServerSettings).toHaveBeenCalledWith({
      security: { websocketTraffic: Object.fromEntries(Object.keys(websocketTraffic).map((key) => [key, null])) },
    })
    expect(wsInput('Maximum queued frames').value).toBe('64')
  })
  it('does not fabricate limits on an older server or claim a rejected write succeeded', async () => {
    const application = makeApplication()
    const reply = await application.legacyApi.adminGetAntiAbuse()
    application.legacyApi.adminGetAntiAbuse.mockResolvedValue({
      ...reply,
      data: { ...reply.data, websocketTraffic: undefined },
    })
    await renderTab(application)
    await clickSubtab('Anti-abuse & rate limits')
    expect(container.textContent).toContain('WebSocket traffic settings were not reported')
    expect(wsInput('Frame burst capacity')).toBeNull()
    application.legacyApi.adminGetAntiAbuse.mockResolvedValue(reply)
    await clickButton('Refresh abuse activity')
    application.legacyApi.adminSetServerSettings.mockResolvedValue({ error: { message: 'Forbidden' }, status: 403 })
    await clickButton('Save WebSocket limits')
    expect(container.textContent).toContain('Could not save the WebSocket traffic limits')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
  it('labels socket rate and queue events THROTTLED separately from actual IP block counts', async () => {
    const application = makeApplication()
    const reply = await application.legacyApi.adminGetAntiAbuse()
    application.legacyApi.adminGetAntiAbuse.mockResolvedValue({
      ...reply,
      data: {
        ...reply.data,
        metrics: {
          blockHits: 3,
          tierHits: { 'websocket-json-ingress': 5, login: 2 },
          recent: [
            {
              at: 1000,
              bucket: 'websocket-json-ingress',
              ip: '198.51.100.2',
              method: 'WS',
              path: '/sockets/sync',
              transport: 'websocket',
              plane: 'json',
              direction: 'ingress',
              reason: 'rate-limited',
            },
          ],
        },
      },
    })
    await renderTab(application)
    await clickSubtab('Anti-abuse & rate limits')
    expect(container.textContent).toContain('WebSocket THROTTLED · websocket-json-ingress: 5')
    expect(container.textContent).toContain('WebSocket THROTTLED · rate-limited · json · ingress')
    expect(container.textContent).toContain('IP blocks: 3')
    expect(container.textContent).not.toContain('BANNED')
  })
})

describe('AdminSecurityTab — 4 subtabs mount with content (vanish guard)', () => {
  it('renders every subtab label', async () => {
    const application = makeApplication()
    await renderTab(application)

    for (const label of ['Overview', 'Anti-abuse & rate limits', 'Account lockout', 'Authentication']) {
      expect(tabWithText(label)).toBeDefined()
    }
  })

  it('mounts each subtab panel content when its tab is active', async () => {
    const application = makeApplication()
    await renderTab(application)

    // Overview is the default tab.
    expect(container.textContent).toContain('Security overview')
    expect(container.textContent).toContain('Sign-up security')
    expect(container.textContent).toContain('Administrator access model')
    expect(container.textContent).toContain('Recent security events')

    await clickSubtab('Anti-abuse & rate limits')
    expect(container.textContent).toContain('Anti-abuse & rate limiting')
    expect(container.textContent).toContain('Rate-limit tiers')
    expect(container.textContent).toContain('Save rate-limit tiers')
    expect(container.textContent).toContain('IP block list')
    expect(container.textContent).toContain('IP allow list')
    expect(container.textContent).toContain('Throttle activity (last 24h)')
    expect(application.legacyApi.adminGetAntiAbuse).toHaveBeenCalled()

    await clickSubtab('Account lockout')
    expect(container.textContent).toContain('Locked accounts')
    expect(container.textContent).toContain('No accounts are currently locked')
    expect(application.legacyApi.adminGetLockedAccounts).toHaveBeenCalled()

    await clickSubtab('Authentication')
    expect(container.textContent).toContain('Two-factor authentication')
    expect(container.textContent).toContain('Sessions & tokens')
    expect(container.textContent).toContain('Configured via the server environment')
  })

  it('renders sensitive-setting and privilege-attribution events in the Recent security events preview', async () => {
    const application = makeApplication()
    application.legacyApi.adminGetAuditLog = jest.fn().mockResolvedValue({
      data: {
        entries: [
          {
            uuid: 'e1',
            actorUuid: 'user-1',
            action: 'credentials.change_failed',
            targetType: 'user',
            targetUuid: 'user-1',
            ip: '198.51.100.7',
            createdAt: '2026-08-01T10:00:00.000Z',
          },
          {
            uuid: 'e2',
            actorUuid: 'user-1',
            action: 'mfa.disabled',
            targetType: 'setting',
            targetUuid: 'user-1',
            ip: null,
            createdAt: '2026-08-01T10:01:00.000Z',
          },
          {
            uuid: 'e3',
            actorUuid: 'admin-1',
            action: 'group.membership_changed',
            targetType: 'user',
            targetUuid: 'user-2',
            ip: null,
            createdAt: '2026-08-01T10:02:00.000Z',
          },
          // Operational noise that must stay out of the security preview.
          {
            uuid: 'e4',
            actorUuid: 'admin-1',
            action: 'quota.recalculated',
            targetType: 'user',
            targetUuid: 'user-2',
            ip: null,
            createdAt: '2026-08-01T10:03:00.000Z',
          },
        ],
      },
    })

    await renderTab(application)

    expect(container.textContent).toContain('credentials.change_failed')
    expect(container.textContent).toContain('mfa.disabled')
    expect(container.textContent).toContain('group.membership_changed')
    expect(container.textContent).not.toContain('quota.recalculated')
    // Attribution is rendered alongside each event, not just the action name.
    expect(container.textContent).toContain('Actor: user-1')
    expect(container.textContent).toContain('from 198.51.100.7')
  })

  it('routes the Recent-events button to the Logs tab (audit folded into Logs)', async () => {
    const application = makeApplication()
    await renderTab(application)

    const openLog = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Open full audit log'),
    )
    expect(openLog).toBeDefined()
    await act(async () => {
      openLog?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(goToTab).toHaveBeenCalledWith('logs')
  })
})
