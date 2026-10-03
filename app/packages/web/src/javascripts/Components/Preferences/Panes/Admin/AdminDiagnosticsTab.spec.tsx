/**
 * @jest-environment jsdom
 *
 * AdminDiagnosticsTab render guard (MEMORY: verify UI render paths). This repo
 * has twice shipped admin UI that typechecked, tested clean, and never appeared
 * on screen, so this drives the REAL component in jsdom and asserts the text an
 * operator would actually read.
 *
 * It is also the guard for the defect this integration step closed: five finished
 * section models — WebSocket, Environment & setup, Database & internal comms,
 * Account/space/requirements and Browser — existed in the tree and were called
 * only from their own specs. Nothing rendered them. So every section here is
 * opened by clicking its sub-tab and asserted on content ONLY that section
 * produces, and the panel's own `data-diagnostics-section` attribute is checked
 * too: a tab wired to the wrong builder would otherwise pass every text
 * assertion that happens to be shared copy.
 *
 * Since the panel became sub-tabbed the render risk got WORSE, not better: an
 * inactive TabPanel returns null, so a section can be perfectly correct and
 * simply never mount.
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
  PrefKey: { StorageMaxUsageBytes: 'storageMaxUsageBytes' },
}))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

import AdminDiagnosticsTab, { clockReadingFor, DIAGNOSIS_CHIP_LABEL } from './AdminDiagnosticsTab'
// TONE_CHIP is imported from the module that DEFINES it. It used to be declared
// twice — here and in `diagnosticsPresentation.tsx` — and the tab's copy was
// deleted rather than re-exported: a re-export would leave the tab looking like a
// second source of truth for an exhaustive `Record` over a union that keeps
// gaining members, which is the drift hazard rather than a cure for it.
import { TONE_CHIP } from './diagnosticsPresentation'
import { SYNC_ITEMS_CAUSES, TONES } from './syncDiagnostics'
import { SECTION_IDS, SECTION_TITLE } from './diagnosticsSections'
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

/** The instant the fixture payload says the server captured itself. */
const CAPTURED_AT = '2026-08-26T00:00:00.000Z'

/**
 * The live deployment's shape: the lane is UP (the gate no longer hangs the whole
 * transport off the durable backend), SYNC_ITEMS is withheld, and the gRPC URL is
 * set and being ignored because SERVICE_PROXY_TYPE is not "grpc".
 */
const unavailablePayload = {
  capturedAt: CAPTURED_AT,
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
    // The structured verdict, in the server's own precedence: a lane that did not
    // come up outranks the backend reading, so the cause is the lane's conditions
    // and the server sends no remedy of its own for it.
    syncItems: { state: 'WITHHELD', cause: 'LANE_PRECONDITION_UNMET', remedy: null, probe: 'NEVER_PROBED' },
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

/**
 * The `/v1/admin/server-status` body, as the Database & internal comms section
 * reads it: by allowlist, field by field. `syncing-server` is deliberately
 * unreachable so the section has something of its own to report.
 */
const serverStatusPayload = {
  services: [
    { name: 'api-gateway', status: 'ok', reachable: true, responseTimeMs: 4 },
    { name: 'auth', status: 'ok', reachable: true, responseTimeMs: 9 },
    { name: 'syncing-server', status: 'down', reachable: false },
  ],
  health: { gateway: { redis: true }, auth: { reachable: true, checks: { db: true, redis: true } } },
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
  // The SAME method the Server pane calls, read additively for the Database
  // section. Nothing is migrated out of that pane and no new route exists.
  legacyApi: { adminGetServerStatus: jest.fn().mockResolvedValue({ status: 200, data: serverStatusPayload }) },
  sessions: { isSignedIn: () => true, isSignedIntoFirstPartyServer: () => true },
  featuresController: { isAdminUser: () => true, isEntitledToSharedVaults: () => true },
  subscriptionController: { onlineSubscription: { planName: 'PRO_PLAN', cancelled: false, endsAt: 0 } },
  getPreference: jest.fn().mockReturnValue(0),
  syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
  ...overrides,
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  jest.useFakeTimers()
  // Pinned 30 seconds after the fixture's capture instant, so the Browser
  // section's clock block has a real, bounded offset to report rather than
  // whatever the machine's wall clock happens to be.
  jest.setSystemTime(new Date('2026-08-26T00:00:30.000Z'))
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

const activePanel = (): HTMLElement => {
  const panel = container.querySelector('[role="tabpanel"]')
  expect(panel).not.toBeNull()

  return panel as HTMLElement
}

/** Click a sub-tab by its visible label and return the text of the panel it reveals. */
const openSubtab = async (label: string): Promise<string> => {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((element) => element.textContent === label)
  expect(tab).toBeDefined()
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()

  return activePanel().textContent ?? ''
}

/** Every sub-tab label, so a test can sweep the whole pane. */
const ALL_SUBTABS = [
  'Overview',
  'WebSocket',
  'Environment & setup',
  'Database & internal comms',
  'Account, space & requirements',
  'Browser',
  'Checks',
  'Copyable report',
]

/** The cells of one section row, found by its label, inside the open panel. */
const sectionRow = (label: string): string[] => {
  const row = [...activePanel().querySelectorAll('table tbody tr')].find(
    (element) => element.querySelector('td')?.textContent === label,
  )
  expect(row).toBeDefined()

  return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent ?? '')
}

/** The cells of one Overview router row, found by the section it routes to. */
const routerRow = (section: string): string[] => {
  const row = container.querySelector(`[data-diagnostics-router-row="${section}"]`)
  expect(row).not.toBeNull()

  return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent ?? '')
}

const reportText = (): string =>
  (container.querySelector('textarea[aria-label="Diagnostics report"]') as HTMLTextAreaElement | null)?.value ?? ''

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('AdminDiagnosticsTab — the shell', () => {
  it('renders at all — header, chips, controls and every sub-tab control', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Capability diagnostics')
    for (const label of ALL_SUBTABS) {
      expect([...container.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === label)).toBe(true)
    }
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
  })

  /**
   * The five section tabs are LABELLED from the contract's own `SECTION_TITLE`,
   * so a tab cannot come to disagree with the section it opens — and a sixth
   * section added to `SECTION_IDS` cannot be left off the strip, which is exactly
   * how five finished sections came to be unreachable.
   */
  it('has one tab per section in the contract, labelled from the contract', async () => {
    await renderTab(makeApplication())

    for (const id of SECTION_IDS) {
      const tab = [...container.querySelectorAll('[role="tab"]')].find(
        (element) => element.textContent === SECTION_TITLE[id],
      )
      expect(tab).toBeDefined()
      expect(tab?.id).toBe(`tab-control-diag-${id}`)
    }
  })

  /** The three tabs the section split replaced are gone, not duplicated beside it. */
  it('no longer offers the Boot gate, Capabilities or Configuration tabs', async () => {
    await renderTab(makeApplication())

    const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    for (const gone of ['Boot gate', 'Capabilities', 'Configuration']) {
      expect(labels).not.toContain(gone)
    }
    expect(labels).toHaveLength(ALL_SUBTABS.length)
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

  /**
   * *** THE ICON HAZARD, HELD SHUT. *** An `Icon` whose `type` is missing from
   * `IconNameToSvgMapping.ts` renders its own name as literal text, and tsc and
   * any `Icon`-mocking spec are both blind to it. Nothing in this pane imports
   * `Icon`: not the tab strip, not the router, not the section renderer (whose own
   * spec asserts the same thing). `Spinner` is a styled div, so the whole pane
   * emits no SVG at all and this assertion is exact rather than approximate.
   */
  it('emits no SVG anywhere, on any tab, so an unmapped icon name cannot reach the screen', async () => {
    await renderTab(makeApplication())

    for (const label of ALL_SUBTABS) {
      await openSubtab(label)
      expect(container.querySelectorAll('svg')).toHaveLength(0)
    }
  })
})

/**
 * *** THE OVERVIEW IS A ROUTER. ***
 *
 * One row per section carrying that section's OWN worst verdict. The failure it
 * must never have is a reassuring chip over a section that is broken, so every
 * row's chip is cross-checked against the chip the section's own header renders.
 */
describe('AdminDiagnosticsTab — the Overview router', () => {
  it('lists every section with a verdict and a control that opens it', async () => {
    await renderTab(makeApplication())

    for (const id of SECTION_IDS) {
      expect(routerRow(id)[0]).toBe(SECTION_TITLE[id])
    }
    expect(container.querySelectorAll('[data-diagnostics-router-row]')).toHaveLength(SECTION_IDS.length)
  })

  it('opens the section its row points at, and that panel is the right section', async () => {
    await renderTab(makeApplication())

    const openButtons = [...container.querySelectorAll('[data-diagnostics-router-row="browser"] button')]
    expect(openButtons).toHaveLength(1)
    await act(async () => {
      openButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    expect(activePanel().id).toBe('tab-panel-diag-browser')
    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'browser',
    )
  })

  /**
   * *** THE FALSE GREEN, AT THE ROUTER. *** This payload has an unbuilt socket
   * lane, so the WebSocket section's own worst verdict is "Down". A router that
   * computed its own summary — or was wired to the wrong builder — could show
   * "OK" here while the section one click away says the opposite, which is the
   * specific way this pane has been wrong before.
   */
  it('reports the WebSocket section as down, never as healthy, on an unbuilt lane', async () => {
    await renderTab(makeApplication())

    expect(routerRow('websocket')[1]).toBe('Down')
    expect(routerRow('websocket')[1]).not.toBe('OK')
  })

  it('agrees, verdict for verdict, with the chip each section renders on its own header', async () => {
    await renderTab(makeApplication())

    const fromRouter = SECTION_IDS.map((id) => routerRow(id)[1])

    const fromSections: string[] = []
    for (const id of SECTION_IDS) {
      await openSubtab(SECTION_TITLE[id])
      const header = activePanel().querySelector(`[data-diagnostics-section="${id}"]`)
      expect(header).not.toBeNull()
      // The section header is `<Subtitle>{title}</Subtitle><Chip>…</Chip>`, so the
      // chip is the first span inside the section wrapper's first row.
      fromSections.push(header?.querySelector('span')?.textContent ?? '')
    }

    expect(fromSections).toEqual(fromRouter)
  })

  it('says what an absent verdict means instead of leaving a row that reads like a pass', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 404, ok: false, data: {} }),
      // No transport status either: with one, the HTTP_ONLY reading is a real
      // measurement and the section is honestly "Degraded" rather than unknown.
      syncTransportStatus: undefined,
    })
    await renderTab(application)

    // Nothing was read and nothing measured, so the section established nothing.
    expect(routerRow('websocket')[1]).toBe('Unknown')
    expect(routerRow('websocket')[2]).toContain('NOT the same as everything being fine')
  })

  it('keeps the cross-cutting diagnosis on the Overview, beside the router', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Diagnosis')
    expect(text).toContain('running over HTTP')
    expect(text).toContain('SYNCING_SERVER_GRPC_UNBOUND')
  })

  /** The deployment identity moved to Environment & setup and must not be here twice. */
  it('no longer carries the deployment identity block', async () => {
    await renderTab(makeApplication())
    const overview = await openSubtab('Overview')

    expect(overview).not.toContain('Deployment identity')
  })
})

/**
 * The WebSocket section, which ABSORBED the old Boot gate and Capabilities tabs.
 * Every assertion here was on one of those two tabs before, so a regression in
 * the absorption is a failure rather than a silently thinner pane.
 */
describe('AdminDiagnosticsTab — WebSocket', () => {
  const openWebsocket = async (
    application: ReturnType<typeof makeApplication> = makeApplication(),
  ): Promise<string> => {
    await renderTab(application)

    return openSubtab('WebSocket')
  }

  it('renders the websocket section model, not some other section', async () => {
    await openWebsocket()

    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'websocket',
    )
  })

  it('absorbs the boot gate: the split-gate header, the three verdict rows and the attach outcome', async () => {
    const text = await openWebsocket()

    expect(text).toContain('Socket lane and boot gate')
    expect(text).toContain('THREE of them gate the socket lane')
    expect(text).toContain('withholds SYNC_ITEMS only')
    expect(sectionRow('Socket lane built at boot')[1]).toBe('not built')
    expect(sectionRow('Gateway attached to this process')[1]).toBe('attached')
    expect(sectionRow('Ticket minting right now')[1]).toBe('refusing')
  })

  it('absorbs the capabilities table, with the protocol operations the server reported', async () => {
    const text = await openWebsocket()

    expect(text).toContain('Negotiated capabilities')
    expect(text).toContain('SYNC_ITEMS')
    expect(text).toContain('FILES_V1 sub-gate')
  })

  /**
   * The whole reason this pane exists. The stock advice is "configure
   * SYNCING_SERVER_GRPC_URL"; on this deployment that variable is already SET and
   * is never read, and the thing to change is SERVICE_PROXY_TYPE.
   */
  it('replaces the wrong stock remedy with the topology-conditional one', async () => {
    const text = await openWebsocket()

    // The condition's finding, by its title: a finding's CODE is deliberately
    // report-only — `DiagnosticFinding.code` is the single part of a finding that
    // enters the copyable report, and the screen gets the prose instead.
    expect(text).toContain('A condition that withholds note syncing is unmet')
    expect(text).toContain('SERVICE_PROXY_TYPE=grpc')
    expect(text).toContain('Config + restart')
    expect(text).toContain('already set')
    expect(text).toContain('would have led nowhere')
    // And it must NOT print the server's misleading sentence.
    expect(text).not.toContain('so realtime commands have a durable backend')
  })

  it('says nothing can be done, rather than naming a variable, in home-server mode', async () => {
    const text = await openWebsocket(
      makeApplication({
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
      }),
    )

    expect(text).toContain('Not fixable here')
    expect(text).toContain('Do not set SYNCING_SERVER_GRPC_URL')
    expect(text).not.toContain('SERVICE_PROXY_TYPE=grpc')
  })

  /**
   * *** THE SYNC_ITEMS VERDICT, FROM THE STRUCTURED FIELD ONLY. ***
   *
   * `gate.syncItems` is what the pane reads. `gate.syncItemsAdvertised` is
   * deliberately NOT re-derived from: on builds that sent it, it came from
   * whether a proxy OBJECT had been constructed rather than from the predicate
   * the handshake asks, and it read `true` over sockets that withheld the
   * operation. Here the boolean says `true` and the structured verdict is absent,
   * and the panel must claim nothing.
   */
  it('claims nothing about SYNC_ITEMS from the older advertised boolean', async () => {
    const text = await openWebsocket(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            gate: { ...unavailablePayload.gate, syncItemsAdvertised: true, syncItems: undefined },
          },
        }),
      }),
    )

    expect(text).toContain('SYNC_ITEMS — note syncing over the socket')
    // The third state, in the section's own words — NOT "advertised", which is
    // what re-deriving the row from `gate.syncItemsAdvertised` would have printed.
    expect(sectionRow('SYNC_ITEMS on the socket')[1]).toBe('NOT_OBSERVED')
    expect(sectionRow('SYNC_ITEMS on the socket')[1]).not.toBe('ADVERTISED')
    expect(sectionRow('Server reports the structured verdict')[1]).toBe('no')
    // And no cause is invented for it. Asserted against the row VALUES, not the
    // page text: the block's prose names several causes while explaining what
    // they mean, so a page-wide match would fail on the explanation.
    expect(sectionRow('Why, as the gate names it')[1]).toBe('not reported')
    expect(sectionRow('Handshake predicate reading')[1]).toBe('not reported')
    for (const cause of SYNC_ITEMS_CAUSES) {
      expect(sectionRow('Why, as the gate names it')[1]).not.toBe(cause)
    }
  })

  it('renders the withheld cause and its meaning when the server does report the verdict', async () => {
    const text = await openWebsocket(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            gate: {
              ...unavailablePayload.gate,
              syncLaneEnabled: true,
              unmetPreconditions: [],
              unmetCodes: [],
              syncItems: { state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: null, probe: 'NOT_READY' },
            },
            live: { capabilities: [{ id: 'ws-sync' }], unavailabilityReasons: [], ticketAvailable: true },
          },
        }),
      }),
    )

    expect(text).toContain('DURABLE_BACKEND_NOT_READY')
    expect(sectionRow('Unmet boot conditions')[1]).toBe('0')
  })

  /**
   * *** TWO BLOCKS WITH NO PRODUCER. *** Nothing in this build fills the gateway
   * counters or the lane-degradation ledger — the ledger module does not exist —
   * so both must render their own empty notes. A `{}` or a zeroed object passed
   * from the tab would turn "nobody asked" into "the gateway reported none",
   * which is the precise defect this pane spent the night removing.
   */
  it('renders the unproduced counter and ledger blocks as empty notes, never as zeros', async () => {
    const text = await openWebsocket()

    expect(text).toContain('Gateway admission and traffic')
    expect(text).toContain('Nothing populates these yet')
    expect(text).toContain('Lane degradation ledger')
    expect(text).toContain('This client build records no lane-degradation ledger')
    expect(text).toContain('absence of evidence, not evidence of none')
    expect(sectionRow('Sockets the gateway holds now')[1]).toBe('not reported')
    expect(sectionRow('This client’s origin admitted')[1]).toBe('not reported')
  })

  it('renders every realtime health row the gateway reported', async () => {
    const text = await openWebsocket(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            live: {
              ...unavailablePayload.live,
              realtime: {
                attached: true,
                pushBridge: 'redis',
                pushBridgeReady: true,
                sqsConsumerRunning: true,
                collaborationRelayHealthy: true,
                syncLane: 'up',
                pushesDispatched: 7,
              },
            },
          },
        }),
      }),
    )

    expect(text).toContain('Realtime health')
    expect(text).toContain('redis')
  })
})

/**
 * Environment & setup, which replaced the old Configuration tab and took the
 * deployment identity out of the Overview.
 */
describe('AdminDiagnosticsTab — Environment & setup', () => {
  const openEnvironment = async (
    application: ReturnType<typeof makeApplication> = makeApplication(),
  ): Promise<string> => {
    await renderTab(application)

    return openSubtab('Environment & setup')
  }

  it('renders the environment section model, not some other section', async () => {
    await openEnvironment()

    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'environment',
    )
  })

  it('renders the deployment shape and the configuration presence groups', async () => {
    const text = await openEnvironment()

    expect(text).toContain('Deployment shape')
    // The presence groups, by their own block headings. "Configuration presence"
    // is the heading of the EMPTY case only — a server that reports no presence
    // at all — and asserting it here would pass on exactly the payload this test
    // is supposed to distinguish.
    for (const heading of ['Realtime transport', 'Shared state', 'Durable backend configuration', 'Files lane']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('SYNCING_SERVER_GRPC_URL')
  })

  /**
   * Asserted against the ROW. The section's own prose explains what "inert"
   * means, so a page-wide match on the word would pass regardless of the table.
   */
  it('marks the set-but-ignored variable inert in its own row', async () => {
    await openEnvironment()

    const cells = sectionRow('SYNCING_SERVER_GRPC_URL')
    expect(cells[1]).toBe('set (never read here)')
    expect(cells[3]).toContain('Set, and NOT read')
  })

  /** The identity block, with the rebuild instruction that actually publishes it. */
  it('owns the deployment identity, and gives the rebuild instruction that works', async () => {
    const text = await openEnvironment()

    expect(text).toContain('Deployment identity')
    expect(text).toContain('publishes no usable build identity')
    expect(text).toContain('Rebuild required')
    // t108: the instruction has to be the one that actually publishes the
    // identity. A `--build-arg` alone bakes the marker and then starts a
    // container with no runtime value to match it against, which publishes
    // {null, null} — indistinguishable from the image just rebuilt to fix it.
    expect(text).toContain('SRN_DEPLOY_REVISION=$(git rev-parse HEAD) docker compose up -d --build')
    expect(text).not.toContain('--build-arg SRN_DEPLOY_REVISION')
    // The specific trap: stamping the running container does nothing.
    expect(text).toContain('does NOT stamp it')
  })

  /**
   * *** `payload.transportFallback` IS ON THE WIRE AND IS THREADED. ***
   *
   * The counters are the only place a gateway that bound gRPC and is serving
   * every call over HTTP appears at all — the boot-time topology reads `grpc`
   * forever. An unthreaded field would leave these rows reading "not reported"
   * on a deployment that is reporting, which is the scar `environmentSection.ts`
   * records in its own header.
   */
  it('threads the per-call gRPC fallback counters off the payload', async () => {
    await openEnvironment(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            transportFallback: {
              observed: true,
              everDegraded: true,
              lanes: {
                'items-sync': {
                  degradedCalls: 3,
                  refusedCalls: 1,
                  lastFailureClass: 'channel-unavailable',
                  lastFailureAgeMs: 5000,
                },
              },
            },
          },
        }),
      }),
    )

    expect(sectionRow('Calls served over HTTP instead of gRPC')[1]).toBe('3')
    expect(sectionRow('Calls refused rather than retried')[1]).toBe('1')
    expect(sectionRow('Lane of the most recent gRPC failure')[1]).toBe('items-sync')
    expect(activePanel().textContent).toContain('Calls failed rather than being retried on HTTP')
  })

  /** ABSENT IS NOT ZERO. A server too old to send the ledger reports nothing. */
  it('reads the same counters as "not reported" when the server sends no ledger', async () => {
    await openEnvironment()

    expect(sectionRow('Calls served over HTTP instead of gRPC')[1]).toBe('not reported')
    expect(sectionRow('Calls refused rather than retried')[1]).toBe('not reported')
    expect(activePanel().textContent).not.toContain('Calls failed rather than being retried on HTTP')
  })

  /** No producer exists for the runtime view, and its rows must say so. */
  it('reports the unproduced runtime facts as not reported', async () => {
    await openEnvironment()

    expect(sectionRow('Why this transport was chosen')[1]).toBe('not reported')
  })

  it('says the server does not report presence rather than showing an empty table', async () => {
    const text = await openEnvironment(
      makeApplication({
        serverGetJsonRequest: jest
          .fn()
          .mockResolvedValue({ status: 200, ok: true, data: { ...unavailablePayload, deployment: undefined } }),
      }),
    )

    expect(text).toContain('reports no configuration presence at all')
  })
})

/**
 * Database & internal comms, which reads the `/v1/admin/server-status` payload —
 * the same endpoint and the same client method the Server pane uses, read
 * additively and interpreted by allowlist.
 */
describe('AdminDiagnosticsTab — Database & internal comms', () => {
  const openBackend = async (application: ReturnType<typeof makeApplication> = makeApplication()): Promise<string> => {
    await renderTab(application)

    return openSubtab('Database & internal comms')
  }

  it('renders the backend section model, not some other section', async () => {
    await openBackend()

    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'backend',
    )
  })

  it('reads the admin status payload and says so, with the blocks it feeds', async () => {
    const text = await openBackend()

    expect(sectionRow('Admin status endpoint')[1]).toBe('answered')
    expect(sectionRow('Why the read failed')[1]).toBe('not reported')
    for (const heading of ['Durable storage', 'Shared cache', 'Internal service communication', 'Event delivery']) {
      expect(text).toContain(heading)
    }
  })

  it('calls the same endpoint the Server pane calls, exactly once, and adds no route of its own', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(application.legacyApi.adminGetServerStatus).toHaveBeenCalledTimes(1)
    for (const [path] of application.serverGetJsonRequest.mock.calls) {
      expect(path).toBe('/v1/admin/sync-diagnostics')
    }
  })

  /**
   * A refused read is reported as "did not answer" plus a closed code — never as
   * a database, cache or service that answered badly. Those are materially
   * different claims, and conflating them is how one 401 once produced a report
   * that appeared to say the server had refused every capability.
   */
  it('reports a refused status read as a read failure, not as a broken backend', async () => {
    const text = await openBackend(
      makeApplication({
        legacyApi: {
          adminGetServerStatus: jest.fn().mockResolvedValue({ status: 403, error: { message: 'forbidden' }, data: {} }),
        },
      }),
    )

    expect(sectionRow('Admin status endpoint')[1]).toBe('did not answer')
    expect(sectionRow('Why the read failed')[1]).toBe('forbidden')
    expect(text).toContain('The admin status endpoint could not be read')
  })

  it('reports an unreachable endpoint as unreachable rather than as a refusal', async () => {
    await openBackend(
      makeApplication({
        legacyApi: { adminGetServerStatus: jest.fn().mockRejectedValue(new Error('boom')) },
      }),
    )

    expect(sectionRow('Why the read failed')[1]).toBe('unreachable')
  })
})

/** Account, space & requirements, which reads what this client knows about itself. */
describe('AdminDiagnosticsTab — Account, space & requirements', () => {
  const openAccount = async (application: ReturnType<typeof makeApplication> = makeApplication()): Promise<string> => {
    await renderTab(application)

    return openSubtab('Account, space & requirements')
  }

  it('renders the account section model, not some other section', async () => {
    await openAccount()

    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'account',
    )
  })

  it('threads the observations this client actually holds', async () => {
    const text = await openAccount()

    expect(sectionRow('Signed in')[1]).toBe('signed in')
    expect(sectionRow('First-party server')[1]).toBe('yes')
    expect(sectionRow('Admin role, as this client sees it')[1]).toBe('believed held')
    expect(text).toContain('Account and access')
    expect(text).toContain('Space')
  })

  /**
   * *** THE PANE'S OWN ADMIN REQUEST IS THE ROLE PROBE. *** A payload that
   * arrived is the server confirming the role; a 403 is the server refusing it.
   * Defaulting `payloadRead` to a constant would make one of the two a lie.
   */
  it('reports the admin role as confirmed when the admin endpoint answered', async () => {
    await openAccount()

    expect(sectionRow('Admin role, as the server answered')[1]).toBe('confirmed by the server')
  })

  it('reports a 403 as the role being refused, and names the session cause', async () => {
    const text = await openAccount(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 403, ok: false, data: {} }),
      }),
    )

    expect(sectionRow('Admin role, as the server answered')[1]).toBe('refused by the server (403)')
    expect(text).toContain('This session does not carry the admin role')
  })

  it('reports a 401 as not establishing the role at all, rather than as a refusal', async () => {
    const text = await openAccount(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 401, ok: false, data: {} }),
      }),
    )

    expect(sectionRow('Admin role, as the server answered')[1]).toContain('not authenticated (401)')
    expect(text).not.toContain('This session does not carry the admin role')
  })

  /**
   * The fields with no client surface. Each reads "not reported" and the row says
   * what it is waiting for; none of them is defaulted to a `false` or a zero.
   */
  it('reports the facts no client surface exposes as not reported', async () => {
    await openAccount()

    expect(sectionRow('Roles outside this build’s taxonomy')[1]).toBe('not reported')
    expect(sectionRow('Time until the subscription ends')[1]).toBe('not reported')
  })

  it('reports a controller that cannot be read as nothing, rather than taking the pane down', async () => {
    const text = await openAccount(
      makeApplication({
        sessions: {
          isSignedIn: () => {
            throw new Error('deinitialised')
          },
          isSignedIntoFirstPartyServer: () => {
            throw new Error('deinitialised')
          },
        },
      }),
    )

    expect(text).toContain('Account and access')
    expect(sectionRow('Signed in')[1]).toBe('not reported')
  })
})

/**
 * The Browser section: the only one whose facts come from the device rather than
 * the server, and the only one that needs an injected runtime.
 */
describe('AdminDiagnosticsTab — Browser', () => {
  const openBrowser = async (application: ReturnType<typeof makeApplication> = makeApplication()): Promise<string> => {
    await renderTab(application)

    return openSubtab('Browser')
  }

  it('renders the browser section model, not some other section', async () => {
    await openBrowser()

    expect(activePanel().querySelector('[data-diagnostics-section]')?.getAttribute('data-diagnostics-section')).toBe(
      'browser',
    )
  })

  /**
   * The collection run reaches the screen. jsdom has no `crypto.subtle`, so the
   * crypto probes read "unavailable" here rather than "ok" — which is the honest
   * answer for this environment and still proves the runtime was injected and
   * the observations threaded: an unwired collector leaves `Secure context`
   * reading "not reported" instead of a measured value.
   */
  it('injects a runtime, collects observations and renders them', async () => {
    const text = await openBrowser()

    expect(text).toContain('Hard requirements')
    expect(text).toContain('Storage')
    // Facts only a real runtime can supply. `isSecureContext` is absent in this
    // jsdom and its row reads "not reported", which is the honest answer and the
    // reason these three — a scheme, an origin class and a completed probe — are
    // the ones asserted.
    expect(sectionRow('Page scheme')[1]).toBe('http:')
    expect(sectionRow('Loopback origin')[1]).toBe('yes')
    expect(sectionRow('Secure random generation')[1]).toBe('ok')
  })

  /**
   * *** BOTH HALVES OF THE CLOCK, OR NEITHER. *** The offset is measured between
   * the server's own capture instant and the local instant that payload ARRIVED.
   * The fixture is pinned 30 seconds after the capture, so this row is a real
   * measurement rather than whatever the machine's clock says.
   */
  it('reports the clock offset from the two instants it actually has', async () => {
    await openBrowser()

    expect(sectionRow('Offset from the server clock')[1]).toBe('30s ahead of the server')
  })

  /**
   * *** ABSENT IS NOT ZERO, AT THE WORST POSSIBLE PLACE. *** With no `capturedAt`
   * there is no server instant, and a `0` or a second `Date.now()` in its place
   * would read as a 56-year skew or as perfect alignment. Neither was measured,
   * so the row reads "not reported" and no skew finding is raised.
   */
  it('reports no clock offset at all when the server sent no capture instant', async () => {
    const text = await openBrowser(
      makeApplication({
        serverGetJsonRequest: jest
          .fn()
          .mockResolvedValue({ status: 200, ok: true, data: { ...unavailablePayload, capturedAt: undefined } }),
      }),
    )

    expect(sectionRow('Offset from the server clock')[1]).toBe('not reported')
    expect(text).not.toContain('clock disagrees with the server')
  })

  it('reports a real skew as a finding when the two clocks disagree', async () => {
    jest.setSystemTime(new Date('2026-08-26T00:10:00.000Z'))
    const text = await openBrowser()

    expect(text).toContain('clock disagrees with the server')
    expect(sectionRow('Offset from the server clock')[1]).toContain('10m')
  })
})

/** `clockReadingFor` on its own: the one place a fabricated reading could enter. */
describe('clockReadingFor', () => {
  it('pairs a parsed server instant with the local arrival instant', () => {
    expect(clockReadingFor('2026-08-26T00:00:00.000Z', 1000)).toEqual({
      serverCapturedAtMs: Date.parse('2026-08-26T00:00:00.000Z'),
      localReceivedAtMs: 1000,
    })
  })

  it('reports nothing — never a zero — for an absent or unparseable instant', () => {
    expect(clockReadingFor(undefined, 1000)).toBeUndefined()
    expect(clockReadingFor('not a date', 1000)).toBeUndefined()
    expect(clockReadingFor(SECRETS[0], 1000)).toBeUndefined()
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

  /**
   * *** ONE PLACE TO PRESS THE BUTTON, ONE PLACE TO CONSENT. ***
   *
   * One of these probes mints a real server-side ticket. The paragraph saying so
   * must appear exactly once in the whole pane — a warning repeated on six tabs
   * is a warning nobody reads — and the sections show the results read-only.
   */
  it('keeps the probe consent paragraph on exactly one tab', async () => {
    await renderTab(makeApplication())
    await clickButton('Test all capabilities')

    let seen = 0
    for (const label of ALL_SUBTABS) {
      seen += occurrences(await openSubtab(label), 'mints a short-lived, single-use ticket')
    }

    expect(seen).toBe(1)
  })

  it('shows each probe result inside the section it belongs to, read-only', async () => {
    await renderTab(makeApplication())
    await clickButton('Test all capabilities')

    const websocket = await openSubtab('WebSocket')
    expect(websocket).toContain('Ticket issuance')
    expect(websocket).toContain('Results from the last run on the Checks sub-tab')
    expect([...activePanel().querySelectorAll('button')]).toHaveLength(0)

    const environment = await openSubtab('Environment & setup')
    expect(environment).toContain('Deployment marker')
    expect(environment).not.toContain('Ticket issuance')

    // A section nothing was tagged for shows no check block at all.
    const browser = await openSubtab('Browser')
    expect(browser).not.toContain('Results from the last run on the Checks sub-tab')
  })
})

describe('AdminDiagnosticsTab — Copyable report', () => {
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

  /**
   * *** ALL FIVE SECTIONS, OR THE REPORT IS A REGRESSION. *** The user asked for
   * a pasteable report early in this project. A report that silently omits a
   * section is worse than no report: the reader cannot tell an omitted section
   * from one that had nothing to say.
   */
  it('covers every section in the contract, each with its own worst verdict', async () => {
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    const report = reportText()
    for (const id of SECTION_IDS) {
      expect(report).toContain(`## ${SECTION_TITLE[id]}`)
    }
    // One "Worst verdict" line per section, and the sections' own blocks beneath.
    expect(occurrences(report, '- Worst verdict: ')).toBe(SECTION_IDS.length)
    expect(report).toContain('### Socket lane and boot gate')
    expect(report).toContain('### Clock')
    expect(report).toContain('### Durable storage')
    expect(report).toContain('### Account and access')
    expect(report).toContain('### Deployment identity')
  })

  it('carries the SYNC_ITEMS verdict and the checks into the report', async () => {
    await renderTab(makeApplication())
    await clickButton('Test all capabilities')
    await openSubtab('Copyable report')

    const report = reportText()
    expect(report).toContain('- SYNC_ITEMS advertised: no')
    expect(report).toContain('- SYNC_ITEMS cause: LANE_PRECONDITION_UNMET')
    expect(report).toContain('[FAIL] Ticket issuance')
  })

  it('copies it to the clipboard and confirms', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    await clickButton('Copy report')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('## Topology')
    expect(writeText.mock.calls[0][0]).toContain('## Browser')
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
          capturedAt: CAPTURED_AT,
          deployment: { ...unavailablePayload.deployment, serviceProxySetting: 'grpc', grpcSyncingProxyBound: true },
          gate: {
            recorded: true,
            gatewayAttached: true,
            syncLaneEnabled: true,
            syncItems: { state: 'ADVERTISED', cause: null, remedy: null, probe: 'READY' },
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
    expect(routerRow('websocket')[1]).not.toBe('Down')
    expect(await openSubtab('WebSocket')).toContain('Socket lane and boot gate')
  })

  /**
   * The security boundary, proved against the rendered DOM AND against the report
   * that is designed to be pasted in public. The server is made to misbehave — it
   * returns configuration VALUES in every string field the component reads — and
   * none of them may reach either. Every one of the eight tabs is swept, because
   * the five sections are new paths to the same data.
   */
  it('cannot render or export a secret even when the server sends one', async () => {
    const poisoned = {
      capturedAt: SECRETS[0],
      deployment: {
        ...unavailablePayload.deployment,
        // A server that has started putting values where booleans belong.
        presence: { REDIS_URL: SECRETS[0] as unknown as boolean, SYNCING_SERVER_GRPC_URL: true },
      },
      transportFallback: {
        observed: true,
        everDegraded: true,
        lanes: { 'items-sync': { degradedCalls: 2, refusedCalls: 0, lastFailureClass: SECRETS[1] } },
      },
      gate: {
        recorded: true,
        gatewayAttached: true,
        syncLaneEnabled: false,
        syncItemsAdvertised: false,
        syncItems: { state: 'WITHHELD', cause: SECRETS[2], remedy: `the backend at ${SECRETS[1]} refused` },
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
        realtime: { attached: true, pushBridge: SECRETS[1], syncLane: SECRETS[0] },
      },
      /**
       * NOT poisoned, and the reason is a REAL LEAK this change could not fix.
       *
       * An operation name off the wire is echoed VERBATIM by `diagnose()` in
       * `syncDiagnostics.ts` ("This client does not implement <name>"), by
       * `remedyForClientGap` in `diagnosticRemedies.ts`, and by the legacy
       * capability matrix in the copyable report — all three of which predate the
       * section split and none of which this change owns. Putting a secret here
       * fails this sweep on the Overview and in the report, as it should.
       *
       * The five SECTIONS do not have that hole: they count an unrecognised
       * operation and never name it. That is proved by its own test below, which
       * poisons this exact field and sweeps the five section tabs.
       */
      protocol: { version: 1, serverOperations: ['SYNC_ITEMS', 'FILES_V1'] },
    }
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({ status: 200, ok: true, data: poisoned }),
      legacyApi: {
        adminGetServerStatus: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            services: [{ name: SECRETS[1], status: SECRETS[0], reachable: true }],
            health: { gateway: { redis: SECRETS[2] } },
          },
        }),
      },
      syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
    })

    await renderTab(application)

    for (const label of ALL_SUBTABS) {
      const text = await openSubtab(label)
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret)
      }
    }

    await openSubtab('Copyable report')
    const report = reportText()
    for (const secret of SECRETS) {
      expect(report).not.toContain(secret)
    }
    expect(report).not.toMatch(/redis:\/\//)
    // The remedy still names the variable, without ever carrying its value.
    expect(report).toContain('REDIS_UNBOUND')
  })

  /**
   * *** A SERVER-SUPPLIED OPERATION NAME: WHAT IS SAFE AND WHAT IS NOT. ***
   *
   * Every ROW that reads `protocol.serverOperations` counts an unrecognised
   * operation and never names it — `safeEnum` admits only this build's own closed
   * list — and this pins that for all five sections.
   *
   * It does NOT pin the whole pane, because `remedyForClientGap`
   * (`diagnosticRemedies.ts`) interpolates the names into its remedy copy, which
   * reaches the Overview diagnosis, the WebSocket capability block and the legacy
   * capability matrix in the report. `Remedy` is the one type the section contract
   * exempts from `SafeValue`, on the grounds that its constructor redacts the
   * server prose it carries — and that redactor is a DENYLIST: it withholds an
   * address-shaped name and prints anything else verbatim. Both halves are
   * asserted here so the exposure is recorded rather than implied, and the fix
   * belongs to `diagnosticRemedies.ts`, which this change does not own.
   */
  it('counts an unrecognised operation in its rows rather than naming it', async () => {
    const application = makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          ...unavailablePayload,
          protocol: { version: 1, serverOperations: ['SYNC_ITEMS', SECRETS[1], SECRETS[3]] },
        },
      }),
    })
    await renderTab(application)

    await openSubtab('WebSocket')
    // The fact is reported as a count, and the names are not in any row.
    expect(sectionRow('Operations this build does not recognise')[1]).toBe('2')
    for (const label of ['Operations this server advertises', 'Operations this build does not recognise']) {
      for (const secret of SECRETS) {
        expect(sectionRow(label)[1]).not.toContain(secret)
      }
    }
    // The address-shaped name is withheld even on the remedy path.
    expect(activePanel().textContent).not.toContain(SECRETS[1])
    expect(activePanel().textContent).toContain('[address withheld]')

    // The four sections that do not reach `remedyForClientGap` carry none of it.
    for (const id of ['environment', 'backend', 'account', 'browser'] as const) {
      const text = await openSubtab(SECTION_TITLE[id])
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret)
      }
    }
  })
})

/**
 * *** "I COULD NOT ASK" IS NOT "IT IS DOWN." ***
 *
 * The defect these pin, rendered: a failure to READ /v1/admin/sync-diagnostics
 * put an "Unavailable" chip directly beside a verdict chip reading "WebSocket",
 * derived from `application.syncTransportStatus` and correct. Two independent
 * sources of truth on one row, and the one that had read nothing overwrote the
 * one that had measured something.
 *
 * The socket is deliberately LIVE in every case below. If the panel ever again
 * renders the unread endpoint as a negative verdict about the socket, these fail.
 */
describe('AdminDiagnosticsTab — an unreadable diagnostics endpoint', () => {
  const unreadable = (status: number) =>
    makeApplication({
      serverGetJsonRequest: jest.fn().mockResolvedValue({ status, ok: false, data: {} }),
      syncTransportStatus: { state: 'READY', operations: ['SYNC_ITEMS', 'API_RPC'] },
    })

  it('keeps the live transport verdict and does NOT claim the socket is unavailable', async () => {
    const text = await renderTab(unreadable(401))

    expect(text).toContain('WebSocket')
    expect(text).toContain('The socket lane is live')
    expect(text).not.toContain('Unavailable')
    expect(text).not.toContain('the realtime sync lane is unavailable')
  })

  it('renders the unread state as its own chip, not as a verdict about availability', async () => {
    const text = await renderTab(unreadable(401))

    expect(text).toContain('Unknown')
    expect(text).toContain('could not be READ from the server')
    expect(text).toContain('measured by this client')
  })

  it('does not blame the admin role for a 401 — the status rules that cause out', async () => {
    const text = await renderTab(unreadable(401))

    expect(text).toContain('not authenticated (401)')
    expect(text).toContain('NOT an admin-role problem')
    expect(text).not.toContain('check that your session carries the admin role')
    expect(text).not.toContain('Either the running build predates this endpoint')
  })

  it('blames the admin role for a 403, which is the status that means it', async () => {
    const text = await renderTab(unreadable(403))

    expect(text).toContain('refused (403)')
    expect(text).toContain('requires the admin role')
    expect(text).not.toContain('predates')
  })

  it('reports a 404 as a build that predates the endpoint, not as a permissions problem', async () => {
    const text = await renderTab(unreadable(404))

    expect(text).toContain('no diagnostics endpoint (404)')
    expect(text).toContain('predates')
  })

  it('reports an unrecognised status by number without guessing a cause', async () => {
    const text = await renderTab(unreadable(502))

    expect(text).toContain('answered 502')
    expect(text).not.toContain('predates')
  })

  it('carries the same status-branched meaning into the copyable report', async () => {
    await renderTab(unreadable(401))
    await openSubtab('Copyable report')
    const report = reportText()

    expect(report).toContain('What that means')
    expect(report).toContain('NOT an admin-role problem')
    expect(report).not.toContain('check that your session carries the admin role')
  })
})

/**
 * The chip mapping, asserted against the REAL tone union (`Tone` is derived from
 * `TONES`). The bug was a ternary chain — `good ? 'Healthy' : warn ? 'Degraded'
 * : 'Unavailable'` — in which every tone that was not good or warn inherited a
 * confident claim that the socket was unavailable. `Record<Tone, string>` makes a
 * new tone a compile error; these make a mapping that compiles and is still
 * wrong a test failure.
 */
describe('AdminDiagnosticsTab — the diagnosis chip mapping', () => {
  it('has a label for every tone in the union, with nothing falling through', () => {
    expect(Object.keys(DIAGNOSIS_CHIP_LABEL).sort()).toEqual([...TONES].sort())
    for (const tone of TONES) {
      expect(DIAGNOSIS_CHIP_LABEL[tone]).toBeTruthy()
      // And every one of them is renderable: Chip reads its styling from the one
      // shared mapping, which this file now imports from its defining module.
      expect(TONE_CHIP[tone]).toBeTruthy()
    }
  })

  it('lets exactly one tone — the bad one — claim the lane is unavailable', () => {
    expect(TONES.filter((tone) => DIAGNOSIS_CHIP_LABEL[tone] === 'Unavailable')).toEqual(['bad'])
  })

  it('gives the no-verdict tone a label of its own', () => {
    expect(DIAGNOSIS_CHIP_LABEL.neutral).toBe('Unknown')
    expect(DIAGNOSIS_CHIP_LABEL.neutral).not.toBe(DIAGNOSIS_CHIP_LABEL.bad)
    expect(DIAGNOSIS_CHIP_LABEL.neutral).not.toBe(DIAGNOSIS_CHIP_LABEL.warn)
  })
})
