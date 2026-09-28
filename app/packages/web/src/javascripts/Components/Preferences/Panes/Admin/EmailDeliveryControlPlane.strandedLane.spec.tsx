/** @jest-environment jsdom */
/**
 * Joins the two halves of the stranded-lane fix that were otherwise only
 * verified apart: the real `WebApplication.serverGetJsonRequest` (with its
 * websocket-first `controlPlaneRpc`) driving the real pane.
 *
 * The transport half was proven against a live stack and the degradation half
 * against a mocked transport, but nothing until here had watched the PANE
 * recover — and "two correct halves that were never joined" is the exact shape
 * this repo has been bitten by before. Everything below is real except the
 * socket and the network: the component, the helper, the fallback branch and
 * the message mapping are all the shipped code.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import { WebApplication } from '@/Application/WebApplication'

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
    },
  ],
  fallbackPolicy: { mode: 'next-enabled' },
  configured: true,
}

let root: Root
let container: HTMLDivElement

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * A stand-in for the real application object carrying the REAL helper and the
 * REAL private lane off the prototype, exactly as the shipped class wires them.
 */
const applicationWithLane = (
  socketStatus: number,
  httpAnswer: { status: number; body: unknown },
): { application: unknown; openAuthenticatedRpcStream: jest.Mock; fetchMock: jest.Mock } => {
  const openAuthenticatedRpcStream = jest.fn().mockResolvedValue({
    status: socketStatus,
    headers: {},
    body: { error: { tag: 'invalid-auth' } },
    transport: 'websocket',
  })
  const fetchMock = jest.fn().mockResolvedValue({
    ok: httpAnswer.status >= 200 && httpAnswer.status < 300,
    status: httpAnswer.status,
    json: async () => httpAnswer.body,
  } as unknown as Response)
  globalThis.fetch = fetchMock

  const prototype = WebApplication.prototype as unknown as Record<string, unknown>
  const application = {
    _webSocketSyncTransport: { openAuthenticatedRpcStream },
    getHost: { execute: () => ({ getValue: () => 'https://notes.example.test' }) },
    sessions: { getSession: () => ({ accessToken: 'live-session-token' }) },
    controlPlaneRpc: prototype.controlPlaneRpc,
    serverGetJsonRequest: WebApplication.prototype.serverGetJsonRequest,
    serverJsonRequest: jest.fn().mockResolvedValue({ status: 202, ok: true, data: {} }),
    serverJsonRequestWithMethod: jest.fn().mockResolvedValue({ status: 200, ok: true, data: relayResponse }),
  }
  // Bound so the pane's `typeof application.serverGetJsonRequest === 'function'`
  // probe and its later calls both reach the real implementation.
  application.serverGetJsonRequest = WebApplication.prototype.serverGetJsonRequest.bind(
    application as unknown as WebApplication,
  ) as typeof WebApplication.prototype.serverGetJsonRequest

  return { application, openAuthenticatedRpcStream, fetchMock }
}

const render = async (application: unknown): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(EmailDeliveryControlPlane, {
        application: application as never,
        noteIfForbidden: jest.fn(),
        onAvailabilityChange: jest.fn(),
      }),
    )
  })
  await flush()
}

const originalFetch = globalThis.fetch

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  globalThis.fetch = originalFetch
})

it.each([401, 498])(
  'renders the relay editor after the socket lane answers %i, without ever showing the old dead-end error',
  async (socketStatus) => {
    const { application, openAuthenticatedRpcStream, fetchMock } = applicationWithLane(socketStatus, {
      status: 200,
      body: relayResponse,
    })

    await render(application)

    // The pane recovered: the relay actually rendered.
    expect(container.textContent).toContain('Primary SMTP')
    expect(container.textContent).toContain('Delivery configured')
    // And the sentence the user was stuck on is nowhere on the page.
    expect(container.textContent).not.toContain('Check the server logs for the redacted diagnostic')
    expect(container.textContent).not.toContain('Load relay profiles failed')

    // The lane really was tried first, and HTTP really did carry it.
    expect(openAuthenticatedRpcStream).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notes.example.test/v1/admin/email-delivery/relays',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer live-session-token' }) }),
    )
  },
)

it('tells the operator what to do when BOTH lanes refuse the session', async () => {
  const { application } = applicationWithLane(401, { status: 401, body: { error: { tag: 'invalid-auth' } } })

  await render(application)

  expect(container.textContent).toContain('was refused because this session was not accepted')
  expect(container.textContent).toContain('Reload the page')
  expect(container.textContent).not.toContain('Check the server logs for the redacted diagnostic')
})

it('reports a non-admin as a permission problem, not as a failure', async () => {
  const { application, fetchMock } = applicationWithLane(403, {
    status: 403,
    body: { error: { message: 'Admin role required.' } },
  })

  await render(application)

  expect(container.textContent).toContain('You do not have permission to load relay profiles')
  expect(container.textContent).toContain('admin role')
  // A 403 is the lane's own answer and must not be re-asked over HTTP.
  expect(fetchMock).not.toHaveBeenCalled()
})
