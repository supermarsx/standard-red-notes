/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import TelegramBridgeSetting from './TelegramBridgeSetting'
import { telegramBridgeRequest } from '@/Assistant/telegramBridge'
import { confirmDialog } from '@standardnotes/ui-services'

jest.mock('@/Assistant/telegramBridge', () => ({ telegramBridgeRequest: jest.fn() }))
jest.mock('@standardnotes/ui-services', () => ({ confirmDialog: jest.fn(async () => true) }))

it('preserves configuration status when clearing the inbox and disconnecting', async () => {
  jest.mocked(confirmDialog).mockResolvedValue(true)
  const application = {
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'alice' }) },
  } as unknown as WebApplication
  jest
    .mocked(telegramBridgeRequest)
    .mockImplementation(async (_app, action) =>
      action === 'inbox' ? { configured: true, linked: true, messages: [{ updateId: 1 }] } : { ok: true },
    )
  const container = document.createElement('div')
  const root = createRoot(container)
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((element) => element.textContent === label)!
  try {
    await act(async () => root.render(<TelegramBridgeSetting application={application} />))
    await act(async () => button('Clear inbox').click())
    expect(container.textContent).toContain('Connected')
    expect(button('Clear inbox').disabled).toBe(true)
    await act(async () => button('Disconnect').click())
    expect(container.textContent).toContain('Not paired')
    expect(container.textContent).not.toContain('Ask your administrator')
  } finally {
    await act(async () => root.unmount())
  }
})

it('pairs explicitly and discards a late pairing response after an account switch', async () => {
  let user = 'alice'
  const application = {
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: user }) },
  } as unknown as WebApplication
  let finishPair!: (value: Record<string, unknown>) => void
  jest.mocked(telegramBridgeRequest).mockImplementation(async (_app, action) =>
    action === 'pair'
      ? new Promise((resolve) => {
          finishPair = resolve
        })
      : { configured: true, linked: false, messages: [] },
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TelegramBridgeSetting application={application} />))
    expect(container.textContent).toContain('Not paired')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Pair bot')!
        .click(),
    )
    user = 'bob'
    await act(async () => root.render(<TelegramBridgeSetting application={application} />))
    await act(async () => finishPair({ code: 'alice-private-code' }))
    expect(container.querySelector('input')).toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Pair bot')!.disabled,
    ).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})
