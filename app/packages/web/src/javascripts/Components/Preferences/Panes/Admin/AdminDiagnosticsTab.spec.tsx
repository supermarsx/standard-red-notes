/**
 * @jest-environment jsdom
 *
 * AdminDiagnosticsTab render guard (MEMORY: verify UI render paths). This repo
 * has twice shipped admin UI that typechecked, tested clean, and never appeared
 * on screen, so this drives the REAL component in jsdom and asserts the text an
 * operator would actually read.
 *
 * Since the panel became sub-tabbed the render risk got WORSE, not better: an
 * inactive TabPanel returns null, so a section can be perfectly correct and
 * simply never mount. Every section therefore has a test that clicks through to
 * it and asserts content that only that section produces.
 *
 * The UNAVAILABLE path is tested first and in most detail, because it is the
 * state this deployment is actually in.
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
 * this component reads, so the final tests prove the RENDERED page and the
 * COPYABLE REPORT cannot show them even when the server misbehaves and sends them.
 */
const SECRETS = [
  'redis://admin:hunter2@redis.internal.example:6379',
  'syncing.internal.example:50051',
  'super-secret-jwt-signing-key',
  'hunter2',
  'internal.example',
]

/**
 * The live deployment's shape: the lane is UP (the gate no longer hangs the whole
 * transport off the durable backend), SYNC_ITEMS is withheld, and the gRPC URL is
 * set and being ignored because SERVICE_PROXY_TYPE is not "grpc".
 */
const unavailablePayload = {
  capturedAt: '2026-08-26T00:00:00.000Z',
  deployment: {
    recorded: true,
    mode: 'self-hosted',
    serviceProxySetting: 'unset',
    boundServiceProxy: 'http',
    cacheSetting: 'redis',
    syncSwitchSetting: 'unset',
    grpcSyncingProxyBound: false,
    grpcProxyBindableInThisMode: true,
    redisBound: true,
    presence: {
      WEB_SOCKET_CONNECTION_TOKEN_SECRET: true,
      REDIS_URL: true,
      SYNCING_SERVER_GRPC_URL: true,
      AUTH_SERVER_GRPC_URL: true,
      SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: false,
      VALET_TOKEN_SECRET: false,
      AUTH_JWT_SECRET: true,
      SRN_DEPLOY_REVISION: false,
    },
  },
  gate: {
    recorded: true,
    gatewayAttached: true,
    syncLaneEnabled: false,
    syncItemsAdvertised: false,
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
  // The socket-handshake probes must NOT use the RPC-lane helpers: `/v1/sockets/*`
  // is refused on that lane and the refusal is not safe-to-fallback, so those
  // helpers throw when a socket is live. This double answers only the ticket and
  // capability paths, and the tests below pin which helper each probe reaches for.
  httpOnlyJsonRequest: jest.fn().mockImplementation(async (_method: string, path: string) => {
    if (path === '/v1/sockets/sync/ticket') {
      return { status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } }
    }
    return { status: 200, ok: true, data: { capabilities: [] } }
  }),
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

const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

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
  await settle()
  return container.textContent ?? ''
}

const clickButton = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(label))
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

/** Click a sub-tab by its visible label and return the text of the panel it reveals. */
const openSubtab = async (label: string): Promise<string> => {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((element) => element.textContent === label)
  expect(tab).toBeDefined()
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
  const panel = container.querySelector('[role="tabpanel"]')
  expect(panel).not.toBeNull()
  return panel?.textContent ?? ''
}

describe('AdminDiagnosticsTab — the shell', () => {
  it('renders at all — header, chips, controls and every sub-tab control', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Capability diagnostics')
    for (const label of ['Overview', 'Boot gate', 'Capabilities', 'Configuration', 'Checks', 'Copyable report']) {
      expect([...container.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === label)).toBe(true)
    }
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
  })

  it('opens on Overview and mounts exactly one panel at a time', async () => {
    await renderTab(makeApplication())

    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('tab-panel-diag-overview')
  })

  /**
   * The sub-tab ids are prefixed because Tab renders `tab-control-<id>` as a DOM
   * id and this list is nested inside the Admin shell's own tab list. An
   * unprefixed id would collide with a same-named top-level tab and break both.
   */
  it('namespaces its tab control ids so they cannot collide with the Admin shell', async () => {
    await renderTab(makeApplication())

    for (const tab of container.querySelectorAll('[role="tab"]')) {
      expect(tab.id.startsWith('tab-control-diag-')).toBe(true)
    }
  })
})

describe('AdminDiagnosticsTab — Overview', () => {
  it('reports the transport as HTTP and says the socket was never entered', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('The socket lane was never entered')
  })

  it('names the missing configuration item rather than a category', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('SYNCING_SERVER_GRPC_UNBOUND')
    expect(text).toContain('running over HTTP')
  })

  it('reports an unstamped deployment explicitly, and says a rebuild is the only fix', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Unstamped')
    expect(text).toContain('did not record a revision')
    expect(text).toContain('Rebuild required')
    expect(text).toContain('--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)')
    // The specific trap: stamping the running container does nothing.
    expect(text).toContain('does NOT stamp it')
  })

  it('distinguishes a withheld SYNC_ITEMS from a dead lane', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          ...unavailablePayload,
          gate: { ...unavailablePayload.gate, syncLaneEnabled: true, syncItemsAdvertised: false },
          live: { capabilities: [{ id: 'ws-sync' }], unavailabilityReasons: [], ticketAvailable: true },
        },
      }),
    })

    const text = await renderTab(application)

    expect(text).toContain('SYNC_ITEMS is not advertised')
    expect(text).not.toContain('the realtime sync lane is unavailable')
  })
})

describe('AdminDiagnosticsTab — Boot gate and its remedies', () => {
  it('shows the lane, SYNC_ITEMS and ticket verdicts separately', async () => {
    await renderTab(makeApplication())

    const text = await openSubtab('Boot gate')

    expect(text).toContain('Socket transport')
    expect(text).toContain('SYNC_ITEMS')
    expect(text).toContain('Ticket minting')
  })

  /**
   * The whole reason this task exists. The stock advice is "configure
   * SYNCING_SERVER_GRPC_URL"; on this deployment that variable is already SET and
   * is never read, and the thing to change is SERVICE_PROXY_TYPE.
   */
  it('replaces the wrong stock remedy with the topology-conditional one', async () => {
    await renderTab(makeApplication())

    const text = await openSubtab('Boot gate')

    expect(text).toContain('SERVICE_PROXY_TYPE=grpc')
    expect(text).toContain('Config + restart')
    expect(text).toContain('already set')
    expect(text).toContain('would have led nowhere')
    // And it must NOT print the server's misleading sentence.
    expect(text).not.toContain('so realtime commands have a durable backend')
  })

  it('says nothing can be done, rather than naming a variable, in home-server mode', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          ...unavailablePayload,
          deployment: {
            ...unavailablePayload.deployment,
            mode: 'home-server',
            boundServiceProxy: 'direct-call',
            grpcProxyBindableInThisMode: false,
          },
        },
      }),
    })
    await renderTab(application)

    const text = await openSubtab('Boot gate')

    expect(text).toContain('Not fixable here')
    expect(text).toContain('Do not set SYNCING_SERVER_GRPC_URL')
    expect(text).not.toContain('SERVICE_PROXY_TYPE=grpc')
  })

  it('marks the remedy as generic when the server reported no topology', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest
        .fn()
        .mockResolvedValue({ status: 200, ok: true, data: { ...unavailablePayload, deployment: undefined } }),
    })
    await renderTab(application)

    const text = await openSubtab('Boot gate')

    expect(text).toContain('Generic advice')
    expect(text).toContain('may not apply here')
  })
})

describe('AdminDiagnosticsTab — Capabilities', () => {
  /**
   * Asserted against the ROW, not the page text. The Capabilities section has a
   * static paragraph explaining what "Client gap" means, so a `toContain` over
   * the whole page matches that prose and passes no matter what the table says —
   * which is exactly the vacuous assertion this file exists to avoid.
   */
  const capabilityRow = (operation: string): string[] => {
    const row = [...container.querySelectorAll('table tbody tr')].find(
      (element) => element.querySelector('td')?.textContent === operation,
    )
    expect(row).toBeDefined()
    return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent ?? '')
  }

  it('shows FILES_V1 as client-implemented now that downloads consume the lane', async () => {
    await renderTab(makeApplication())
    await openSubtab('Capabilities')

    // This fixture is HTTP-only, so the honest status is the same "Unknown" every
    // implemented-but-unnegotiated operation gets — not "Carries nothing", which
    // would now understate a lane that does carry encrypted file bytes.
    const [operation, server, client, status] = capabilityRow('FILES_V1')
    expect(operation).toBe('FILES_V1')
    expect(server).toBe('yes')
    expect(client).toBe('yes')
    expect(status).toBe('Unknown')
  })

  it('shows an operation both sides implement without calling it broken while HTTP-only', async () => {
    await renderTab(makeApplication())
    await openSubtab('Capabilities')

    const [, server, client, status] = capabilityRow('SYNC_ITEMS')
    expect(server).toBe('yes')
    expect(client).toBe('yes')
    expect(status).toBe('Unknown')
  })

  it('offers a client-update remedy for an operation only the server knows', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          ...unavailablePayload,
          protocol: { version: 1, serverOperations: [...unavailablePayload.protocol.serverOperations, 'FUTURE_LANE'] },
        },
      }),
    })
    await renderTab(application)
    const text = await openSubtab('Capabilities')

    expect(capabilityRow('FUTURE_LANE')[3]).toBe('Client gap')
    expect(text).toContain('Client update')
  })
})

describe('AdminDiagnosticsTab — Configuration', () => {
  it('renders the topology facts and the presence table', async () => {
    await renderTab(makeApplication())

    const text = await openSubtab('Configuration')

    expect(text).toContain('SERVICE_PROXY_TYPE')
    expect(text).toContain('Configuration presence')
    expect(text).toContain('SYNCING_SERVER_GRPC_URL')
  })

  /**
   * Asserted against the ROW. The section's own prose explains what "inert"
   * means, so a page-wide match on the word would pass regardless of the table.
   */
  it('marks the set-but-ignored variable inert in its own row', async () => {
    await renderTab(makeApplication())
    await openSubtab('Configuration')

    const row = [...container.querySelectorAll('table tbody tr')].find(
      (element) => element.querySelector('td')?.textContent === 'SYNCING_SERVER_GRPC_URL',
    )
    const cells = [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent ?? '')
    expect(cells[1]).toBe('set')
    expect(cells[2]).toBe('inert')
    expect(cells[3]).toContain('Set, and NOT read')
  })

  it('says the server does not report presence rather than showing an empty table', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest
        .fn()
        .mockResolvedValue({ status: 200, ok: true, data: { ...unavailablePayload, deployment: undefined } }),
    })
    await renderTab(application)

    const text = await openSubtab('Configuration')

    expect(text).toContain('does not report configuration presence')
    expect(text).toContain('Topology')
  })
})

describe('AdminDiagnosticsTab — Checks', () => {
  it('runs the capability tests and reports the real error from each lane', async () => {
    const application = makeApplication()
    await renderTab(application)

    await clickButton('Test all capabilities')
    const text = await openSubtab('Checks')

    expect(text).toContain('Ticket issuance')
    expect(text).toContain('SYNC_DISABLED')
    expect(text).toContain('Live socket negotiation')
    expect(text).toContain('checks passed')
    // The ticket probe must not reuse the client's real sync device id.
    const ticketCall = application.httpOnlyJsonRequest.mock.calls.find(([, path]) => path === '/v1/sockets/sync/ticket')
    expect(ticketCall?.[2].deviceId).toMatch(/^admin-diagnostic-probe-/)
  })

  /**
   * Regression guard for a false FAILURE that only appears when the deployment is
   * HEALTHY. `/v1/sockets/*` is a forbidden family on the websocket RPC lane, and
   * that refusal arrives as a server ERROR frame, which is not safe-to-fallback —
   * so `serverGetJsonRequest`/`serverJsonRequest` THROW once a socket is live
   * rather than retrying over HTTP. A probe using them would report the socket
   * handshake as broken precisely when it works, which is worse than no panel.
   */
  it('probes the socket handshake over HTTP, never the RPC lane', async () => {
    const application = makeApplication({
      syncTransportStatus: { state: 'READY', operations: ['SYNC_ITEMS', 'API_RPC'] },
    })
    await renderTab(application)
    await clickButton('Test all capabilities')

    for (const path of ['/v1/sockets/sync/capabilities', '/v1/sockets/sync/ticket']) {
      expect(application.httpOnlyJsonRequest.mock.calls.some(([, called]) => called === path)).toBe(true)
    }
    for (const [path] of application.serverGetJsonRequest.mock.calls) {
      expect(path.startsWith('/v1/sockets')).toBe(false)
    }
    for (const [path] of application.serverJsonRequest.mock.calls) {
      expect(path.startsWith('/v1/sockets')).toBe(false)
    }
  })

  it('does not write, invite or delete anything while testing', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickButton('Test all capabilities')

    // Only the single, self-expiring ticket mint may POST, and only to /ticket.
    for (const [method, path] of application.httpOnlyJsonRequest.mock.calls) {
      if (method === 'POST') {
        expect(path).toBe('/v1/sockets/sync/ticket')
      }
    }
    for (const [path] of application.serverGetJsonRequest.mock.calls) {
      expect(path).toBe('/v1/admin/sync-diagnostics')
    }
    expect(application.serverJsonRequest).not.toHaveBeenCalled()
  })
})

describe('AdminDiagnosticsTab — Copyable report', () => {
  const reportText = (): string =>
    (container.querySelector('textarea[aria-label="Diagnostics report"]') as HTMLTextAreaElement | null)?.value ?? ''

  it('renders a report containing the verdict, the gate, the matrix and presence', async () => {
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    const report = reportText()
    expect(report).toContain('# Standard Red Notes — capability diagnostics')
    expect(report).toContain('## Boot gate')
    expect(report).toContain('SYNCING_SERVER_GRPC_UNBOUND')
    expect(report).toContain('| Operation | Server | Client | Negotiated | Status |')
    expect(report).toContain('SYNCING_SERVER_GRPC_URL: set (inert)')
  })

  it('copies it to the clipboard and confirms', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    await clickButton('Copy report')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('## Topology')
    expect(container.textContent).toContain('Copied')
  })
})

describe('AdminDiagnosticsTab — failure and secrecy', () => {
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
    await settle()

    expect(noteIfForbidden).toHaveBeenCalled()
    expect(container.textContent).toContain('403')
  })

  it('renders the healthy path without inventing findings', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          deployment: { ...unavailablePayload.deployment, serviceProxySetting: 'grpc', grpcSyncingProxyBound: true },
          gate: {
            recorded: true,
            gatewayAttached: true,
            syncLaneEnabled: true,
            syncItemsAdvertised: true,
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
    expect(text).toContain('fully configured and available')
    expect(await openSubtab('Boot gate')).toContain('All boot conditions are satisfied')
  })

  /**
   * The security boundary, proved against the rendered DOM AND against the report
   * that is designed to be pasted in public. The server is made to misbehave — it
   * returns configuration VALUES in every string field the component reads — and
   * none of them may reach either.
   */
  it('cannot render or export a secret even when the server sends one', async () => {
    const poisoned = {
      capturedAt: SECRETS[0],
      deployment: {
        ...unavailablePayload.deployment,
        // A server that has started putting values where booleans belong.
        presence: { REDIS_URL: SECRETS[0] as unknown as boolean, SYNCING_SERVER_GRPC_URL: true },
      },
      gate: {
        recorded: true,
        gatewayAttached: true,
        syncLaneEnabled: false,
        syncItemsAdvertised: false,
        unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: `configure REDIS_URL to ${SECRETS[0]}` }],
        unmetCodes: ['REDIS_UNBOUND'],
        files: {
          advertised: false,
          unmetCondition: 'FILES_INTERNAL_URL',
          remedy: `no INTERNAL files service URL is configured (${SECRETS[1]}).`,
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

    await renderTab(application)

    for (const label of ['Overview', 'Boot gate', 'Capabilities', 'Configuration', 'Checks', 'Copyable report']) {
      const text = await openSubtab(label)
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret)
      }
    }

    await openSubtab('Copyable report')
    const report = reportTextValue()
    for (const secret of SECRETS) {
      expect(report).not.toContain(secret)
    }
    expect(report).not.toMatch(/redis:\/\//)
    // The remedy still names the variable, without ever carrying its value.
    expect(report).toContain('REDIS_UNBOUND')
  })

  const reportTextValue = (): string =>
    (container.querySelector('textarea[aria-label="Diagnostics report"]') as HTMLTextAreaElement | null)?.value ?? ''
})
