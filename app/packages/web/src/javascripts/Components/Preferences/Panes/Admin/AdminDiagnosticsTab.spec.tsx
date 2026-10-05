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
  // `SettingName.create(name)` returns a RESULT, and `.getValue()` unwraps it to a
  // SettingName OBJECT — not to the string. Both levels are modelled, because a
  // one-level double resolves the string straight through and then every space row
  // reads "not reported" for a reason that does not exist in production.
  SettingName: {
    NAMES: { FileUploadBytesUsed: 'FILE_UPLOAD_BYTES_USED', FileUploadBytesLimit: 'FILE_UPLOAD_BYTES_LIMIT' },
    create: (name: string) => ({ getValue: () => ({ name }) }),
  },
  // The content type the file census counts over. A double that omits it makes
  // `ContentType.TYPES.File` throw, `observed` swallow the throw, and the census
  // read "not reported" for a reason that does not exist in production — the same
  // trap the SettingName double above records.
  ContentType: { TYPES: { File: 'SN|FileItem' } },
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
  // Appended, so every index above keeps its meaning. This one is shaped exactly
  // like an environment variable NAME — upper snake case, inside the length
  // limit — because that is the one class a shape floor ADMITS. It is planted as
  // a presence KEY, which is a string the server chooses as much as any value,
  // and a sweep built only from the entries above passed over it.
  'PLANTED_VARIABLE_SHAPED_SENTINEL',
  // [6] and [7], appended for the same reason, for the BOOT GATE's own strings.
  //
  // *** THE DIMENSION THIS SWEEP WAS BLIND TO. *** Until these existed the
  // poisoned payload below carried a clean `REDIS_UNBOUND` in
  // `unmetPreconditions[].code`, a clean `sync-not-configured` in
  // `unavailabilityReasons`, a clean `FILES_INTERNAL_URL` in
  // `files.unmetCondition`, no `host` block at all, and ADDRESS-SHAPED values in
  // the two remedy fields — which a denylist and a correct allowlist both catch,
  // so they could not discriminate between the two mechanisms. Seven fields were
  // leaking through this sweep: a probe over the live stack's own payload printed
  // a marker-built value intact out of every one of them.
  //
  // [6] is opaque: no scheme, no dot, no colon, nothing for any pattern in
  // `sanitizeServerCopy` to match. [7] is the same marker alphabet in upper snake
  // case, which is the shape of a legitimate condition code.
  'zqx7v2-kkmr9pt4-jjdw3bn8-xxhf6cs1-vvqz5gy0-ttnb8dk2',
  'ZQX7V2_KKMR9PT4_JJDW3BN8_XXHF6CS1_VVQZ5GY0',
]

/**
 * Head, middle and tail of a planted value, 20 characters each.
 *
 * The sweep asserts on these rather than on whole strings, because a whole-string
 * assertion is the one that passes vacuously against a TRUNCATED leak: the bytes
 * that escaped are then a substring nobody checked. The middle and tail windows
 * of the two sentinels above sit past 30 and 45 characters.
 */
const windowsOf = (value: string): readonly string[] => {
  const middle = Math.max(0, Math.floor((value.length - 20) / 2))
  return [...new Set([value.slice(0, 20), value.slice(middle, middle + 20), value.slice(-20)])]
}

const SECRET_WINDOWS = SECRETS.flatMap((secret) => windowsOf(secret))

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
  // The account's OWN space figures, scoped to the requesting session — no user id
  // in either direction. This is the surface the Space block went empty for want
  // of, and the surface this pane wrongly recorded as not existing.
  settings: {
    // The read carries the server's `origin` alongside the value, because an
    // absent FILE_UPLOAD_BYTES_LIMIT row is not an absent allowance: auth answers
    // the EFFECTIVE allowance the upload-token minter would apply and says whether
    // that came from a per-account setting, a plan default, or the unlimited
    // fallback for an account with no live subscription.
    getSubscriptionSettingDetail: jest.fn().mockImplementation(async (name: { name: string }) => {
      return name.name === 'FILE_UPLOAD_BYTES_USED'
        ? { value: '1048576' }
        : { value: '10485760', origin: 'account-setting' }
    }),
  },
  // The file census the Space block reads to decide whether an absent usage
  // figure is a lost bookkeeping write or simply nothing to report. Two surfaces,
  // because an empty item list means nothing until the cold load has finished.
  sync: { isDatabaseLoaded: () => true },
  items: { getItems: () => [] },
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
   *
   * Both now say it in ONE SENTENCE. The admission block used to render ten rows
   * each reading "not reported", which is the same information and reads as a
   * panel that is broken; the rows are asserted ABSENT here rather than absent of
   * value, and the block's own spec pins their return the moment a counter is
   * reported.
   */
  it('renders the unproduced counter and ledger blocks as empty notes, never as zeros', async () => {
    const text = await openWebsocket()

    expect(text).toContain('Gateway admission and traffic')
    expect(text).toContain('reported no admission counters at all')
    expect(text).toContain('appears the moment the block arrives')
    expect(text).toContain('Lane degradation ledger')
    expect(text).toContain('This client build records no lane-degradation ledger')
    expect(text).toContain('absence of evidence, not evidence of none')
    // The rows are gone, not merely empty — and a zero is still nowhere near them.
    expect(text).not.toContain('Sockets the gateway holds now')
    expect(text).not.toContain('This client’s origin admitted')
  })

  /**
   * *** THE ADMISSION BLOCK, THROUGH THE REAL TAB. ***
   *
   * It is the last block that had no producer, and a shape declared but not
   * threaded is the defect this directory keeps repeating: a ledger the server
   * was already sending, with a payload type that did not say so, left every row
   * reading "not reported" on a deployment that was reporting. Read out of the
   * mounted table rather than off the builder, and driven through
   * `payload.admission` because that is the path a real deployment takes.
   */
  it('threads the admission block, so the ten counter rows render as values', async () => {
    await openWebsocket(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            admission: {
              originAdmitted: true,
              allowedOriginCount: 2,
              allowsSameOrigin: true,
              liveSockets: 4,
              ticketsIssued: 11,
              ticketsRefused: 0,
              handshakeRejected: 0,
              rejections: { originNotAllowed: 1, queryStringNotPermitted: 0, unavailable: 0 },
            },
          },
        }),
      }),
    )

    expect(sectionRow('Origin rules the gateway admits on')[1]).toBe('2')
    expect(sectionRow('Sockets the gateway holds now')[1]).toBe('4')
    expect(sectionRow('Tickets issued since attach')[1]).toBe('11')
    expect(sectionRow('Tickets refused since attach')[1]).toBe('0')
    expect(sectionRow('Connections refused since attach: origin not allowed')[1]).toBe('1')
    // A positive admission is NECESSARY and nowhere near sufficient, so it caps.
    expect(sectionRow('This client’s origin admitted')[1]).toBe('yes')
    expect(sectionRow('This client’s origin admitted')[2]).toBe('Unknown')
    expect(activePanel().textContent).not.toContain('reported no admission counters at all')
  })

  /**
   * The server omits the whole block when no gateway is attached, and the pane
   * must say THAT rather than "this server reported nothing" — which would send
   * an operator looking for a missing endpoint instead of at the boot gate, where
   * the actual finding is.
   */
  it('says no gateway is attached rather than blaming the server build', async () => {
    const text = await openWebsocket(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            gate: { ...unavailablePayload.gate, recorded: true, gatewayAttached: false },
          },
        }),
      }),
    )

    expect(text).toContain('No gateway is attached')
    expect(text).toContain('the complete answer rather than a gap')
    expect(text).not.toContain('reported no admission counters at all')
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

  /**
   * No producer exists for the runtime view, and its rows must say SO — which is
   * a different sentence from "not reported". The operator read a column of "not
   * reported" as a column of failed checks and asked why the diagnostics were
   * incomplete; the answer for these rows is that nothing emits them.
   */
  it('says plainly that nothing publishes the runtime facts, rather than "not reported"', async () => {
    await openEnvironment()

    // *** THE LIST THIS TEST GUARDS KEEPS SHRINKING, AND THAT IS THE POINT. ***
    // The lane decision, the process uptime and the cookie/session-mode flags all
    // have producers on the deployment block now, so this fixture — whose payload
    // carries none of them — reads "not reported": the honest wording for a field
    // that COULD have been reported and was not. "no endpoint publishes this" is
    // reserved for a field with no producer at all, and printing it over a surface
    // that does publish closes a question that should stay open. What is still
    // asserted here is the VERDICT side: none of these rows claims anything from
    // an empty value, and the three cookie flags remain one line rather than three
    // blanks.
    for (const label of [
      'Why this transport was chosen',
      'Time since this process started',
      'Effective cookie and session-mode flags',
    ]) {
      expect({ label, value: sectionRow(label)[1] }).toEqual({ label, value: 'not reported' })
      expect(sectionRow(label)[1]).not.toBe('no endpoint publishes this')
    }
    expect(activePanel().textContent).not.toContain('Cookie Secure flag')
  })

  /**
   * *** THE WIRING, THROUGH THE REAL TAB. ***
   *
   * `payload.runtime` is threaded now, and a model that compiles is not a model
   * that renders: the rows are read out of the mounted table rather than off a
   * builder, because an unthreaded field leaves every one of them reading "not
   * reported" on a deployment that is reporting — the scar `environmentSection.ts`
   * records in its own header, from the per-call fallback counters.
   */
  it('threads the runtime block, so the gateway and auth facts render as values', async () => {
    await openEnvironment(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            runtime: {
              processUptimeSeconds: 7200,
              authRuntimeProbe: 'answered',
              authProcessUptimeSeconds: 120,
              cookieSecure: true,
              cookiePartitioned: false,
              e2eTesting: false,
            },
          },
        }),
      }),
    )

    expect(sectionRow('Time since this process started')[1]).toBe('2h 0m')
    expect(sectionRow('Time since the auth process started')[1]).toBe('2m 0s')
    expect(sectionRow('Auth runtime read')[1]).toBe('answered')
    // The three collapsed flags are three rows again, as EFFECTIVE values.
    expect(sectionRow('Cookie Secure flag')[1]).toBe('on')
    expect(sectionRow('Cookie Partitioned flag')[1]).toBe('off')
    expect(sectionRow('End-to-end test mode')[1]).toBe('no')
    expect(activePanel().textContent).not.toContain('Effective cookie and session-mode flags')
  })

  /**
   * The single container is the deployment this must not alarm: auth runs
   * in-process with no HTTP listener, so the probe legitimately cannot complete
   * and the four auth-owned rows are absent BY DESIGN.
   */
  it('does not paint an unprobeable auth process as a fault', async () => {
    await openEnvironment(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            runtime: { processUptimeSeconds: 30, authRuntimeProbe: 'unreachable' },
          },
        }),
      }),
    )

    expect(sectionRow('Auth runtime read')[1]).toBe('unreachable')
    expect(sectionRow('Auth runtime read')[2]).toBe('Info')
    expect(sectionRow('Time since the auth process started')[1]).toBe('not reported')
    expect(sectionRow('Effective cookie and session-mode flags')[1]).toBe('not reported')
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

  /**
   * *** THE OTHER HALF OF THE WIRING, THROUGH THE REAL TAB. ***
   *
   * `payload.datastore` and `payload.queues` are threaded now. Read out of the
   * mounted table for the same reason as the runtime block: a field declared and
   * not threaded leaves its rows reading "not reported" over a server that is
   * answering, which is the one failure this whole task exists to close.
   *
   * The queue assertion is the load-bearing one. The VERDICT is the server's,
   * derived once from its own consumer census plus the presence pair; the count
   * is printed beside it as evidence and must not be the thing the verdict comes
   * from.
   */
  it('threads the datastore and queue blocks, including the verdict the server derived', async () => {
    await openBackend(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: {
            ...unavailablePayload,
            datastore: {
              connectionState: 'handle-only',
              writeProbe: 'accepted',
              migrationsApplied: true,
              readRoundTripMs: 4,
              writeRoundTripMs: 9,
            },
            queues: { separation: 'inherited-shared-queue', consumerCount: 5 },
          },
        }),
      }),
    )

    expect(sectionRow('Database connection state')[1]).toBe('handle-only')
    expect(sectionRow('Database connection state')[2]).toBe('Down')
    expect(sectionRow('Database write probe')[1]).toBe('accepted')
    // Narrow positive: accepted is a necessary condition, so it is capped.
    expect(sectionRow('Database write probe')[2]).toBe('Unknown')
    expect(sectionRow('Schema migrations')[1]).toBe('yes')
    // Absent pool figures inside a block that DID report: the driver keeps none.
    expect(sectionRow('Connection pool in use')[1]).toBe('no pool kept by this driver')
    expect(sectionRow('Queue separation')[1]).toBe('inherited-shared-queue')
    expect(sectionRow('Queue separation')[2]).toBe('Down')
    expect(sectionRow('Co-resident queue consumers')[1]).toBe('5')
    expect(sectionRow('Co-resident queue consumers')[2]).toBe('Info')
    expect(activePanel().textContent).toContain('Two consumers are reading one event queue')
    expect(activePanel().textContent).not.toContain('Connection, schema, pool and round trips')
  })

  /**
   * The census WITHOUT a verdict: the server looked, could not classify, and
   * omitted `separation`. The pane must render that as its own answer rather than
   * reading `1` as "no collision" — which is exactly what a deployment whose
   * workers live in another container reports.
   */
  it('renders a withheld queue verdict as withheld, not as the reassuring answer', async () => {
    await openBackend(
      makeApplication({
        serverGetJsonRequest: jest.fn().mockResolvedValue({
          status: 200,
          ok: true,
          data: { ...unavailablePayload, queues: { consumerCount: 1 } },
        }),
      }),
    )

    expect(sectionRow('Co-resident queue consumers')[1]).toBe('1')
    expect(sectionRow('Queue separation')[1]).toBe('not classifiable from here')
    expect(sectionRow('Queue separation')[2]).toBe('Unknown')
    expect(activePanel().textContent).not.toContain('Two consumers are reading one event queue')
  })

  /**
   * *** THE OTHER SIDE OF THAT DISTINCTION, AND IT IS A PROPERTY OF THE
   * THREADING RATHER THAN OF THE SECTION. ***
   *
   * A payload with NO `queues` block at all is a server older than it, and the
   * row must say "not reported" — not the withheld-verdict wording the test
   * above pins. The section can only tell those apart if the tab hands it the
   * RAW optional, so a `?? {}` anywhere on the way in collapses the two into
   * one, silently, with every section-level test still green. That mutation
   * survived until this assertion existed.
   */
  it('keeps an absent queue block distinct from a verdict the server withheld', async () => {
    await openBackend()

    expect(sectionRow('Queue separation')[1]).toBe('not reported')
    expect(sectionRow('Queue separation')[1]).not.toBe('not classifiable from here')
    expect(sectionRow('Co-resident queue consumers')[1]).toBe('not reported')
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

  /* ------------------------------------------------------------------------ */
  /* The Space block can finally report                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE BLOCK WAS EMPTY BECAUSE THIS TAB PASSED NOTHING. ***
   *
   * Every Space row read "not reported" on every deployment, and the reason
   * recorded for it was that the only reader of these two numbers was the admin
   * Users tab, which reaches them BY USER ID — so a self-scoped reading was said not
   * to exist. It does: `settings.getSubscriptionSettingDetail` answers for the requesting
   * session and carries no identifier either way, which is how the account's own
   * Files preferences pane has always read them. The block now reports.
   */
  it('reports the account’s own space figures, read self-scoped with no identifier', async () => {
    const application = makeApplication()
    await openAccount(application)

    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('1')
    expect(sectionRow('Server file allowance, whole MB')[1]).toBe('10')
    expect(sectionRow('Server file allowance used')[1]).toBe('0-25%')
    expect(sectionRow('Room for a file upload')[1]).toBe('room available')
    expect(sectionRow('Where the file allowance comes from')[1]).toBe('account-setting')

    // Precondition on the surface itself: it is asked for exactly the two settings,
    // and nothing it was handed could carry an account identifier.
    const asked = application.settings.getSubscriptionSettingDetail.mock.calls.map(
      ([name]: [{ name: string }]) => name.name,
    )
    expect(asked).toEqual(['FILE_UPLOAD_BYTES_USED', 'FILE_UPLOAD_BYTES_LIMIT'])
  })

  /**
   * *** `-1` IS A FIGURE, AND THIS TAB USED TO THROW IT AWAY. ***
   *
   * The parse guard was `Number.isFinite(parsed) && parsed >= 0`, and `-1` is the
   * ONLY value the files server treats as unlimited — so the commonest allowance
   * on this fork was read, recognised as a number, and then discarded as if the
   * server had answered nothing. That is what left "Room for a file upload"
   * unreported on a deployment whose uploads were in fact unrestricted.
   */
  it('keeps the unlimited sentinel instead of discarding it as an unreportable figure', async () => {
    const text = await openAccount(
      makeApplication({
        settings: {
          getSubscriptionSettingDetail: jest.fn().mockImplementation(async (name: { name: string }) => {
            return name.name === 'FILE_UPLOAD_BYTES_USED'
              ? { value: '1048576' }
              : { value: '-1', origin: 'no-active-subscription' }
          }),
        },
        items: { getItems: () => [{ uuid: 'a-file' }] },
      }),
    )

    expect(sectionRow('Server file allowance, whole MB')[1]).toBe('no limit set')
    expect(sectionRow('Where the file allowance comes from')[1]).toBe('no-active-subscription')
    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('1')
    expect(sectionRow('Room for a file upload')[1]).toBe('no limit set')
    expect(text).not.toContain('asked for and did not arrive')
  })

  /**
   * *** PUBLISHING THE ALLOWANCE MUST NOT SILENCE THE USAGE FINDING. ***
   *
   * The Space block's findings were gated on BOTH figures being absent, and the
   * server now always derives an allowance — so the one new figure would have made
   * the bookkeeping degradation unreportable on every deployment at once. Asserted
   * at the wiring seam as well as in the section's own suite, because this is the
   * state the real server produces for an account whose usage writes were lost.
   */
  it('still reports the lost usage bookkeeping while the allowance answers', async () => {
    const text = await openAccount(
      makeApplication({
        settings: {
          getSubscriptionSettingDetail: jest.fn().mockImplementation(async (name: { name: string }) => {
            return name.name === 'FILE_UPLOAD_BYTES_USED' ? {} : { value: '-1', origin: 'no-active-subscription' }
          }),
        },
        items: { getItems: () => [{ uuid: 'a-file' }] },
      }),
    )

    expect(sectionRow('Server file allowance, whole MB')[1]).toBe('no limit set')
    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('not reported')
    expect(text).toContain('This account has files and the server reports no usage figure for them')
  })

  it('reports a read that threw as a FAILED read, not as a figure nobody asked for', async () => {
    // *** THE DISCRIMINATION, END TO END. *** The two kinds of empty had to be
    // distinguishable, and until this wiring landed only one of them was reachable.
    const text = await openAccount(
      makeApplication({
        settings: { getSubscriptionSettingDetail: jest.fn().mockRejectedValue(new Error('refused')) },
      }),
    )

    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('not reported')
    expect(text).toContain('asked for and did not arrive')
    expect(text).not.toContain('does not read this account’s own space figures')
  })

  /**
   * *** THE FALSE ALARM, END TO END. ***
   *
   * An account that has simply never uploaded a file gets a 200 (or a 400 the
   * client maps to `undefined` without throwing) carrying no usage figure, and
   * that used to render as "the read FAILED" and take the whole section to broken.
   * It is now an informational statement of fact, and the section is not broken.
   */
  it('reports an answer carrying no figure for a fileless account as nothing to report, not a failure', async () => {
    const text = await openAccount(
      makeApplication({ settings: { getSubscriptionSettingDetail: jest.fn().mockResolvedValue({}) } }),
    )

    // The figures really are absent, and really are not a zero.
    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('not reported')
    expect(sectionRow('Server file bytes used, whole MB')[1]).not.toBe('0')
    expect(sectionRow('Room for a file upload')[1]).toBe('not reported')
    // The census really was read, and really says the account has no file.
    expect(sectionRow('Uploaded files in this account')[1]).toBe('none')

    expect(text).toContain('There is no file usage to report for this account yet')
    expect(text).not.toContain('asked for and did not arrive')
  })

  it('reports an answer carrying no figure for an account WITH files as a bookkeeping degradation', async () => {
    const text = await openAccount(
      makeApplication({
        settings: { getSubscriptionSettingDetail: jest.fn().mockResolvedValue({}) },
        items: { getItems: () => [{ uuid: 'a-file' }] },
      }),
    )

    expect(sectionRow('Uploaded files in this account')[1]).toBe('present')
    expect(text).toContain('This account has files and the server reports no usage figure for them')
    expect(text).not.toContain('asked for and did not arrive')
  })

  /**
   * *** AN UNLOADED COLLECTION IS NOT AN EMPTY ONE, AT THE WIRING SEAM. ***
   * `items` answers `[]` for the whole window between launch and the cold load
   * completing, so the census is gated on `sync.isDatabaseLoaded()` rather than on
   * the list being empty. Without that gate this case would read "none" and a real
   * loss of upload bookkeeping would be reported as nothing to report.
   */
  it('does not read an unloaded item collection as an account with no files', async () => {
    const text = await openAccount(
      makeApplication({ sync: { isDatabaseLoaded: () => false }, items: { getItems: () => [] } }),
    )

    expect(sectionRow('Uploaded files in this account')[1]).toBe('not-loaded')
    expect(text).not.toContain('There is no file usage to report for this account yet')
  })

  it('does not let an unparseable setting become a byte count', async () => {
    const text = await openAccount(
      makeApplication({
        settings: { getSubscriptionSettingDetail: jest.fn().mockResolvedValue({ value: 'not a number' }) },
        items: { getItems: () => [{ uuid: 'a-file' }] },
      }),
    )

    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('not reported')
    expect(text).not.toContain('not a number')
    // Asserted on the FINDING rather than on the row alone: `safeCount` would refuse
    // a NaN at the row anyway, so a row-only assertion passes even when the parse
    // guard is gone — and then an unparseable setting silently counts as a figure
    // that arrived, and the block stops reporting that the read produced nothing.
    // The account is given a file so the arm under test is the one that still
    // raises a verdict: a fileless account reports "nothing to report" and the
    // assertion would pass over a dropped guard.
    expect(text).toContain('This account has files and the server reports no usage figure for them')
  })

  /**
   * *** ONE READ THROWING MUST NOT ERASE THE OTHER. ***
   * The two settings were awaited in sequence inside one `try`, so a throw on the
   * usage read discarded the allowance read that had not happened yet. They are
   * settled independently now, and the allowance still arrives.
   */
  it('keeps the allowance figure when only the usage read throws', async () => {
    await openAccount(
      makeApplication({
        settings: {
          getSubscriptionSettingDetail: jest.fn().mockImplementation(async (name: { name: string }) => {
            if (name.name === 'FILE_UPLOAD_BYTES_USED') {
              throw new Error('refused')
            }
            return { value: '10485760', origin: 'plan-default' }
          }),
        },
      }),
    )

    expect(sectionRow('Server file allowance, whole MB')[1]).toBe('10')
    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('not reported')
  })

  /* ------------------------------------------------------------------------ */
  /* The per-account feature flags, which this tab never asked for             */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE ENDPOINT EXISTED AND THIS TAB PRINTED "NO ENDPOINT PUBLISHES THIS". ***
   *
   * `LIVE_SYNC_ENABLED` and `COLLABORATION_ENABLED` are answered by
   * `GET /v1/admin/users/:userUuid/feature-flags`, the route the admin Users tab
   * has always read. Both rows carried the structural constant reserved for a
   * field with NO producer, which is not an empty row but a closed question.
   *
   * The user uuid goes in the REQUEST PATH and nothing carrying it reaches the
   * section — asserted below on the path actually requested, because that is the
   * one place an identifier legitimately appears and the one place a regression
   * would move it somewhere it does not.
   */
  const FLAG_READ_USER_UUID = 'd9f0a1b2-4444-4ccc-9eee-7a8b9c0d1e2f'

  const flagsApplication = (flags: unknown, status = 200) =>
    makeApplication({
      sessions: {
        isSignedIn: () => true,
        isSignedIntoFirstPartyServer: () => true,
        // The ONE identifier this tab legitimately holds, and it exists only to
        // address the request. It is planted with a marker so the assertions below
        // can require it absent from everything rendered.
        getUser: () => ({ uuid: FLAG_READ_USER_UUID }),
      },
      serverGetJsonRequest: jest.fn().mockImplementation(async (path: string) => {
        if (path.includes('/feature-flags')) {
          return { status, ok: status === 200, data: { flags } }
        }
        return { status: 200, ok: true, data: unavailablePayload }
      }),
    })

  it('reads this account’s own feature flags and renders both switches', async () => {
    const application = flagsApplication({ LIVE_SYNC_ENABLED: null, COLLABORATION_ENABLED: 'false' })
    await openAccount(application)

    // An UNSET flag is `null` and the server reads that as ENABLED, so reporting it
    // as anything else would accuse an administrator of a switch nobody flipped.
    expect(sectionRow('Live sync for this account')[1]).toBe('enabled')
    expect(sectionRow('Collaboration permitted for this account')[1]).toBe('disabled')

    const paths = application.serverGetJsonRequest.mock.calls.map(([path]: [string]) => path)
    expect(paths).toContain(`/v1/admin/users/${FLAG_READ_USER_UUID}/feature-flags`)
    // *** AND THE UUID GOES NOWHERE ELSE. *** It is in the request path and in
    // nothing the operator can paste: not a row, not a note, not the report.
    expect(activePanel().textContent).not.toContain(FLAG_READ_USER_UUID)
    expect(activePanel().textContent).not.toContain('d9f0a1b2')
  })

  /**
   * *** THE ADMIN GATE MUST NOT RENDER AS A FAULT. *** The endpoint answers 403 to
   * every non-admin session, which is most of them. A `false` invented from that
   * refusal would tell an ordinary user their administrator had switched their
   * account off.
   */
  it('words an admin-refused flag read as a gated surface, claiming nothing', async () => {
    const text = await openAccount(flagsApplication(undefined, 403))

    expect(sectionRow('Live sync for this account')[1]).toBe('readable only by an admin session')
    expect(sectionRow('Collaboration permitted for this account')[1]).toBe('readable only by an admin session')
    expect(text).not.toContain('Live sync is turned off for this account')
    expect(text).not.toContain('no endpoint publishes this')
  })

  it('reports a flag payload that carries no flags as unreported, not as disabled', async () => {
    await openAccount(flagsApplication(undefined))

    expect(sectionRow('Live sync for this account')[1]).toBe('not reported')
    expect(sectionRow('Collaboration permitted for this account')[1]).toBe('not reported')
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
  it('says in one row that no client surface exposes the role names', async () => {
    await openAccount()

    expect(sectionRow('Roles held by this account')[1]).toBe('not exposed by any client surface')
    expect(activePanel().textContent).not.toContain('Roles outside this build’s taxonomy')
    expect(activePanel().textContent).not.toContain('Role: Admin user')
  })

  /**
   * *** THE SUBSCRIPTION EXPIRY IS WIRED, AND ITS UNIT IS NOT GUESSED. ***
   *
   * This row was left unwired on the recorded ground that nothing established
   * whether `endsAt` is milliseconds or microseconds. `convertTimestampToMilliseconds`
   * — the repo's own reader of that field — decides by digit count, so the duration
   * is computed with the same call the rest of the app uses. Both arms are
   * asserted: a timestamp it can place produces a duration, and one it cannot
   * produces nothing rather than a duration wrong by a factor of a thousand.
   */
  it('reports the time left on the subscription as a duration, from a timestamp it can place', async () => {
    // Microseconds, 16 digits, one day after the pinned system time.
    const oneDayLater = (Date.parse('2026-08-27T00:00:30.000Z') * 1000).toString()
    expect(oneDayLater).toHaveLength(16)

    await openAccount(
      makeApplication({
        subscriptionController: {
          onlineSubscription: { planName: 'PRO_PLAN', cancelled: false, endsAt: Number(oneDayLater) },
        },
      }),
    )

    expect(sectionRow('Time until the subscription ends')[1]).toBe('1d 0h')
  })

  it('reports nothing rather than a fabricated duration for a timestamp it cannot place', async () => {
    await openAccount(
      makeApplication({
        subscriptionController: { onlineSubscription: { planName: 'PRO_PLAN', cancelled: false, endsAt: 12_345 } },
      }),
    )

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

  /* ------------------------------------------------------------------------ */
  /* A second tab is not a failed check                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE MISREPORT THIS PAIR EXISTS TO PIN. ***
   *
   * Run from a second browser tab, where the first tab owns the socket, this check
   * recorded `[FAIL] Live socket negotiation` — on a report whose own top-level
   * Diagnosis said the realtime lane was fully available, and over a condition the
   * transport's own copy calls "Expected, and not a fault". Three surfaces
   * describing one state, one of them calling it broken.
   *
   * The second test is the one that keeps this honest: the SAME non-READY state
   * over a reason that is a genuine fault must still read as a failure. A quieter
   * pane that cannot report a real fault is a worse pane.
   */
  it('reports a tab that does not own the socket as a note rather than a failure', async () => {
    const application = makeApplication({
      syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [], fallbackReason: 'multi-tab-not-owner' },
    })
    await renderTab(application)

    await clickButton('Test all capabilities')
    const text = await openSubtab('Checks')

    expect(text).toContain('Live socket negotiation')
    expect(text).toContain('Not negotiated here: another tab of this account owns the socket lane')
    expect(text).toContain('Expected, and not a fault')
    // The summary line stops counting it against the run, in either direction.
    expect(text).toContain('did not apply here')
    expect(text).not.toContain('no operations are negotiated')
  })

  it('still fails the negotiation check for every fallback that IS a fault', async () => {
    for (const fallbackReason of ['proxy-failed', 'auth-failed', 'worker-error', 'capability-unavailable'] as const) {
      const application = makeApplication({
        syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [], fallbackReason },
      })
      await renderTab(application)

      await clickButton('Test all capabilities')
      const text = await openSubtab('Checks')

      expect(text).toContain(`Transport is HTTP_FALLBACK (${fallbackReason}) — no operations are negotiated.`)
      expect(text).not.toContain('did not apply here')
      expect(text).not.toContain('another tab of this account')
    }
  })

  it('still fails the negotiation check with no reason at all, and with no transport at all', async () => {
    const noReason = makeApplication({ syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [] } })
    await renderTab(noReason)
    await clickButton('Test all capabilities')
    expect(await openSubtab('Checks')).toContain('Transport is HTTP_FALLBACK — no operations are negotiated.')

    const noTransport = makeApplication({ syncTransportStatus: undefined })
    await renderTab(noTransport)
    await clickButton('Test all capabilities')
    const text = await openSubtab('Checks')
    expect(text).toContain('No realtime transport is installed in this client.')
    expect(text).not.toContain('did not apply here')
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
        // A server that has started putting values where booleans belong — and,
        // in the third entry, one whose KEY it chose itself. A key off the wire
        // reached a row label and the report's configuration block through the
        // redactor, which withheld the address-shaped ones and printed the
        // variable-shaped one intact.
        presence: {
          REDIS_URL: SECRETS[0] as unknown as boolean,
          SYNCING_SERVER_GRPC_URL: true,
          [SECRETS[5]]: true,
          [SECRETS[1]]: true,
        },
      },
      transportFallback: {
        observed: true,
        everDegraded: true,
        lanes: { 'items-sync': { degradedCalls: 2, refusedCalls: 0, lastFailureClass: SECRETS[1] } },
      },
      gate: {
        recorded: true,
        gatewayAttached: false,
        syncLaneEnabled: true,
        syncItemsAdvertised: false,
        syncItems: { state: 'WITHHELD', cause: SECRETS[2], remedy: `the backend at ${SECRETS[1]} refused` },
        // One condition this build KNOWS, carrying an opaque remedy — the case a
        // count alone does not cover, because a recognised code was a channel for
        // the server's prose too — and one it does not, carrying both. The second
        // entry's code is variable-shaped, which is what a shape floor admits.
        unmetPreconditions: [
          { code: 'REDIS_UNBOUND', remedy: `configure REDIS_URL to ${SECRETS[0]} ${SECRETS[6]}` },
          { code: SECRETS[7], remedy: SECRETS[6] },
        ],
        unmetCodes: ['REDIS_UNBOUND', SECRETS[7]],
        // A RECOGNISED sub-gate condition with a poisoned remedy. One payload
        // cannot exercise both branches of one field, and this is the branch a
        // denylist hides: the condition is admitted, so the panel prints a
        // sentence for it, and the server's prose used to be that sentence. The
        // unrecognised-condition branch is swept by `syncDiagnostics.spec.ts` and
        // `websocketSection.spec.ts`, which plant both shapes in it directly.
        files: {
          advertised: false,
          unmetCondition: 'FILES_INTERNAL_URL',
          remedy: `no INTERNAL files service URL is configured (${SECRETS[1]}) ${SECRETS[6]}.`,
        },
        // The host block, absent from this fixture until now, which is why the
        // two fields on it were never swept. With no other unrecognised
        // condition in the list they reach the WebSocket section's findings as
        // well as the Overview.
        host: { unmetCondition: SECRETS[6], remedy: SECRETS[7] },
      },
      live: {
        capabilities: [{ id: 'ws-sync', endpoint: '/sockets/sync' }],
        // The lane is deliberately UP in this fixture (`syncLaneEnabled: true`),
        // because the Overview suppresses live refusal reasons on a lane that
        // never came up — and a reason the panel never prints cannot leak, so a
        // sweep over a down lane is blind to this field by construction.
        unavailabilityReasons: ['sync-not-configured', SECRETS[6], SECRETS[7]],
        ticketAvailable: false,
        realtime: { attached: true, pushBridge: SECRETS[1], syncLane: SECRETS[0] },
      },
      /**
       * POISONED, and it was not always. This field was left clean for a while,
       * with a comment explaining that poisoning it would fail the sweep "as it
       * should" — a test that documented its own hole and then declined to fail.
       *
       * The hole was real: an operation name off the wire was echoed verbatim by
       * `diagnose()` ("This client does not implement <name>"), by
       * `remedyForClientGap` and by the capability matrix in the copyable report,
       * each of them behind `sanitizeServerCopy`. All three now name only the
       * operations this build itself declares and COUNT the rest, so the opaque
       * secret below is swept across all eight tabs and the report like every
       * other field.
       */
      protocol: { version: 1, serverOperations: ['SYNC_ITEMS', SECRETS[3]] },
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
      for (const fragment of SECRET_WINDOWS) {
        expect(text).not.toContain(fragment)
      }
    }

    await openSubtab('Copyable report')
    const report = reportText()
    for (const fragment of SECRET_WINDOWS) {
      expect(report).not.toContain(fragment)
    }
    expect(report).not.toMatch(/redis:\/\//)
    // The remedy still names the variable, without ever carrying its value.
    expect(report).toContain('REDIS_UNBOUND')
    // And the conditions, reasons and sub-gate condition this build cannot name
    // survive as counts rather than disappearing — which is what makes the
    // assertions above something other than the panel having gone quiet.
    expect(report).toContain('- Conditions this build does not recognise: 1')
    expect(report).toContain('- Reasons this build does not recognise: 2')
    // The recognised sub-gate condition is still NAMED — the admission is a
    // closed set, not a blanket refusal — while the server's prose beside it is
    // gone, which is what the window assertions above prove.
    expect(report).toContain('- FILES_V1 advertised: no (FILES_INTERNAL_URL)')
  })

  /**
   * *** A SERVER-SUPPLIED OPERATION NAME IS NEVER PRINTED — NOW IN EVERY PATH. ***
   *
   * The ROWS were always right: every row reading `protocol.serverOperations`
   * counts an unrecognised operation and never names it, because `safeEnum`
   * admits only this build's own closed list. The leak was everywhere else — the
   * Overview diagnosis (`diagnose()`), the remedy (`remedyForClientGap`) and the
   * capability matrix in the copyable report — and all three went through
   * `sanitizeServerCopy`, which `Remedy` was exempted from `SafeValue` on the
   * strength of.
   *
   * A denylist is the wrong mechanism at a trust boundary, and a live probe said
   * so precisely: `SECRETS[1]` was withheld as `[address withheld]` because it is
   * address-shaped, and `SECRETS[3]` — opaque, nothing to match — printed intact
   * on the Overview, in the WebSocket capability block's remedy and in the
   * copyable report, which exists to be pasted into an issue.
   *
   * So the rule is now the rows' rule everywhere: name only an operation this
   * build declares, count the rest. The assertion that `[address withheld]` is
   * ABSENT is the one that matters — its presence would mean the redactor had
   * been put back as the defence.
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
    // Withheld because it is never printed, not because a denylist matched its
    // shape. `SECRETS[3]` has no shape to match and used to print verbatim on
    // this exact path; `[address withheld]` must now be ABSENT, because its
    // presence would mean the redactor had been reinstated as the defence.
    expect(activePanel().textContent).not.toContain(SECRETS[1])
    expect(activePanel().textContent).not.toContain(SECRETS[3])
    expect(activePanel().textContent).not.toContain('[address withheld]')
    expect(activePanel().textContent).toContain('2 operations this build does not recognise')

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
