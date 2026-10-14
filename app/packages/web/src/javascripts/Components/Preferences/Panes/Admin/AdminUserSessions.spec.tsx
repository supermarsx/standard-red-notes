/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import AdminUserSessions from './AdminUserSessions'
jest.mock('@standardnotes/snjs', () => ({ isErrorResponse: (value: { error?: unknown }) => Boolean(value.error) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  jest.useRealTimers()
})
const session = (uuid: string, device: string) => ({
  uuid,
  current: false,
  api_version: '20200115',
  created_at: '2026-10-14T10:00:00Z',
  updated_at: '2026-10-14T17:00:00Z',
  device_info: 'Firefox on Linux',
  last_seen_at: '2026-10-14T12:00:00Z',
  activity_checked_at: '2026-10-14T12:00:00Z',
  active: true,
  devices: [{ device_id: device, last_seen_at: '2026-10-14T12:00:00Z', active: true }],
  refresh_expiration: '2026-11-14T10:00:00Z',
})
const render = async (api: unknown, uuid = 'user-a', forbidden = jest.fn()) => {
  await act(async () => {
    root.render(
      createElement(AdminUserSessions, {
        application: { legacyApi: api } as never,
        userUuid: uuid,
        noteIfForbidden: forbidden,
      }),
    )
    await Promise.resolve()
  })
}
it('shows distinct open sessions and exact device counts with server-clock activity that ages out', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00Z'))
  const api = {
    getAdminUserSessions: jest
      .fn()
      .mockResolvedValue({ data: [session('one', 'device-a'), session('two', 'device-a')] }),
  }
  await render(api)
  expect(api.getAdminUserSessions).toHaveBeenCalledWith('user-a')
  expect(container.textContent).toContain('2 open sessions · 1 observed devices · 1 active recently')
  await act(async () => jest.advanceTimersByTime(150_000))
  expect(container.textContent).toContain('0 active recently')
  expect(container.textContent).toContain('Inactive')
})
it('never displays the previous user response after selection changes', async () => {
  let finish!: (value: unknown) => void
  const api = {
    getAdminUserSessions: jest.fn().mockImplementation((uuid: string) =>
      uuid === 'user-a'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve({ data: [] }),
    ),
  }
  await render(api)
  await render(api, 'user-b')
  await act(async () => {
    finish({ data: [session('old', 'device-old')] })
    await Promise.resolve()
  })
  expect(container.textContent).toContain('No open sessions.')
  expect(container.textContent).not.toContain('Firefox')
})
it('handles authorization denial without exposing old data and allows an explicit refresh', async () => {
  const forbidden = jest.fn()
  const api = {
    getAdminUserSessions: jest
      .fn()
      .mockResolvedValueOnce({ status: 403, error: { message: 'Denied' } })
      .mockResolvedValueOnce({ data: [] }),
  }
  await render(api, 'user-a', forbidden)
  expect(forbidden).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }))
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => {
    container.querySelector('button')!.click()
    await Promise.resolve()
  })
  expect(container.textContent).toContain('No open sessions.')
})

it('keeps each session compact with visible status and collapsed details without identifiers', async () => {
  const first = {
    ...session('opaque-session-token-one', 'opaque-device-identifier-one'),
    current: true,
    ip_address: '192.0.2.10',
  }
  const second = session('opaque-session-token-two', 'opaque-device-identifier-two')
  await render({ getAdminUserSessions: jest.fn().mockResolvedValue({ data: [first, second] }) })
  const details = [...container.querySelectorAll('details')]
  expect(details).toHaveLength(2)
  expect(details.every((element) => !element.open)).toBe(true)
  for (const element of details) {
    const row = element.parentElement!
    expect(row.querySelector('span')?.textContent).toBe('Active recently')
    expect(row.textContent).toContain('Last seen: Just now')
    expect(row.querySelector('[aria-label$="observed profiles"]')?.textContent).toBe('1 profile')
  }
  expect(details[0].querySelector('summary')?.textContent).toContain('Current session')
  expect(details[0].querySelector('summary')?.getAttribute('aria-label')).toBe('Session 1 details: Firefox on Linux')
  expect(details[0].textContent).toContain('Expires:')
  expect(details[0].textContent).toContain('192.0.2.10')
  expect(container.textContent).not.toContain('opaque-session-token')
  expect(container.textContent).not.toContain('opaque-device-identifier')
  expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Refresh sessions'])
})

it('distinguishes missing observations from an observed empty profile list', async () => {
  await render({
    getAdminUserSessions: jest.fn().mockResolvedValue({
      data: [
        { ...session('unreported', 'unused'), devices: undefined, active: undefined, last_seen_at: null },
        { ...session('observed-empty', 'unused'), devices: [] },
      ],
    }),
  })
  const counts = [...container.querySelectorAll('[aria-label$="observed profiles"]')].map(
    (element) => element.textContent,
  )
  expect(counts).toEqual(['Not reported', '0 profiles'])
  expect(container.textContent).toContain('Activity unavailable')
  expect(container.textContent).toContain('Device observations not reported.')
  expect(container.textContent).toContain('No device observations yet.')
})
