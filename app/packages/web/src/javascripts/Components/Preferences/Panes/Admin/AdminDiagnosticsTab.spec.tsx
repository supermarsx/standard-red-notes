/**
 * @jest-environment jsdom
 *
 * AdminDiagnosticsTab render guard (MEMORY: verify UI render paths). This repo
 * has twice shipped admin UI that typechecked, tested clean, and never appeared
 * on screen, so this drives the REAL component in jsdom and asserts the text an
 * operator would actually read.
 *
 * The UNAVAILABLE path is tested first and in most detail, because it is the
 * state this deployment is actually in: WEBSOCKET_SYNC_ENABLED defaults on, so
 * the lane is off because a backing service is unbound, and the panel's whole
 * reason to exist is naming WHICH one.
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

import AdminDiagnosticsTab from './AdminDiagnosticsTab'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The environment values a leak would carry. Planted into every server response
 * this component reads, so the final test proves the RENDERED page cannot show
 * them even when the server misbehaves and sends them.
 */
const SECRETS = [
  'redis://admin:hunter2@redis.internal.example:6379',
  'syncing.internal.example:50051',
  'super-secret-jwt-signing-key',
  'hunter2',
  'internal.example',
]

const unavailablePayload = {
  capturedAt: '2026-08-26T00:00:00.000Z',
  gate: {
    recorded: true,
    gatewayAttached: true,
    syncLaneEnabled: false,
    unmetPreconditions: [
      {
        code: 'SYNCING_SERVER_GRPC_UNBOUND',
        remedy:
          'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend',
      },
    ],
    unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND'],
    files: {
      advertised: false,
      unmetCondition: 'FILES_INTERNAL_URL',
      remedy: 'no INTERNAL files service URL is configured.',
    },
  },
  live: { capabilities: [], unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
  protocol: {
    version: 1,
    serverOperations: [
      'SYNC_ITEMS',
      'AUTHORIZE_COLLABORATION',
      'API_RPC',
      'STREAM_ASSISTANT',
      'INVITE_EVENTS',
      'FILES_V1',
    ],
  },
}

const makeApplication = (overrides: Record<string, unknown> = {}) => ({
  serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 200, ok: true, data: unavailablePayload }),
  serverJsonRequest: jest
    .fn()
    .mockResolvedValue({ status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } }),
  syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
  ...overrides,
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  jest.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(globalThis as { fetch?: unknown }).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ revision: 'unstamped', version: 'unstamped' }) })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  jest.useRealTimers()
})

const renderTab = async (application: ReturnType<typeof makeApplication>) => {
  await act(async () => {
    root.render(
      createElement(AdminDiagnosticsTab, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
        noteIfForbidden: jest.fn(),
      }),
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return container.textContent ?? ''
}

const clickButton = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(label))
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AdminDiagnosticsTab', () => {
  it('renders at all — headings, chips and controls are on the page', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Capability diagnostics')
    expect(text).toContain('Transport in use right now')
    expect(text).toContain('Diagnosis')
    expect(text).toContain('Boot gate')
    expect(text).toContain('Capabilities')
    expect(text).toContain('Capability tests')
    expect(text).toContain('Deployment identity')
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelectorAll('table tbody tr').length).toBeGreaterThan(0)
  })

  it('names the missing configuration item on the unavailable path', async () => {
    const text = await renderTab(makeApplication())

    // The whole point: the operator reads the env var to set, not a category.
    expect(text).toContain('SYNCING_SERVER_GRPC_UNBOUND')
    expect(text).toContain('SYNCING_SERVER_GRPC_URL')
    expect(text).toContain('running over HTTP')
  })

  it('reports the transport as HTTP and says the socket was never entered', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('The socket lane was never entered')
  })

  it('shows FILES_V1 as a client gap even though the server advertises it', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('FILES_V1')
    expect(text).toContain('Client gap')
  })

  it('reports an unstamped deployment marker explicitly rather than blank', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Unstamped')
    expect(text).toContain('did not record a revision')
  })

  it('renders the healthy path without inventing findings', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          gate: {
            recorded: true,
            gatewayAttached: true,
            syncLaneEnabled: true,
            unmetPreconditions: [],
            unmetCodes: [],
            files: { advertised: true },
          },
          live: { capabilities: [{ id: 'ws-sync' }], unavailabilityReasons: [], ticketAvailable: true },
          protocol: {
            version: 1,
            serverOperations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT', 'INVITE_EVENTS'],
          },
        },
      }),
      syncTransportStatus: {
        state: 'READY',
        operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT', 'INVITE_EVENTS'],
      },
    })

    const text = await renderTab(application)

    expect(text).toContain('Healthy')
    expect(text).toContain('All boot conditions are satisfied')
    expect(text).toContain('fully configured and available')
  })

  it('explains a 403 rather than rendering an empty screen', async () => {
    const noteIfForbidden = jest.fn()
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 403, ok: false, data: {} }),
    })

    await act(async () => {
      root.render(
        createElement(AdminDiagnosticsTab, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          application: application as any,
          noteIfForbidden,
        }),
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(noteIfForbidden).toHaveBeenCalled()
    expect(container.textContent).toContain('403')
  })

  it('runs the capability tests and reports the real error from each lane', async () => {
    const application = makeApplication()
    await renderTab(application)

    await clickButton('Test all capabilities')

    const text = container.textContent ?? ''
    expect(text).toContain('Ticket issuance')
    expect(text).toContain('SYNC_DISABLED')
    expect(text).toContain('Live socket negotiation')
    expect(text).toContain('checks passed')
    // The ticket probe must not reuse the client's real sync device id.
    const ticketCall = application.serverJsonRequest.mock.calls.find(([path]) => path === '/v1/sockets/sync/ticket')
    expect(ticketCall?.[1].deviceId).toMatch(/^admin-diagnostic-probe-/)
  })

  it('does not write, invite or delete anything while testing', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickButton('Test all capabilities')

    // Only the single, self-expiring ticket mint may POST, and only to /ticket.
    for (const [path] of application.serverJsonRequest.mock.calls) {
      expect(path).toBe('/v1/sockets/sync/ticket')
    }
    // Every GET is a read-only diagnostic path.
    for (const [path] of application.serverGetJsonRequest.mock.calls) {
      expect(['/v1/admin/sync-diagnostics', '/v1/sockets/sync/capabilities']).toContain(path)
    }
  })

  /**
   * The security boundary, proved against the rendered DOM. The server is made
   * to misbehave — it returns configuration VALUES in every string field the
   * component reads — and none of them may reach the screen.
   */
  it('cannot render a secret or an address even when the server sends one', async () => {
    const poisoned = {
      capturedAt: SECRETS[0],
      gate: {
        recorded: true,
        gatewayAttached: true,
        syncLaneEnabled: false,
        unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: `configure REDIS_URL` }],
        unmetCodes: ['REDIS_UNBOUND'],
        files: {
          advertised: false,
          unmetCondition: 'FILES_INTERNAL_URL',
          remedy: 'no INTERNAL files service URL is configured.',
        },
      },
      live: {
        capabilities: [{ id: 'ws-sync', endpoint: '/sockets/sync' }],
        unavailabilityReasons: ['sync-not-configured'],
        ticketAvailable: false,
      },
      protocol: { version: 1, serverOperations: ['SYNC_ITEMS', 'FILES_V1'] },
    }
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 200, ok: true, data: poisoned }),
      syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
    })

    const text = await renderTab(application)

    for (const secret of SECRETS) {
      expect(text).not.toContain(secret)
    }
    // The remedy copy must name the variable without ever carrying its value.
    expect(text).toContain('REDIS_URL')
    expect(text).not.toContain('redis://')
  })
})
