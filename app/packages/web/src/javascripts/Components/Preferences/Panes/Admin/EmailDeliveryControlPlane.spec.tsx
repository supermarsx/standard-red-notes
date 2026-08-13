/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import EmailDeliveryControlPlane from './EmailDeliveryControlPlane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const relayResponse = {
  relays: [
    {
      id: 'smtp-primary',
      name: 'Primary SMTP',
      kind: 'smtp',
      enabled: true,
      priority: 1,
      from: 'Notes <notes@example.com>',
      rateLimit: { max: 20, windowSeconds: 60 },
      host: 'smtp.example.com',
      port: 587,
      username: 'mailer',
      tlsMode: 'starttls',
      credentialsConfigured: true,
      password: 'server-must-not-return-this',
      recipient: 'private-recipient@example.com',
    },
  ],
  fallbackPolicy: { mode: 'next-enabled' },
  configured: true,
}

const queueItem = {
  id: 'job-1',
  state: 'dead',
  source: 'reminder',
  attempt: 3,
  maxAttempts: 3,
  createdAt: '2026-08-13T10:00:00.000Z',
  nextAttemptAt: '2026-08-13T10:05:00.000Z',
  lastFailureClass: 'authentication',
  recipient: 'queue-private@example.com',
  subject: 'queue private subject',
}

const logItem = {
  id: 'log-1',
  jobId: 'job-1',
  relayId: 'smtp-primary',
  relayKind: 'smtp',
  attempt: 3,
  outcome: 'rejected',
  failureClass: 'authentication',
  providerCode: 'AUTH',
  httpStatus: 401,
  durationMs: 42,
  createdAt: '2026-08-13T10:01:00.000Z',
  body: 'log private body',
  rawProviderResponse: 'raw upstream response',
}

let root: Root
let container: HTMLDivElement
let serverGetJsonRequest: jest.Mock
let serverJsonRequest: jest.Mock
let serverJsonRequestWithMethod: jest.Mock
let onAvailabilityChange: jest.Mock

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const render = async (relayStatus = 200): Promise<void> => {
  serverGetJsonRequest = jest.fn().mockImplementation(async (path: string) => {
    if (path === '/v1/admin/email-delivery/relays') {
      return { status: relayStatus, ok: relayStatus === 200, data: relayStatus === 200 ? relayResponse : {} }
    }
    if (path.startsWith('/v1/admin/email-delivery/queue?')) {
      return {
        status: 200,
        ok: true,
        data: { items: path.includes('state=dead') ? [queueItem] : [] },
      }
    }
    if (path.startsWith('/v1/admin/email-delivery/logs?')) {
      return { status: 200, ok: true, data: { items: [logItem] } }
    }
    throw new Error(`Unexpected GET ${path}`)
  })
  serverJsonRequest = jest.fn().mockResolvedValue({ status: 202, ok: true, data: queueItem })
  serverJsonRequestWithMethod = jest.fn().mockImplementation(async (_path: string, method: string) => {
    return method === 'PUT' ? { status: 200, ok: true, data: relayResponse } : { status: 204, ok: true, data: {} }
  })
  onAvailabilityChange = jest.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(EmailDeliveryControlPlane, {
        application: { serverGetJsonRequest, serverJsonRequest, serverJsonRequestWithMethod } as never,
        noteIfForbidden: jest.fn(),
        onAvailabilityChange,
      }),
    )
  })
  await flush()
}

const click = async (label: string): Promise<void> => {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (entry): entry is HTMLButtonElement => entry.textContent?.trim() === label,
  )

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('renders only redacted relay fields and omits preserved credentials from an ordinary PUT', async () => {
  await render()

  expect(container.textContent).toContain('Primary SMTP')
  expect(container.textContent).toContain('Credentials configured')
  expect(container.textContent).not.toContain('server-must-not-return-this')
  expect(container.textContent).not.toContain('private-recipient@example.com')
  expect(container.querySelector<HTMLInputElement>('#relay-smtp-primary-password')?.value).toBe('')
  expect(onAvailabilityChange).toHaveBeenLastCalledWith('available')

  await click('Save relay profiles')

  const [path, method, body] = serverJsonRequestWithMethod.mock.calls[0]
  expect(path).toBe('/v1/admin/email-delivery/relays')
  expect(method).toBe('PUT')
  expect(body.relays[0]).not.toHaveProperty('password')
  expect(body.relays[0].priority).toBe(1)
})

it('sends null for credentials only after an explicit clear action', async () => {
  await render()

  await click('Clear saved credentials')
  expect(container.textContent).toContain('Credentials will be cleared')
  await click('Save relay profiles')

  expect(serverJsonRequestWithMethod.mock.calls[0][2].relays[0]).toHaveProperty('password', null)
})

it('requires unsaved relay edits to be persisted before testing the stored profile', async () => {
  await render()

  expect(button('Send redacted test')?.disabled).toBe(false)
  const fallback = container.querySelector<HTMLSelectElement>('#email-relay-fallback')
  expect(fallback).not.toBeNull()
  await act(async () => {
    if (fallback) {
      fallback.value = 'none'
      fallback.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await flush()

  expect(container.textContent).toContain('Save relay profile changes before sending a test.')
  expect(button('Send redacted test')?.getAttribute('aria-disabled')).toBe('true')

  await click('Save relay profiles')
  expect(button('Send redacted test')?.getAttribute('aria-disabled')).toBeNull()
})

it('shows queue and log metadata while dropping injected recipient, content, and raw response fields', async () => {
  await render()

  await click('Delivery queue')
  await click('dead1')
  expect(container.textContent).toContain('authentication')
  expect(container.textContent).not.toContain('queue-private@example.com')
  expect(container.textContent).not.toContain('queue private subject')

  await click('Discard')
  await click('Confirm discard')
  expect(serverJsonRequestWithMethod).toHaveBeenCalledWith('/v1/admin/email-delivery/queue/job-1', 'DELETE')

  await click('Redacted logs')
  expect(container.textContent).toContain('AUTH')
  expect(container.textContent).toContain('401')
  expect(container.textContent).not.toContain('log private body')
  expect(container.textContent).not.toContain('raw upstream response')
})

it('keeps legacy SMTP viable when advanced endpoints are not deployed yet', async () => {
  await render(404)

  expect(container.textContent).toContain('Advanced relay management is unavailable on this server')
  expect(container.textContent).toContain('single-SMTP editor is shown below')
  expect(onAvailabilityChange).toHaveBeenLastCalledWith('unavailable')
})
