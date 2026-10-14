/** @jest-environment jsdom */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import SessionsModal from './SessionsModal'
import type { WebApplication } from '@/Application/WebApplication'
jest.mock('../Modal/ModalOverlay', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
jest.mock('../Modal/Modal', () => ({
  __esModule: true,
  default: ({ children, title }: { children: ReactNode; title: string }) => createElement('div', null, title, children),
}))
jest.mock('../AlertDialog/AlertDialog', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => createElement('div', { role: 'alertdialog' }, children),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('session/device management', () => {
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
  const session = (uuid: string, current = false) => ({
    uuid,
    current,
    device_info: uuid === 'current' ? 'Current browser' : 'Other browser',
    created_at: '2026-01-01',
    updated_at: '2099-01-01',
    api_version: '1',
    last_seen_at: '2026-01-01T00:00:00Z',
    activity_checked_at: '2026-01-01T00:00:30Z',
    active: true,
    devices: [{ device_id: 'hidden-profile', last_seen_at: '2026-01-01T00:00:00Z', active: true }],
  })
  const render = async (revokeSession: jest.Mock) => {
    await act(async () => {
      root.render(
        createElement(SessionsModal, {
          application: {
            getSessions: jest
              .fn()
              .mockResolvedValue({ status: 200, data: [session('current', true), session('other')] }),
            revokeSession,
            closeSessionsModal: () => {},
            isSessionsModalVisible: true,
          } as unknown as WebApplication,
        }),
      )
    })
  }
  const revoke = async () => {
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Revoke')!
        .click(),
    )
    await act(async () =>
      Array.from(container.querySelector('[role=alertdialog]')!.querySelectorAll('button')).at(-1)!.click(),
    )
  }
  it('keeps current-session protection and adopts the authoritative remaining list after confirmed revocation', async () => {
    const revokeSession = jest.fn().mockResolvedValue({ status: 200, data: [session('current', true)] })
    await render(revokeSession)
    expect(container.textContent).toContain('Active recently')
    expect(container.textContent).not.toContain('hidden-profile')
    expect(container.querySelectorAll('button').length).toBe(1)
    await revoke()
    expect(revokeSession).toHaveBeenCalledWith('other')
    expect(container.textContent).not.toContain('Other browser')
    expect(container.textContent).toContain('Current session')
  })
  it('keeps a session revocable after a rejected request without a stuck spinner', async () => {
    await render(jest.fn().mockRejectedValue(new Error('network')))
    await revoke()
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Try again')
    expect(container.textContent).toContain('Other browser')
    const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'Revoke')!
    expect(button.disabled).toBe(false)
  })
})
