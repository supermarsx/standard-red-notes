/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import SessionsAndDevices from './SessionsAndDevices'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('account sessions and devices', () => {
  let container: HTMLElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const render = async (getSessions: jest.Mock, openSessionsModal = jest.fn()) => {
    await act(async () => {
      root.render(
        createElement(SessionsAndDevices, {
          application: { getSessions, openSessionsModal } as unknown as WebApplication,
        }),
      )
    })
  }
  const row = {
    uuid: 'session',
    current: true,
    device_info: 'Firefox on Windows',
    created_at: '2026-01-01',
    updated_at: '2099-01-01',
  }
  it('shows authoritative activity and counts profiles without exposing opaque ids', async () => {
    const openSessionsModal = jest.fn()
    await render(
      jest.fn().mockResolvedValue({
        status: 200,
        data: [
          {
            ...row,
            active: true,
            last_seen_at: '2026-01-01T00:00:00Z',
            activity_checked_at: '2026-01-01T00:00:30Z',
            devices: [{ device_id: 'opaque-hidden-id', active: true, last_seen_at: '2026-01-01T00:00:00Z' }],
          },
        ],
      }),
      openSessionsModal,
    )
    expect(container.textContent).toContain('1 open session')
    expect(container.textContent).toContain('1 observed devices')
    expect(container.textContent).toContain('Active recently')
    expect(container.textContent).toContain('Current session')
    expect(container.textContent).not.toContain('opaque-hidden-id')
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Manage sessions and devices')!
        .click()
    })
    expect(openSessionsModal).toHaveBeenCalledTimes(1)
  })
  it('does not replace missing last seen with updated_at on older servers', async () => {
    await render(jest.fn().mockResolvedValue({ status: 200, data: [row] }))
    expect(container.textContent).toContain('Device activity unavailable')
    expect(container.textContent).toContain('Last seen: Activity unavailable')
    expect(container.textContent).not.toContain('2099')
  })
  it('releases loading state after network rejection and lets the user retry', async () => {
    const getSessions = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 200, data: [] })
    await render(getSessions)
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Try refreshing')
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh')!
    expect(refresh.disabled).toBe(false)
    await act(async () => {
      refresh.click()
    })
    expect(container.textContent).toContain('No open sessions')
    expect(container.querySelector('[role=alert]')).toBeNull()
  })
})
