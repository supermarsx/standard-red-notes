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
  ApplicationEvent: { SignedIn: 'signed-in', SignedOut: 'signed-out' },
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
  ContentType: { TYPES: { File: 'SN|FileItem', Note: 'Note' } },
  // The file round trip names its throwaway object with the app's own generator.
  UuidGenerator: { GenerateUuid: () => `made-up-${++madeUpIdentifiers}` },
}))

let madeUpIdentifiers = 0

/**
 * The commit compiled into "this tab's code". A test run's bundle carries none,
 * so one is given here — fixed, and only ever compared with the marker a test
 * supplies. Against the default (unstamped) marker it changes nothing: the
 * server names no build, so there is nothing to compare with.
 */
jest.mock('@/Constants/BuildRevision', () => ({ WebBuildRevision: 'c'.repeat(40) }))

/**
 * The other tabs of the app, as they would answer a census. jsdom has no
 * BroadcastChannel, so without this the pane would always read "cannot ask";
 * a test that is about tabs sets the answer it needs.
 */
let mockOtherTabs: { otherTabs: number; othersOnSocket: number; othersStandingBy: number } | undefined
// A plain function and not a `jest.fn`: mock implementations are reset between
// tests here, and a reset `jest.fn` answers `undefined` instead of a promise.
jest.mock('@/Utils/TabCensus', () => ({ takeTabCensus: async () => mockOtherTabs }))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

import AdminDiagnosticsTab, { clockReadingFor } from './AdminDiagnosticsTab'
import { CHECK_IDS, CHECKS, type CheckId } from './diagnosticChecks'
import { SYNC_ITEMS_CAUSES } from './syncDiagnostics'
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

/**
 * The account's own stored-item total, as the GATEWAY sends it: wrapped in the
 * `{ meta, data }` envelope that both the HTTP proxy and the single-container
 * direct-call proxy put around every proxied service response. Wrapped on purpose
 * — reading the figure off the bare body is what made the pane report "the read
 * did not arrive" over a 200 on a live deployment.
 */
const storageUsagePayload = {
  meta: { auth: {}, server: {} },
  data: { itemBytesUsed: 41_943_040, itemsMeasured: 12, itemsUnmeasured: 0 },
}

/**
 * Every GET path this tab is allowed to reach, and the body each one answers.
 *
 * A single `mockResolvedValue` for all of them answered the diagnostics payload
 * to the storage read as well, which is a 200 carrying no figure — so the Space
 * block raised a failed-read finding in every test in this file that had nothing
 * to do with storage. Path-aware here, and the inventory below asserts the tab
 * reaches no path this map does not name.
 */
const GET_PATHS = {
  '/v1/admin/sync-diagnostics': { status: 200, ok: true, data: unavailablePayload },
} as const

/**
 * The paths this tab reads over PLAIN HTTP, bypassing the websocket control-plane
 * lane. `/v1/sockets/*` is refused on that lane and `/v1/items/*` is too, and in
 * both cases the refusal is not safe to fall back from — so a lane-first helper
 * fails exactly when the deployment is healthiest.
 */
const HTTP_ONLY_PATHS = {
  '/v1/sockets/sync/ticket': { status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } },
  '/v1/sockets/sync/capabilities': { status: 200, ok: true, data: { capabilities: [] } },
  '/v1/items/storage-usage': { status: 200, ok: true, data: storageUsagePayload },
  // The revision list of the one note the default account holds.
  '/v2/items/a-note/revisions': { status: 200, ok: true, data: [] },
  // The API server's own statement of which build it is. Unstamped, like the
  // default marker: a test that is about build identity supplies its own.
  '/healthcheck/readiness': {
    status: 200,
    ok: true,
    data: { status: 'ready', deployment: { revision: 'unstamped', version: 'unstamped' } },
  },
} as const

/**
 * A files service the round trip can really go round: it stores what is sent and
 * serves what it stored, and logs every operation with the identifier it named —
 * which is what lets a test say the check wrote one object, deleted that object,
 * and named nothing else.
 */
const filesApi = () => {
  const objects = new Map<string, Uint8Array[]>()
  const tokens = new Map<string, string>()
  const operations: [string, string][] = []
  const identifierOf = (token: string): string => tokens.get(token) as string

  return {
    objects,
    operations,
    createUserFileValetToken: jest.fn().mockImplementation(async (remoteIdentifier: string, operation: string) => {
      const token = `valet-${operation}-${tokens.size}`
      tokens.set(token, remoteIdentifier)
      operations.push([`authorize-${operation}`, remoteIdentifier])
      return token
    }),
    startUploadSession: jest.fn().mockImplementation(async (token: string) => {
      objects.set(identifierOf(token), [])
      operations.push(['open', identifierOf(token)])
      return { status: 200, data: { uploadId: 'upload-1' } }
    }),
    uploadFileBytes: jest
      .fn()
      .mockImplementation(async (token: string, _ownership: string, _chunkId: number, bytes: Uint8Array) => {
        objects.get(identifierOf(token))?.push(bytes.slice())
        operations.push(['send', identifierOf(token)])
        return true
      }),
    closeUploadSession: jest.fn().mockResolvedValue(true),
    downloadFile: jest
      .fn()
      .mockImplementation(
        async (params: {
          file: { remoteIdentifier: string }
          onBytesReceived: (bytes: Uint8Array) => Promise<void>
        }) => {
          operations.push(['read', params.file.remoteIdentifier])
          for (const chunk of objects.get(params.file.remoteIdentifier) ?? []) {
            await params.onBytesReceived(chunk)
          }
          return undefined
        },
      ),
    deleteFile: jest.fn().mockImplementation(async (token: string) => {
      objects.delete(identifierOf(token))
      operations.push(['delete', identifierOf(token)])
      return { status: 200, data: {} }
    }),
  }
}

type Answer = { status: number; ok: boolean; data: unknown }

/**
 * The three reads of the admin diagnostics endpoint, answering one thing.
 *
 * The PANE reads it over plain HTTP — a read on the socket lane carries no origin,
 * so the gateway cannot say whether this client's origin is admitted. The
 * control-plane CHECK reads it again through the lane-observing helper, which is
 * the one place the lane is the question. And the flags read still goes through
 * the ordinary lane-first helper. A test that says "the server answers X" means
 * all three, which is what its single stub used to mean.
 */
const answering = (
  answer: Answer,
  options: { carriedBy?: 'socket' | 'http'; http?: Readonly<Record<string, Answer>> } = {},
) => ({
  httpOnlyJsonRequest: jest.fn().mockImplementation(async (_method: string, path: string) => {
    if (path === '/v1/admin/sync-diagnostics') {
      return answer
    }
    if (options.http !== undefined && Object.hasOwn(options.http, path)) {
      return options.http[path]
    }
    return Object.hasOwn(HTTP_ONLY_PATHS, path)
      ? HTTP_ONLY_PATHS[path as keyof typeof HTTP_ONLY_PATHS]
      : { status: 404, ok: false, data: {} }
  }),
  serverGetJsonRequestObservingLane: jest.fn().mockResolvedValue({ ...answer, carriedBy: options.carriedBy ?? 'http' }),
  serverGetJsonRequest: jest.fn().mockResolvedValue(answer),
})

/**
 * A transport ledger that counts the app's own sync rounds, as the real one does.
 * The Sync round trip check reads the difference either side of `sync()`, so a
 * double whose `sync()` moves nothing would report "no sync round settled".
 */
const countingSync = (carrier: 'socket' | 'http' | 'failed' = 'http') => {
  const rounds = { socket: 0, http: 0, failed: 0 }

  return {
    sync: {
      isDatabaseLoaded: () => true,
      sync: jest.fn().mockImplementation(async () => {
        rounds[carrier] += 1
      }),
    },
    ledger: () => ({
      controlPlaneRejections: 0,
      controlPlaneRejectionsByStatus: { 401: 0, 498: 0 },
      fallbackCounts: {},
      laneStandDownCounts: {},
      syncRoundCounts: { ...rounds },
      transitions: [],
      transitionsDropped: 0,
      recordingForMs: 60_000,
    }),
  }
}

const makeApplication = (
  overrides: Record<string, unknown> = {},
  options: { syncCarrier?: 'socket' | 'http' | 'failed' } = {},
) => {
  const counting = countingSync(options.syncCarrier)
  const application = { ...makeApplicationWith(counting), ...overrides }
  // A GETTER on the finished object, not a spread value: the check reads the
  // counters either side of `sync()`, and a snapshot taken at construction would
  // read the same on both sides for ever.
  if (!Object.hasOwn(overrides, 'syncTransportLedger')) {
    Object.defineProperty(application, 'syncTransportLedger', { get: () => counting.ledger(), enumerable: true })
  }

  return application
}

const makeApplicationWith = (counting: ReturnType<typeof countingSync>) => ({
  serverGetJsonRequest: jest.fn().mockImplementation(async (path: string) => {
    return Object.hasOwn(GET_PATHS, path)
      ? GET_PATHS[path as keyof typeof GET_PATHS]
      : { status: 404, ok: false, data: {} }
  }),
  serverGetJsonRequestObservingLane: jest.fn().mockImplementation(async (path: string) => {
    return {
      ...(Object.hasOwn(GET_PATHS, path)
        ? GET_PATHS[path as keyof typeof GET_PATHS]
        : { status: 404, ok: false, data: {} }),
      carriedBy: 'http',
    }
  }),
  serverJsonRequest: jest
    .fn()
    .mockResolvedValue({ status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } }),
  // The socket-handshake probes must NOT use the RPC-lane helpers: `/v1/sockets/*`
  // is refused on that lane and the refusal is not safe-to-fallback, so those
  // helpers throw when a socket is live. This double answers only the ticket and
  // capability paths, and the tests below pin which helper each probe reaches for.
  httpOnlyJsonRequest: jest.fn().mockImplementation(async (_method: string, path: string) => {
    if (Object.hasOwn(GET_PATHS, path)) {
      return GET_PATHS[path as keyof typeof GET_PATHS]
    }
    return Object.hasOwn(HTTP_ONLY_PATHS, path)
      ? HTTP_ONLY_PATHS[path as keyof typeof HTTP_ONLY_PATHS]
      : { status: 404, ok: false, data: {} }
  }),
  // The SAME method the Server pane calls, read additively for the Database
  // section. Nothing is migrated out of that pane and no new route exists.
  legacyApi: {
    adminGetServerStatus: jest.fn().mockResolvedValue({ status: 200, data: serverStatusPayload }),
    ...filesApi(),
  },
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
  sync: counting.sync,
  syncTransportLedger: counting.ledger(),
  // One note, so there is a revision history to ask for; no files.
  items: { getItems: (type?: string) => (type === 'Note' ? [{ uuid: 'a-note' }] : []) },
  syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
  // The sync worker of this page's own build (the BuildRevision mock above).
  syncTransportWorkerBuild: { state: 'reported', revision: 'c'.repeat(40) },
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  mockOtherTabs = undefined
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

/**
 * The cells of one summary row, found by the section it routes to.
 *
 * In reading order: the STATUS chip, the section title, how many rows carry each
 * status, the one reason the section has the status it has, and the control that
 * opens it.
 */
const routerRow = (section: string): string[] => {
  const row = container.querySelector(`[data-diagnostics-router-row="${section}"]`)
  expect(row).not.toBeNull()

  return [...(row?.querySelectorAll('[data-diagnostics-router-cell]') ?? [])].map((cell) => cell.textContent ?? '')
}

/**
 * The VERDICT on one summary row, read off the chip's attribute.
 *
 * The word on a chip is copy and may change; `data-diagnostics-status` is the
 * fact, and it is what every "which status is this" assertion below reads.
 */
const routerStatus = (section: string): string | null =>
  container
    .querySelector(`[data-diagnostics-router-row="${section}"] [data-diagnostics-status]`)
    ?.getAttribute('data-diagnostics-status') ?? null

/** The verdict on the pane's headline. */
const headlineStatus = (): string | null =>
  container.querySelector('[data-diagnostics-headline]')?.getAttribute('data-diagnostics-headline') ?? null

/** The verdict on one row of the open section panel, read off its chip. */
const sectionRowStatus = (label: string): string | null => {
  const row = [...activePanel().querySelectorAll('table tbody tr')].find(
    (element) => element.querySelector('td')?.textContent === label,
  )
  expect(row).toBeDefined()

  return row?.getAttribute('data-diagnostics-row-status') ?? null
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
   * The unmapped-`Icon` hazard, swept across the WHOLE pane. An `Icon` whose name
   * is missing from `IconNameToSvgMapping` renders that name as text inside a
   * `label`, and neither tsc nor a spec that mocks `Icon` can see it. This file
   * does not mock `Icon`. The pane used to assert it drew no svg at all; every
   * status has an icon now, so the assertion is the hazard itself — on every tab,
   * every status chip drew exactly one glyph and nothing fell back to a label.
   */
  it('draws a real glyph for every status chip on every tab, and falls back to a name for none', async () => {
    await renderTab(makeApplication())

    let chipsSeen = 0
    for (const label of ALL_SUBTABS) {
      await openSubtab(label)
      const chips = [...container.querySelectorAll('[data-diagnostics-status]')]
      chipsSeen += chips.length
      for (const chip of chips) {
        expect(chip.querySelectorAll('svg')).toHaveLength(1)
      }
      expect(container.querySelectorAll('label')).toHaveLength(0)
      // And no icon exists that is not a status chip's.
      expect(container.querySelectorAll('svg')).toHaveLength(chips.length)
    }
    expect(chipsSeen).toBeGreaterThan(50)
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
      expect(routerRow(id)[1]).toBe(SECTION_TITLE[id])
      // A status, counts, and a reason — none of them empty.
      expect(routerStatus(id)).not.toBeNull()
      expect(routerRow(id)[2]).toMatch(/^\d+ /)
      expect(routerRow(id)[3].length).toBeGreaterThan(10)
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

    expect(routerStatus('websocket')).toBe('broken')
    expect(routerRow('websocket')[0]).toBe('Not working')
    // And the headline over it cannot be gentler than its worst section.
    expect(headlineStatus()).toBe('broken')
  })

  it('agrees, verdict for verdict, with the chip each section renders on its own header', async () => {
    await renderTab(makeApplication())

    const fromRouter = SECTION_IDS.map((id) => routerStatus(id))

    const fromSections: string[] = []
    for (const id of SECTION_IDS) {
      await openSubtab(SECTION_TITLE[id])
      const header = activePanel().querySelector(`[data-diagnostics-section="${id}"]`)
      expect(header).not.toBeNull()
      // The section header is `<Subtitle>{title}</Subtitle><StatusChip …/>`, so
      // the section's own status is the first status chip inside its wrapper.
      fromSections.push(
        header?.querySelector('[data-diagnostics-status]')?.getAttribute('data-diagnostics-status') ?? '',
      )
    }

    expect(fromSections).toEqual(fromRouter)
    // Not vacuous: the five are real verdicts, and not all the same one.
    expect(fromRouter.every((status) => status !== null && status.length > 0)).toBe(true)
  })

  it('says what an absent verdict means instead of leaving a row that reads like a pass', async () => {
    const application = makeApplication({
      ...answering({ status: 404, ok: false, data: {} }),
      // No transport status either: with one, the HTTP_ONLY reading is a real
      // measurement and the section is honestly "Degraded" rather than unknown.
      syncTransportStatus: undefined,
    })
    await renderTab(application)

    // Nothing was read and nothing measured, so the section established nothing.
    // Whichever sections lost their readings say so by NAMING what is unknown,
    // rather than saying only that something is.
    const unknown = SECTION_IDS.filter((id) => routerStatus(id) === 'undetermined')
    expect(unknown.length).toBeGreaterThan(0)
    for (const id of unknown) {
      expect(routerRow(id)[0]).toBe('Unknown')
      expect({ id, reason: /^Unknown: .+/.test(routerRow(id)[3]) }).toEqual({ id, reason: true })
    }
    // No section is OK on the strength of having read nothing, and so the
    // headline is not either.
    for (const id of SECTION_IDS) {
      expect({ id, healthy: routerStatus(id) === 'healthy' }).toEqual({ id, healthy: false })
    }
    expect(headlineStatus()).not.toBe('healthy')
  })

  it('keeps the cross-cutting diagnosis on the Overview, beside the router', async () => {
    const text = await renderTab(makeApplication())

    expect(text).toContain('Realtime lane diagnosis')
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
        ...answering({
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
        ...answering({
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
        ...answering({
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
    // A client build with no realtime transport installed has no ledger to read.
    const text = await openWebsocket(makeApplication({ syncTransportLedger: undefined }))

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
        ...answering({
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
    // On its own it is never OK. What it reads instead depends on the one direct
    // observation of a socket from this origin — and this tab is on HTTP here, so
    // the condition holds while the socket does not: no verdict from this row.
    expect(sectionRowStatus('This client’s origin admitted')).toBe('informational')
    expect(sectionRowStatus('This client’s origin admitted')).not.toBe('healthy')
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
        ...answering({
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
        ...answering({
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
        ...answering({
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
        ...answering({
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
        ...answering({
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
        ...answering({ status: 200, ok: true, data: { ...unavailablePayload, deployment: undefined } }),
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
    expect(sectionRow('Why the read failed')[1]).toBe('nothing to report (the read answered)')
    expect(sectionRowStatus('Why the read failed')).toBe('not-applicable')
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
        ...answering({
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
    expect(sectionRow('Database connection state')[2]).toBe('Not working')
    expect(sectionRow('Database write probe')[1]).toBe('accepted')
    // Narrow positive: accepted is a necessary condition, so it is capped — and
    // on this tab, whose sync does not ride a socket, there is no real write this
    // pane can watch land without changing the operator's data. So it is context
    // and says why, rather than an "unknown" nothing here could ever resolve.
    expect(sectionRow('Database write probe')[2]).toBe('Info')
    expect(sectionRow('Schema migrations')[1]).toBe('yes')
    // Absent pool figures inside a block that DID report: the driver keeps none.
    expect(sectionRow('Connection pool in use')[1]).toBe('not available here (this database driver keeps no pool)')
    expect(sectionRow('Queue separation')[1]).toBe('inherited-shared-queue')
    expect(sectionRow('Queue separation')[2]).toBe('Not working')
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
        ...answering({
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

  /**
   * The GET paths this tab reaches, as a CLOSED inventory.
   *
   * It used to assert a single path, which was both the inventory and the only
   * entry. A second read now exists — the account's stored-item total, which is
   * the figure the Space block was missing entirely — so the assertion names
   * both and nothing else. Still a tripwire against a route invented here rather
   * than reused: a path outside this list fails, and so does one that is in the
   * list but never actually called, because a dead entry would quietly widen it.
   */
  /**
   * The GET paths this tab reaches, as a CLOSED inventory per helper.
   *
   * It used to assert a single path, which was both the inventory and the only
   * entry. A second read now exists — the account's stored-item total, which is
   * the figure the Space block was missing entirely — and it goes over the
   * HTTP-only helper because its path is refused on the websocket lane. Asserted
   * per HELPER rather than as one list, because WHICH helper a read uses is the
   * thing that broke: the ordinary one fails on this path exactly when the socket
   * is healthy.
   */
  it('reaches only the reads it declares, over the helper each one needs', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(application.legacyApi.adminGetServerStatus).toHaveBeenCalledTimes(1)

    const overLane = new Set(application.serverGetJsonRequest.mock.calls.map(([path]: [string]) => path))
    const overHttp = new Set(application.httpOnlyJsonRequest.mock.calls.map(([, path]: [string, string]) => path))

    // The pane's own read of the diagnostics endpoint is plain HTTP: over the
    // socket lane it arrives with no origin, and the gateway then cannot say
    // whether this client's origin is admitted. The lane-first helper asks for
    // nothing here; the one lane-observing read is the control-plane CHECK,
    // whose whole question is which lane carries it.
    expect([...overLane].sort()).toEqual([])
    expect(overHttp.has('/v1/admin/sync-diagnostics')).toBe(true)
    expect(application.serverGetJsonRequestObservingLane.mock.calls.map(([path]: [string]) => path)).toEqual([
      '/v1/admin/sync-diagnostics',
    ])
    expect(overHttp.has('/v1/items/storage-usage')).toBe(true)
    // And the lane-first helper must NEVER be the one that asks for it: that is
    // the regression, and it is invisible in any assertion over a merged list.
    expect(overLane.has('/v1/items/storage-usage')).toBe(false)
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

    expect(sectionRow('Admin status endpoint')[1]).toBe('answered with 403; status data unavailable')
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
    // The account in this fixture holds an ACTIVE plan, so the older server's one
    // word for "no live row" is resolved to the case it is in: no row at all.
    // Printing it as it arrived put "no-active-subscription" beside "active".
    expect(sectionRow('Where the file allowance comes from')[1]).toBe('no-subscription-record')
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
  /* The account's own STORED-ITEM total, which is most of its storage         */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE OPERATOR ASKED TWICE FOR THIS FIGURE. ***
   *
   * The Space block reported uploaded-FILE bytes and nothing else, so an account
   * whose storage is notes read 0 MB at best and nothing at all at worst. These
   * tests drive the real component against the real section builder, so a wiring
   * gap — a reader that never ran, an envelope read off the wrong level, a 404
   * rendered as a failure — fails here rather than on the operator's screen.
   */
  const withGetPaths = (paths: Record<string, unknown>) => ({
    httpOnlyJsonRequest: jest.fn().mockImplementation(async (_method: string, path: string) => {
      if (Object.hasOwn(paths, path)) {
        return paths[path]
      }
      return Object.hasOwn(HTTP_ONLY_PATHS, path)
        ? HTTP_ONLY_PATHS[path as keyof typeof HTTP_ONLY_PATHS]
        : { status: 404, ok: false, data: {} }
    }),
  })

  it('reports the account total from the item figure and the file figure together', async () => {
    await openAccount()

    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('40')
    expect(sectionRow('Item usage read')[1]).toBe('reported')
    expect(sectionRow('Item byte total completeness')[1]).toBe('every item measured')
    // 40 MB of items + the fixture's 1 MB of file bytes, reduced AFTER the sum.
    expect(sectionRow('Total account storage, whole MB')[1]).toBe('41')
    expect(sectionRow('Server file bytes used, whole MB')[1]).toBe('1')
    expect(sectionRow('What the total counts')[1]).toBe('items-and-files')
  })

  /**
   * *** THE ENVELOPE, ASSERTED AT BOTH LEVELS. ***
   *
   * The gateway wraps every proxied service response in `{ meta, data }`, and the
   * admin endpoints this same tab reads are answered BY the gateway and are NOT
   * wrapped — so a reader written against either shape alone works in testing and
   * reports "the read did not arrive" against the other. It was measured doing
   * exactly that on a live container.
   */
  it('reads the figure through the gateway envelope and off a bare body alike', async () => {
    await openAccount(
      makeApplication(
        withGetPaths({
          '/v1/items/storage-usage': {
            status: 200,
            ok: true,
            data: { itemBytesUsed: 8_388_608, itemsMeasured: 3, itemsUnmeasured: 0 },
          },
        }),
      ),
    )

    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('8')
    expect(sectionRow('Item usage read')[1]).toBe('reported')
  })

  /**
   * *** 404 IS A SERVER OLDER THAN THE FIGURE, NOT A FAULT. *** It is the
   * commonest reading while a fleet is being upgraded, and it is the reading that
   * answers "would a redeploy fix this". Rendering it as a failed read sends that
   * operator to debug a syncing service that is working.
   */
  it('reports a 404 as a server that does not carry the figure, not as a failed read', async () => {
    const text = await openAccount(
      makeApplication(withGetPaths({ '/v1/items/storage-usage': { status: 404, ok: false, data: {} } })),
    )

    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('not answered by this server build')
    expect(sectionRow('Item usage read')[1]).toBe('endpoint-absent')
    expect(sectionRow('Total account storage, whole MB')[1]).toBe('not reported')
    expect(text).toContain('This server build does not report how much this account has stored')
    expect(text).not.toContain('The stored-item total for this account could not be read')
  })

  it('reports a refused read as a failed read, which a 404 is not', async () => {
    const text = await openAccount(
      makeApplication(withGetPaths({ '/v1/items/storage-usage': { status: 500, ok: false, data: {} } })),
    )

    expect(sectionRow('Item usage read')[1]).toBe('read-threw')
    expect(text).toContain('The stored-item total for this account could not be read')
    expect(text).not.toContain('This server build does not report how much this account has stored')
  })

  /**
   * A 200 carrying no usable figure is still a read that produced none, and it
   * must never become a zero: 0 MB is the exact answer the operator was already
   * given by a pane that was not measuring notes at all.
   */
  it('does not let a 200 carrying no figure become a zero', async () => {
    await openAccount(
      makeApplication(withGetPaths({ '/v1/items/storage-usage': { status: 200, ok: true, data: { data: {} } } })),
    )

    expect(sectionRow('Server item bytes used, whole MB')[1]).not.toBe('0')
    expect(sectionRow('Item usage read')[1]).toBe('read-threw')
    expect(sectionRow('Total account storage, whole MB')[1]).toBe('not reported')
  })

  it('does not let an unparseable item figure become a byte count', async () => {
    await openAccount(
      makeApplication(
        withGetPaths({
          '/v1/items/storage-usage': {
            status: 200,
            ok: true,
            data: { data: { itemBytesUsed: 'quite a lot', itemsUnmeasured: 0 } },
          },
        }),
      ),
    )

    expect(sectionRow('Item usage read')[1]).toBe('read-threw')
    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('the read did not arrive')
  })

  /**
   * *** A MEASURED ZERO SURVIVES THE WHOLE WIRING. *** An empty account really is
   * storing nothing and the row must say `0`, which is the one assertion that
   * fails if a reader ever starts treating `0` as "nothing arrived".
   */
  it('reports a genuinely empty account as a measured zero', async () => {
    await openAccount(
      makeApplication(
        withGetPaths({
          '/v1/items/storage-usage': {
            status: 200,
            ok: true,
            data: { data: { itemBytesUsed: 0, itemsMeasured: 0, itemsUnmeasured: 0 } },
          },
        }),
      ),
    )

    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('0')
    expect(sectionRow('Item usage read')[1]).toBe('reported')
    expect(sectionRow('Item byte total completeness')[1]).toBe('every item measured')
  })

  /**
   * The unmeasured COUNT is reduced to a boolean at this boundary, because the
   * section has nowhere to put a population and must not acquire one. Both halves
   * are asserted: the boolean is derived, and the count itself never appears.
   */
  it('reduces the unmeasured item count to a boolean and never prints the count', async () => {
    const text = await openAccount(
      makeApplication(
        withGetPaths({
          '/v1/items/storage-usage': {
            status: 200,
            ok: true,
            data: { data: { itemBytesUsed: 9_437_184, itemsMeasured: 4812, itemsUnmeasured: 7391 } },
          },
        }),
      ),
    )

    expect(sectionRow('Item byte total completeness')[1]).toBe('some items unmeasured')
    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('9')
    expect(text).toContain('some of this account’s items carry no recorded size')
    expect(text).not.toContain('4812')
    expect(text).not.toContain('7391')
  })

  it('claims nothing about completeness when the server sent no counts', async () => {
    await openAccount(
      makeApplication(
        withGetPaths({
          '/v1/items/storage-usage': { status: 200, ok: true, data: { data: { itemBytesUsed: 9_437_184 } } },
        }),
      ),
    )

    expect(sectionRow('Item byte total completeness')[1]).toBe('not reported')
    expect(sectionRow('Server item bytes used, whole MB')[1]).toBe('9')
  })

  /* ------------------------------------------------------------------------ */
  /* The local usage figure, for the soft-cap row that could never fill        */
  /* ------------------------------------------------------------------------ */

  /**
   * *** A FIELD THE SECTION DECLARED AND NOTHING EVER SUPPLIED. ***
   *
   * `localUsageBytes` and the row comparing it against the user's advisory cap
   * have existed since the block was written, and no caller filled it — so that
   * row read "not reported" on every deployment while the row above it reported
   * the cap perfectly. jsdom has no `navigator.storage`, so the estimate is
   * installed here; the test immediately below asserts the absent case, which is
   * what an unsupported browser really does.
   */
  it('fills the local usage figure and the soft-cap comparison from the storage estimate', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 62_914_560, quota: 1_073_741_824 }) },
      configurable: true,
    })

    try {
      await openAccount(makeApplication({ getPreference: jest.fn().mockReturnValue(10 * 1_048_576) }))

      expect(sectionRow('Local usage, whole MB')[1]).toBe('60')
      expect(sectionRow('Local usage soft cap')[1]).toBe('set')
      expect(sectionRow('Local usage against the soft cap')[1]).toBe('over the cap')
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'storage', original)
      } else {
        delete (navigator as unknown as Record<string, unknown>).storage
      }
    }
  })

  it('leaves the local usage absent rather than zero on a browser that cannot be asked', async () => {
    await openAccount(makeApplication({ getPreference: jest.fn().mockReturnValue(10 * 1_048_576) }))

    expect(sectionRow('Local usage, whole MB')[1]).toBe('not reported')
    expect(sectionRow('Local usage, whole MB')[1]).not.toBe('0')
    expect(sectionRow('Local usage against the soft cap')[1]).toBe('not reported')
  })

  /**
   * And with the preference at its documented default — `0`, meaning no cap —
   * the comparison says so from the cap alone rather than leaving the row blank.
   * That emptiness was the commonest reading in the fleet and it invited a hunt
   * for a read that had not failed.
   */
  it('says there is no cap to exceed when the user set none, even with no usage figure', async () => {
    await openAccount()

    expect(sectionRow('Local usage soft cap')[1]).toBe('no cap')
    expect(sectionRow('Local usage against the soft cap')[1]).toBe('no cap to exceed')
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

  /**
   * *** THE SHAPE THE GATEWAY REALLY SENDS. *** The route is proxied to the auth
   * service, so the flags arrive inside `{ meta, data: { flags } }`. The read
   * looked for `flags` at the top of the body, found nothing, and both rows read
   * "the read carried no flags" on every deployment — captured live on a compose
   * stack and on a single container.
   */
  it('reads the flags through the gateway’s envelope, which is how they really arrive', async () => {
    const application = makeApplication({
      sessions: {
        isSignedIn: () => true,
        isSignedIntoFirstPartyServer: () => true,
        getUser: () => ({ uuid: FLAG_READ_USER_UUID }),
      },
      serverGetJsonRequest: jest.fn().mockImplementation(async (path: string) => {
        return path.includes('/feature-flags')
          ? {
              status: 200,
              ok: true,
              data: {
                meta: { auth: { userUuid: FLAG_READ_USER_UUID } },
                data: { flags: { LIVE_SYNC_ENABLED: null, COLLABORATION_ENABLED: 'false' } },
              },
            }
          : { status: 404, ok: false, data: {} }
      }),
    })
    await openAccount(application)

    expect(sectionRow('Live sync for this account')[1]).toBe('enabled')
    expect(sectionRow('Collaboration permitted for this account')[1]).toBe('disabled')
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
        ...answering({ status: 403, ok: false, data: {} }),
      }),
    )

    expect(sectionRow('Admin role, as the server answered')[1]).toBe('refused by the server (403)')
    expect(text).toContain('This session does not carry the admin role')
  })

  it('reports a 401 as not establishing the role at all, rather than as a refusal', async () => {
    const text = await openAccount(
      makeApplication({
        ...answering({ status: 401, ok: false, data: {} }),
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

    expect(sectionRow('Roles held by this account')[1]).toBe(
      'not available here (no client surface exposes the role names)',
    )
    expect(sectionRowStatus('Roles held by this account')).toBe('not-applicable')
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
        ...answering({ status: 200, ok: true, data: { ...unavailablePayload, capturedAt: undefined } }),
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

    await clickButton('Run all checks')
    const text = await openSubtab('Checks')

    expect(text).toContain('Socket ticket')
    expect(text).toContain('SYNC_DISABLED')
    expect(text).toContain('This tab’s live socket')
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
    await clickButton('Run all checks')

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
  it('reports a tab that does not own the socket as not applicable here, never as a failure', async () => {
    const application = makeApplication({
      syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [], fallbackReason: 'multi-tab-not-owner' },
    })
    await renderTab(application)

    await clickButton('Run all checks')
    const text = await openSubtab('Checks')
    const item = activePanel().querySelector('[data-diagnostics-probe="negotiation"]')

    expect(item?.getAttribute('data-diagnostics-probe-status')).toBe('not-applicable')
    expect(item?.textContent).toContain('not available here (another tab holds the socket lane)')
    expect(item?.textContent).toContain('Another tab of this account owns the socket lane')
    expect(item?.textContent).toContain('Expected, and not a fault')
    // The summary line stops counting it against the run, in either direction.
    // TWO, not one: this fixture's marker is unstamped, so the app-shell check
    // has no build to compare with in every test of this file. The second is
    // the live-socket check this test is about.
    expect(text).toContain('2 had nothing to test here')
    expect(item?.textContent).not.toContain('on HTTP:')
  })

  /**
   * A fallback that IS a fault, and it is DEGRADED — not a pass, not "nothing to
   * test here", and not a failure either. The app is working: every save goes out
   * as an HTTP request. A screen that called that "not working" sent operators
   * looking for an outage while their notes were syncing.
   */
  it('reports every fallback that IS a fault as degraded, naming the state and the cause', async () => {
    for (const fallbackReason of ['proxy-failed', 'auth-failed', 'worker-error', 'capability-unavailable'] as const) {
      const application = makeApplication({
        syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [], fallbackReason },
      })
      await renderTab(application)

      await clickButton('Run all checks')
      const text = await openSubtab('Checks')
      const item = activePanel().querySelector('[data-diagnostics-probe="negotiation"]')

      expect(item?.getAttribute('data-diagnostics-probe-status')).toBe('degraded')
      expect(item?.textContent).toContain(`on HTTP: HTTP_FALLBACK ${fallbackReason}`)
      expect(item?.textContent).toContain('The app keeps working over HTTP')
      // One — the app-shell check, against this fixture's unstamped marker — and
      // NOT two: a fallback that is a fault is counted, never skipped.
      expect(text).toContain('1 had nothing to test here')
      expect(text).not.toContain('2 had nothing to test here')
      expect(item?.textContent).not.toContain('another tab')
    }
  })

  it('reports a fallback with no reason, and no transport at all, as degraded too', async () => {
    const noReason = makeApplication({ syncTransportStatus: { state: 'HTTP_FALLBACK', operations: [] } })
    await renderTab(noReason)
    await clickButton('Run all checks')
    await openSubtab('Checks')
    let item = activePanel().querySelector('[data-diagnostics-probe="negotiation"]')
    expect(item?.getAttribute('data-diagnostics-probe-status')).toBe('degraded')
    expect(item?.textContent).toContain('on HTTP: HTTP_FALLBACK')

    const noTransport = makeApplication({ syncTransportStatus: undefined })
    await renderTab(noTransport)
    await clickButton('Run all checks')
    const text = await openSubtab('Checks')
    item = activePanel().querySelector('[data-diagnostics-probe="negotiation"]')
    expect(item?.getAttribute('data-diagnostics-probe-status')).toBe('degraded')
    expect(text).toContain('No realtime transport is installed in this client')
    expect(text).toContain('1 had nothing to test here')
    expect(text).not.toContain('2 had nothing to test here')
  })

  /**
   * *** THE SECOND TAB. *** Another tab of the account holds the socket and this
   * one stands by on HTTP — by design. Every check this tab can run passes, the
   * section says where the tab stands and who holds the lane, and nothing on the
   * pane calls it a fault.
   */
  describe('a tab that is standing by', () => {
    const standingBy = { state: 'HTTP_FALLBACK', operations: [], fallbackReason: 'multi-tab-not-owner' }

    it('says another tab holds the socket, that it answered, and raises nothing', async () => {
      mockOtherTabs = { otherTabs: 1, othersOnSocket: 1, othersStandingBy: 0 }
      await renderTab(makeApplication({ syncTransportStatus: standingBy }))
      await openSubtab('WebSocket')

      expect(sectionRow('This tab on the socket lane')[1]).toBe('standing by for another tab')
      expect(sectionRow('Other tabs of this app that answered')[1]).toBe('1')
      expect(sectionRow('Other tabs holding a socket')[1]).toBe('1')
      expect(sectionRow('The tab this one is standing by for')[1]).toBe('a tab that answered')
      expect(sectionRowStatus('This tab’s live socket')).toBe('not-applicable')
      expect(activePanel().textContent).not.toContain('This tab is standing by for a tab that did not answer')
    })

    it('says so when no open tab admits to holding the socket', async () => {
      mockOtherTabs = { otherTabs: 0, othersOnSocket: 0, othersStandingBy: 0 }
      await renderTab(makeApplication({ syncTransportStatus: standingBy }))
      await openSubtab('WebSocket')

      expect(sectionRow('The tab this one is standing by for')[1]).toBe('no tab that answered')
      expect(activePanel().textContent).toContain('This tab is standing by for a tab that did not answer')
    })

    it('says it cannot ask on a browser with no way to ask its other tabs', async () => {
      mockOtherTabs = undefined
      await renderTab(makeApplication({ syncTransportStatus: standingBy }))
      await openSubtab('WebSocket')

      expect(sectionRow('Other tabs of this app that answered')[1]).toBe(
        'not available here (this browser cannot ask its other tabs)',
      )
    })
  })

  /**
   * *** THE STALE SHELL, END TO END. *** The server's marker names a newer commit
   * than the one compiled into this tab's code. It is on the Environment section
   * as a row, it turns the section amber, and it is a card saying to reload —
   * with no check having been run by anybody.
   */
  describe('build identity', () => {
    const THIS_TAB = 'c'.repeat(40)
    const NEWER = 'd'.repeat(40)
    const serving = (revision: string) => {
      ;(globalThis as { fetch?: unknown }).fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ revision, version: `src-${revision.slice(0, 12)}` }) })
    }
    const serverBuiltFrom = (revision: string) =>
      answering(
        { status: 200, ok: true, data: unavailablePayload },
        {
          http: {
            '/healthcheck/readiness': {
              status: 200,
              ok: true,
              data: { status: 'ready', deployment: { revision, version: `src-${revision.slice(0, 12)}` } },
            },
          },
        },
      )

    it('says this tab runs the build the server serves when the two commits agree', async () => {
      serving(THIS_TAB)
      await renderTab(makeApplication(serverBuiltFrom(THIS_TAB)))
      await openSubtab('Environment & setup')

      expect(sectionRow('App shell this tab is running')[1]).toBe('this tab runs the build the server serves')
      expect(sectionRowStatus('App shell this tab is running')).toBe('healthy')
      expect(sectionRow('Web app and server are one build')[1]).toBe('same build')
      expect(sectionRowStatus('Web app and server are one build')).toBe('healthy')
    })

    it('reports a tab running an older build than the server serves, and says to reload', async () => {
      serving(NEWER)
      await renderTab(makeApplication(serverBuiltFrom(NEWER)))
      await openSubtab('Environment & setup')

      expect(sectionRow('App shell this tab is running')[1]).toBe(
        `stale: this tab runs ${THIS_TAB} and the server serves ${NEWER}`,
      )
      expect(sectionRowStatus('App shell this tab is running')).toBe('degraded')
      expect(activePanel().textContent).toContain('This tab is running an older build than the server serves')
      expect(activePanel().textContent).toContain('Reload this tab')
      // The web app and the server ARE one build here; only this tab is behind.
      expect(sectionRowStatus('Web app and server are one build')).toBe('healthy')
    })

    it('reports a web app and an API server that were deployed from different commits', async () => {
      serving(THIS_TAB)
      await renderTab(makeApplication(serverBuiltFrom(NEWER)))
      await openSubtab('Environment & setup')

      expect(sectionRow('Web app and server are one build')[1]).toBe(
        `different builds: web app ${THIS_TAB} · server ${NEWER}`,
      )
      expect(sectionRowStatus('Web app and server are one build')).toBe('degraded')
      expect(activePanel().textContent).toContain('The web app and the API server are different builds')
      expect(sectionRowStatus('App shell this tab is running')).toBe('healthy')
    })
  })

  /**
   * *** A SERVER THAT TAKES THE REQUEST AND NEVER ANSWERS. *** Measured on a real
   * stack with Redis stopped under an open pane: the capability request was
   * accepted and never replied to, the run sat on "Running 1 of 6…" indefinitely,
   * and the five checks behind it were never reached. A check now ends at its
   * deadline, says so, and the run goes on.
   */
  it('ends a check whose request is never answered, reports it, and runs the checks behind it', async () => {
    const never = new Promise<never>(() => undefined)
    const application = makeApplication()
    const answer = application.httpOnlyJsonRequest.getMockImplementation() as (...args: unknown[]) => Promise<unknown>
    application.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/sockets/sync/capabilities' ? never : answer(method, path)
    })

    await renderTab(application)
    // The run that starts when the pane opens is sitting on the first check.
    expect(container.querySelector('[data-diagnostics-progress]')?.textContent).toContain(
      'Now running: Capability descriptor',
    )

    await act(async () => {
      jest.advanceTimersByTime(20_000)
    })
    await settle()
    await settle()

    await openSubtab('WebSocket')
    expect(sectionRow('Capability descriptor')[1]).toBe('no answer within 20 s')
    expect(sectionRowStatus('Capability descriptor')).toBe('broken')
    // The checks BEHIND it ran: the run did not die with the one that hung.
    expect(sectionRowStatus('Authenticated control-plane read')).not.toBe('untested')
    await openSubtab('Database & internal comms')
    expect(sectionRow('Sync round trip')[1]).toBe('completed over HTTP')
    expect(container.querySelector('[data-diagnostics-progress]')).toBeNull()
  })

  it('says the pane’s own read did not answer, instead of leaving an old reading on screen', async () => {
    const never = new Promise<never>(() => undefined)
    const application = makeApplication()
    const answer = application.httpOnlyJsonRequest.getMockImplementation() as (...args: unknown[]) => Promise<unknown>
    application.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/admin/sync-diagnostics' ? never : answer(method, path)
    })

    await renderTab(application)
    await act(async () => {
      jest.advanceTimersByTime(20_000)
    })
    await settle()

    expect(container.textContent).toContain('The sync diagnostics endpoint did not answer within 20 seconds')
  })

  /**
   * *** OPENING THE PANE WRITES NOTHING. *** The checks that run on open are the
   * read-only ones. No ticket is minted and no file is stored until an operator
   * presses a button that says so.
   */
  it('writes nothing at all until an operator starts a run', async () => {
    const application = makeApplication()
    await renderTab(application)

    expect(application.legacyApi.operations).toEqual([])
    expect(application.httpOnlyJsonRequest.mock.calls.filter(([method]: [string]) => method === 'POST')).toEqual([])
    expect(application.serverJsonRequest).not.toHaveBeenCalled()
  })

  /**
   * *** AND A RUN WRITES EXACTLY TWO THINGS. *** One ticket, never redeemed; and
   * one throwaway object under an identifier the check made up, which it deletes.
   * Asserted as the whole list of file operations, in order, so a check that
   * starts naming a second object — or stops deleting the first — fails here.
   */
  it('writes one ticket and one throwaway object in a run, and deletes the object', async () => {
    const application = makeApplication()
    await renderTab(application)
    await clickButton('Run all checks')

    const operations = application.legacyApi.operations
    const identifier = operations[0]?.[1]
    expect(identifier).toMatch(/^made-up-\d+$/)
    expect(operations).toEqual([
      ['authorize-write', identifier],
      ['open', identifier],
      ['send', identifier],
      ['send', identifier],
      ['authorize-read', identifier],
      ['read', identifier],
      ['authorize-delete', identifier],
      ['delete', identifier],
    ])
    // Nothing is left on the files service.
    expect(application.legacyApi.objects.size).toBe(0)

    await openSubtab('Checks')
    const transfer = activePanel().querySelector('[data-diagnostics-probe="file-transfer"]')
    expect(transfer?.getAttribute('data-diagnostics-probe-status')).toBe('healthy')
    expect(transfer?.textContent).toContain('stored, read back intact over HTTP · deleted')

    // Only the single, self-expiring ticket mint may POST, and only to /ticket.
    for (const [method, path] of application.httpOnlyJsonRequest.mock.calls) {
      if (method === 'POST') {
        expect(path).toBe('/v1/sockets/sync/ticket')
      }
    }
    for (const [path] of application.serverGetJsonRequest.mock.calls) {
      expect(path).toBe('/v1/admin/sync-diagnostics')
    }
    // The HTTP-only helper's calls, as an exact (method, path) allow-list. The
    // METHOD belongs in it: this helper accepts POST, the socket-ticket probe
    // legitimately uses one — minting a one-use ticket for this session is the
    // single write this whole tab performs and the paragraph on screen says so —
    // and a path-only assertion would admit any other write added here later.
    for (const [method, path] of application.httpOnlyJsonRequest.mock.calls) {
      expect([
        ['GET', '/v1/admin/sync-diagnostics'],
        ['GET', '/v1/sockets/sync/capabilities'],
        ['POST', '/v1/sockets/sync/ticket'],
        ['GET', '/v1/items/storage-usage'],
        ['GET', '/v2/items/a-note/revisions'],
        ['GET', '/healthcheck/readiness'],
      ]).toContainEqual([method, path])
    }
    expect(application.serverJsonRequest).not.toHaveBeenCalled()
  })

  /**
   * *** WHAT A RUN WRITES IS SAID AT EVERY CONTROL THAT STARTS ONE. ***
   *
   * One of these checks mints a real server-side ticket. The sentence saying so
   * sits beside "Run all checks" in the header — which is outside the panels and
   * so is on screen whichever tab is open — and beside that check's own control
   * on the Checks tab. Section controls state only their mapped write effects.
   */
  it('says what the ticket check writes beside every control that can start it', async () => {
    await renderTab(makeApplication())
    const sentence = 'mint ONE short-lived, single-use socket ticket'

    // 1. the header, beside Run all checks, on every tab
    const consent = container.querySelector('[data-diagnostics-consent]')
    expect(consent?.textContent).toContain(sentence)
    expect(consent?.textContent).toContain('2 of the 7 checks it runs write something')
    // The file round trip's own account of itself is there too, in full.
    expect(consent?.textContent).toContain('Uploads ONE throwaway object of 16 KiB of random bytes')
    expect(consent?.textContent).toContain('none of your own files is read, changed or removed')
    // And WHAT a run writes is on the page without opening anything: consent that
    // has to be unfolded to be read is not consent.
    const writes = container.querySelector('[data-diagnostics-writes]')
    expect(writes?.closest('details')).toBeNull()
    expect(writes?.textContent).toBe(
      'Run all checks mints one short-lived socket ticket that is never used, and uploads one throwaway 16 KiB file of random bytes, reads it back and deletes it. Nothing of yours is read, changed or removed.',
    )
    for (const label of ALL_SUBTABS) {
      await openSubtab(label)
      expect(container.querySelector('[data-diagnostics-consent]')?.textContent).toContain(sentence)
    }

    // 2. the check's own item on the Checks tab, with its own button
    await openSubtab('Checks')
    const ticket = activePanel().querySelector('[data-diagnostics-probe="ticket"]')
    expect(ticket?.textContent).toContain(sentence)
    expect(ticket?.querySelector('button')).not.toBeNull()
    // …and it is marked as the one that writes.
    expect(ticket?.textContent).toContain('writes')
    expect(activePanel().querySelector('[data-diagnostics-probe="capabilities"]')?.textContent).toContain('read-only')

    // 3. every topic has its scoped control, and write sections disclose effects
    for (const id of SECTION_IDS) {
      await openSubtab(SECTION_TITLE[id])
      expect([...activePanel().querySelectorAll('button')]).toHaveLength(1)
      if (id === 'websocket') {
        expect(activePanel().querySelector('[data-diagnostics-section-effects]')?.textContent).toContain(sentence)
      }
      if (id === 'backend') {
        expect(activePanel().querySelector('[data-diagnostics-section-effects]')?.textContent).toContain('16 KiB')
      }
    }
  })

  it('shows each check as a row inside the section it belongs to, with a status that counts', async () => {
    await renderTab(makeApplication())
    await clickButton('Run all checks')

    const websocket = await openSubtab('WebSocket')
    expect(websocket).toContain('Socket ticket')
    expect(sectionRow('Socket ticket')[1]).toBe('refused: SYNC_DISABLED')
    expect(sectionRowStatus('Socket ticket')).toBe('broken')
    expect([...activePanel().querySelectorAll('button')]).toHaveLength(1)
    // The checks block leads the section.
    expect(activePanel().querySelector('[data-diagnostics-block]')?.getAttribute('data-diagnostics-block')).toBe(
      'Checks',
    )

    const environment = await openSubtab('Environment & setup')
    expect(environment).toContain('Deployment marker')
    expect(environment).not.toContain('Socket ticket')

    // A section with no check registered shows no checks block at all.
    await openSubtab('Browser')
    expect(activePanel().querySelector('[data-diagnostics-block="Checks"]')).toBeNull()
  })

  /**
   * The read-only checks need no consent, so they have already run when the pane
   * opens; the one that writes has NOT, and reads "not tested" until it is asked.
   */
  it('runs the read-only checks on open and leaves the one that writes untested', async () => {
    const application = makeApplication()
    await renderTab(application)
    await openSubtab('Checks')
    const status = (id: string): string | null =>
      activePanel().querySelector(`[data-diagnostics-probe="${id}"]`)?.getAttribute('data-diagnostics-probe-status') ??
      null

    expect(status('ticket')).toBe('untested')
    for (const id of ['capabilities', 'control-plane', 'negotiation', 'marker']) {
      expect({ id, untested: status(id) === 'untested' }).toEqual({ id, untested: false })
    }
    // Nothing was written to get there.
    const posts = application.httpOnlyJsonRequest.mock.calls.filter(([method]) => method === 'POST')
    expect(posts).toHaveLength(0)
    // And an untested check keeps the headline off OK.
    expect(headlineStatus()).not.toBe('healthy')
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
    // One status line per section, and the sections' own blocks beneath.
    expect(occurrences(report, '\n- Status: ')).toBe(SECTION_IDS.length)
    expect(report).toContain('### Socket lane and boot gate')
    expect(report).toContain('### Clock')
    expect(report).toContain('### Durable storage')
    expect(report).toContain('### Account and access')
    expect(report).toContain('### Deployment identity')
  })

  it('carries the SYNC_ITEMS verdict and the checks into the report', async () => {
    await renderTab(makeApplication())
    await clickButton('Run all checks')
    await openSubtab('Copyable report')

    const report = reportText()
    expect(report).toContain('- SYNC_ITEMS advertised: no')
    expect(report).toContain('- SYNC_ITEMS cause: LANE_PRECONDITION_UNMET')
    expect(report).toContain('- [NOT WORKING] Socket ticket: refused: SYNC_DISABLED')
  })

  it('copies the whole report to the clipboard and confirms', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    await clickButton('Copy whole report')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('## Topology')
    expect(writeText.mock.calls[0][0]).toContain('## Browser')
    expect(container.textContent).toContain('Report copied')
  })

  /**
   * *** THE SUMMARY BUTTON, AND WHAT MAKES IT WORTH A SECOND BUTTON. ***
   *
   * The whole report is tens of kilobytes and what somebody wants in a chat
   * message is the verdict and the ranked list of what to fix. So the assertions
   * are two-sided: the summary must carry the ANSWER, and it must NOT carry the
   * evidence — a "summary" that happened to be the whole document would satisfy
   * every `toContain` on its own, which is the exact trap a `toContain`-only test
   * walks into.
   */
  it('copies a summary that carries the answer and not the evidence', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(makeApplication())
    await openSubtab('Copyable report')

    await clickButton('Copy summary')

    expect(writeText).toHaveBeenCalledTimes(1)
    const summary = writeText.mock.calls[0][0] as string
    expect(summary).toContain('## Summary')
    expect(summary).toContain('## What needs attention')
    expect(summary).toContain('## How to read this')
    expect(summary).toContain('| Section | Status |')
    expect(summary).toContain('- Do first:')
    // The evidence is what it leaves out, and these are the five sections plus the
    // three payload blocks the full report carries.
    for (const absent of ['## Topology', '## Boot gate', '## Configuration presence', '## Browser', '## WebSocket']) {
      expect(summary).not.toContain(absent)
    }
    expect(summary.length).toBeLessThan(reportText().length)
    expect(container.textContent).toContain('Summary copied')
    expect(container.textContent).not.toContain('Report copied')
  })
})

describe('AdminDiagnosticsTab — failure and secrecy', () => {
  it('explains a 403 rather than rendering an empty screen', async () => {
    const noteIfForbidden = jest.fn()
    const application = makeApplication({
      ...answering({ status: 403, ok: false, data: {} }),
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
    const operations = ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT', 'INVITE_EVENTS']
    const application = makeApplication(
      {
        ...answering(
          {
            status: 200,
            ok: true,
            data: {
              capturedAt: CAPTURED_AT,
              deployment: {
                ...unavailablePayload.deployment,
                serviceProxySetting: 'grpc',
                grpcSyncingProxyBound: true,
              },
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
              protocol: { version: 1, serverOperations: operations },
            },
          },
          {
            // A healthy socket carries the control-plane read, and the check
            // reports the lane it MEASURED.
            carriedBy: 'socket',
            // The descriptor and ticket a healthy server serves, so the checks
            // see what this payload describes rather than the default fixture.
            http: {
              '/v1/sockets/sync/capabilities': { status: 200, ok: true, data: { capabilities: [{ id: 'ws-sync' }] } },
              '/v1/sockets/sync/ticket': { status: 200, ok: true, data: {} },
            },
          },
        ),
        syncTransportStatus: { state: 'READY', operations },
      },
      { syncCarrier: 'socket' },
    )

    const text = await renderTab(application)

    expect(text).toContain('fully configured and available')
    expect(routerStatus('websocket')).not.toBe('broken')
    expect(routerStatus('websocket')).not.toBe('degraded')
    expect(await openSubtab('WebSocket')).toContain('Socket lane and boot gate')
    // The lane the control-plane read rode is the one MEASURED on that read.
    // …with how long that read took, end to end, as a figure and not a verdict.
    expect(sectionRow('Authenticated control-plane read')[1]).toMatch(
      /^answered over the socket’s control-plane lane · \d+ ms$/,
    )
    expect(sectionRowStatus('Authenticated control-plane read')).toBe('healthy')

    await openSubtab('Database & internal comms')
    // And the sync is one that happened: counted by the transport either side of
    // the app's own `sync()`, not read off the call returning.
    expect(application.sync.sync).toHaveBeenCalledTimes(1)
    expect(sectionRow('Sync round trip')[1]).toBe('completed over the socket')
    expect(sectionRowStatus('Sync round trip')).toBe('healthy')
    expect(sectionRow('Revision history read')[1]).toBe('answered')
    // The check that writes has not been asked to, and says so.
    expect(sectionRowStatus('File transfer round trip')).toBe('untested')
  })

  /**
   * *** THE SAME SERVER, BEHIND A PROXY THAT DOES NOT UPGRADE. *** Nothing is
   * unmet on the server and this tab cannot reach the socket. The line under the
   * findings said the realtime lane was "fully configured and available", a few
   * rows below a headline that said something was lost.
   */
  it('does not call the realtime lane available on a tab the socket refuses', async () => {
    const operations = ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT', 'INVITE_EVENTS']
    const application = makeApplication({
      ...answering({
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
          protocol: { version: 1, serverOperations: operations },
        },
      }),
      syncTransportStatus: { state: 'HTTP_FALLBACK', fallbackReason: 'proxy-failed', operations: [] },
    })

    await renderTab(application)
    const diagnosis = container.querySelector('[data-diagnostics-lane-diagnosis]')?.textContent ?? ''

    expect(diagnosis).toContain('The server built the realtime sync lane with nothing unmet.')
    expect(diagnosis).toContain('This tab is not on it')
    expect(diagnosis).not.toContain('available')
    expect(headlineStatus()).not.toBe('healthy')
  })

  /**
   * *** THE STRANDED LANE, WHICH THIS CHECK USED TO PASS. *** The socket is up
   * and negotiated API_RPC; the lane refuses the read and HTTP quietly serves it.
   * The old row inferred the lane from the negotiation and read OK.
   */
  it('reports a control-plane read that HTTP served on a socket that negotiated the lane as something lost', async () => {
    const operations = ['SYNC_ITEMS', 'API_RPC']
    const application = makeApplication({
      ...answering({ status: 200, ok: true, data: unavailablePayload }, { carriedBy: 'http' }),
      syncTransportStatus: { state: 'READY', operations },
    })
    await renderTab(application)
    await openSubtab('WebSocket')

    expect(sectionRow('Authenticated control-plane read')[1]).toBe(
      'answered over HTTP, although this socket negotiated API_RPC',
    )
    expect(sectionRowStatus('Authenticated control-plane read')).toBe('degraded')
  })

  it('reports a sync that went over HTTP on a socket that negotiated it as working, with something lost', async () => {
    const application = makeApplication(
      { syncTransportStatus: { state: 'READY', operations: ['SYNC_ITEMS'] } },
      { syncCarrier: 'http' },
    )
    await renderTab(application)
    await openSubtab('Database & internal comms')

    expect(sectionRow('Sync round trip')[1]).toBe('completed over HTTP, although this socket negotiated SYNC_ITEMS')
    expect(sectionRowStatus('Sync round trip')).toBe('degraded')
    expect(activePanel().textContent).toContain('Sync works, but not over the socket that agreed to carry it')
  })

  it('reports a sync that completed on no lane as not working, and says what that costs', async () => {
    const application = makeApplication({}, { syncCarrier: 'failed' })
    await renderTab(application)
    await openSubtab('Database & internal comms')

    expect(sectionRow('Sync round trip')[1]).toBe('the sync did not complete')
    expect(sectionRowStatus('Sync round trip')).toBe('broken')
    expect(routerStatus('backend')).toBe('broken')
    expect(activePanel().textContent).toContain('A sync from this tab did not complete')
  })

  /**
   * *** A FILE THAT CANNOT BE STORED, AND WHAT IS LEFT BEHIND. *** The files
   * service takes the upload and will not serve it back. The row names the step,
   * the section goes red, a card says what to do — and the object the failed run
   * left on the server is deleted anyway.
   */
  it('names the step a file round trip failed at, raises it, and still deletes what it stored', async () => {
    const application = makeApplication()
    application.legacyApi.downloadFile.mockResolvedValue({ text: 'range not satisfiable' })
    await renderTab(application)
    await clickButton('Run all checks')
    await openSubtab('Database & internal comms')

    expect(sectionRow('File transfer round trip')[1]).toBe('the stored object could not be read back · deleted')
    expect(sectionRowStatus('File transfer round trip')).toBe('broken')
    expect(routerStatus('backend')).toBe('broken')
    expect(activePanel().textContent).toContain('A file could not be stored and read back')
    // The files probe answered, and is NOT called working over a transfer that failed.
    expect(sectionRowStatus('Files service probe')).not.toBe('healthy')
    // Cleaned up after a half-way failure.
    expect(application.legacyApi.operations.at(-1)?.[0]).toBe('delete')
    expect(application.legacyApi.objects.size).toBe(0)
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
      ...answering({ status: 200, ok: true, data: poisoned }),
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
      ...answering({
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
      ...answering({ status, ok: false, data: {} }),
      syncTransportStatus: { state: 'READY', operations: ['SYNC_ITEMS', 'API_RPC'] },
    })

  /**
   * *** UNREAD IS NOT DOWN, AT THE CHECK. *** The control-plane check asks the same
   * endpoint. A 401, a 403 and a 404 are the server ANSWERING that this session
   * may not look, or that the build has no such endpoint — reasons the pane is
   * empty, and no evidence about the lane. Only an answer that is none of those
   * is the admin surface itself failing.
   */
  it('reads a refused control-plane check as unknown, and only a server failure as not working', async () => {
    const statusOfCheck = async (status: number): Promise<string | null> => {
      await renderTab(unreadable(status))
      await openSubtab('Checks')

      return (
        activePanel()
          .querySelector('[data-diagnostics-probe="control-plane"]')
          ?.getAttribute('data-diagnostics-probe-status') ?? null
      )
    }

    for (const status of [401, 403, 404]) {
      expect({ status, check: await statusOfCheck(status) }).toEqual({ status, check: 'undetermined' })
      expect(activePanel().textContent).toContain('says nothing about whether the deployment is working')
    }
    for (const status of [500, 502]) {
      expect({ status, check: await statusOfCheck(status) }).toEqual({ status, check: 'broken' })
    }
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

describe('AdminDiagnosticsTab — running one check', () => {
  const probeItem = (id: string): HTMLElement => {
    const element = activePanel().querySelector(`[data-diagnostics-probe="${id}"]`)
    expect(element).not.toBeNull()

    return element as HTMLElement
  }

  const clickProbe = async (id: string) => {
    const button = probeItem(id).querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
  }

  it('lists every check with its own control before anything has been run', async () => {
    await renderTab(makeApplication())
    await openSubtab('Checks')

    const items = [...activePanel().querySelectorAll('[data-diagnostics-probe]')]
    expect(items.map((item) => item.getAttribute('data-diagnostics-probe'))).toEqual([...CHECK_IDS])
    for (const item of items) {
      const id = item.getAttribute('data-diagnostics-probe') as CheckId
      // Every check says what running it does, BEFORE it is run.
      expect(item.textContent).toContain(`What it does: ${CHECKS[id].does}`)
      // A LIVE check sends nothing, so there is nothing to press.
      expect(item.querySelector('button') === null).toBe(CHECKS[id].mode === 'live')
    }
    // The one that writes has not run and says so, with its own control.
    expect(probeItem('ticket').getAttribute('data-diagnostics-probe-status')).toBe('untested')
    expect(probeItem('ticket').textContent).toContain('not tested (run it from this pane)')
    expect(probeItem('ticket').querySelector('button')?.textContent).toBe('Run this check')
  })

  it('runs one check and reports only that one, re-reading nothing else', async () => {
    const application = makeApplication()
    await renderTab(application)
    await openSubtab('Checks')

    await clickProbe('ticket')

    const capabilityCallsBefore = application.httpOnlyJsonRequest.mock.calls.filter(
      ([, path]) => path === '/v1/sockets/sync/capabilities',
    ).length

    expect(probeItem('ticket').textContent).toContain('SYNC_DISABLED')
    expect(probeItem('ticket').getAttribute('data-diagnostics-probe-status')).toBe('broken')
    expect(probeItem('ticket').querySelector('button')?.textContent).toBe('Re-run this check')
    // And it reached exactly the one endpoint its own check needs: the capability
    // descriptor was read once when the pane opened and not again for this.
    const paths = application.httpOnlyJsonRequest.mock.calls.map(([, path]) => path)
    expect(paths.filter((path: string) => path === '/v1/sockets/sync/ticket')).toHaveLength(1)
    expect(paths.filter((path: string) => path === '/v1/sockets/sync/capabilities')).toHaveLength(capabilityCallsBefore)
    expect(capabilityCallsBefore).toBe(1)
  })

  /**
   * *** THE MERGE, AND THE REASON IT IS NOT A REPLACE. *** Returning only the
   * fresh outcome would blank the other four, which makes "re-run one check"
   * strictly worse than the full run it exists to avoid.
   */
  it('re-runs one check without discarding the other four results', async () => {
    const ticket = { status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } }
    const responses: Record<string, unknown> = {
      '/v1/sockets/sync/ticket': ticket,
      '/v1/sockets/sync/capabilities': { status: 200, ok: true, data: { capabilities: [] } },
      '/v1/items/storage-usage': { status: 200, ok: true, data: storageUsagePayload },
    }
    const application = makeApplication({
      httpOnlyJsonRequest: jest.fn().mockImplementation(async (_method: string, path: string) => {
        return Object.hasOwn(responses, path) ? responses[path] : { status: 404, ok: false, data: {} }
      }),
    })
    await renderTab(application)
    await clickButton('Run all checks')
    await openSubtab('Checks')

    expect(probeItem('capabilities').textContent).toContain('advertises an EMPTY capability list')
    expect(probeItem('ticket').textContent).toContain('SYNC_DISABLED')
    const others = ['capabilities', 'control-plane', 'negotiation', 'marker']
    const before = others.map((id) => probeItem(id).getAttribute('data-diagnostics-probe-status'))

    // The deployment is repaired; only the ticket check is asked again.
    responses['/v1/sockets/sync/ticket'] = { status: 200, ok: true, data: {} }
    await clickProbe('ticket')

    expect(probeItem('ticket').textContent).toContain('A short-lived single-use ticket was issued')
    expect(probeItem('ticket').getAttribute('data-diagnostics-probe-status')).toBe('healthy')
    // The other four survive untouched rather than reverting to "not tested".
    expect(probeItem('capabilities').textContent).toContain('advertises an EMPTY capability list')
    expect(others.map((id) => probeItem(id).getAttribute('data-diagnostics-probe-status'))).toEqual(before)
    for (const id of others) {
      expect(probeItem(id).getAttribute('data-diagnostics-probe-status')).not.toBe('untested')
    }
  })

  /**
   * A single run must not regenerate the report. The server-status read is the
   * cleanest witness: it is reached once on mount, again after a FULL run, and
   * never by a single probe.
   */
  it('does not re-read the payload or the server status for a single check', async () => {
    const application = makeApplication()
    await renderTab(application)
    await openSubtab('Checks')

    const statusCallsBefore = application.legacyApi.adminGetServerStatus.mock.calls.length
    // Counted on the helper the pane READS WITH. This used to count calls on the
    // lane-first helper, which the pane stopped using for this read — so it
    // compared zero with zero and could not fail.
    const diagnosticsReads = (): number =>
      application.httpOnlyJsonRequest.mock.calls.filter(
        ([, path]: [string, string]) => path === '/v1/admin/sync-diagnostics',
      ).length
    const diagnosticsCallsBefore = diagnosticsReads()
    expect(diagnosticsCallsBefore).toBeGreaterThan(0)

    await clickProbe('ticket')

    expect(application.legacyApi.adminGetServerStatus.mock.calls).toHaveLength(statusCallsBefore)
    expect(diagnosticsReads()).toBe(diagnosticsCallsBefore)

    // A FULL run still does re-read both: several of its probes change what they
    // answer, so leaving them stale would be the opposite defect.
    await clickButton('Run all checks')
    expect(application.legacyApi.adminGetServerStatus.mock.calls.length).toBeGreaterThan(statusCallsBefore)
  })

  /**
   * *** THE PAGE IS ONE BUILD AND ITS SYNC WORKER ANOTHER. *** The image that
   * prompted this named one commit in its page, its marker and its readiness
   * route, and ran a sync worker from an older one. The pane has to say so first,
   * as not working, with the one thing to do.
   */
  it('says the page and its sync worker are different builds, first and as not working', async () => {
    const page = 'c'.repeat(40)
    const worker = 'd'.repeat(40)
    await renderTab(makeApplication({ syncTransportWorkerBuild: { state: 'reported', revision: worker } }))

    expect(headlineStatus()).toBe('broken')
    const first = container.querySelector('[data-diagnostics-attention] [data-diagnostics-finding]')
    expect(first?.getAttribute('data-diagnostics-finding')).toBe('SYNC_WORKER_IS_ANOTHER_BUILD')
    expect(first?.getAttribute('data-diagnostics-finding-status')).toBe('broken')
    expect(first?.querySelector('[data-diagnostics-finding-title]')?.textContent).toBe(
      'This page and its sync worker are different builds',
    )
    expect(first?.querySelector('[data-diagnostics-finding-action]')?.textContent).toContain('Reload this tab')

    await openSubtab('Environment & setup')
    expect(sectionRow('Sync worker this tab is running')[1]).toBe(
      `the page is build ${page} but its sync worker is build ${worker}`,
    )
    expect(sectionRowStatus('Sync worker this tab is running')).toBe('broken')
  })

  it('reads the sync worker as the page’s own build when it says so, and follows it when it changes', async () => {
    const application = makeApplication()
    await renderTab(application)
    await openSubtab('Environment & setup')

    expect(sectionRow('Sync worker this tab is running')[1]).toBe('the sync worker is the same build as this page')
    expect(sectionRowStatus('Sync worker this tab is running')).toBe('healthy')

    // The transport replaced its worker and the new one has not spoken for a minute.
    ;(application as { syncTransportWorkerBuild: unknown }).syncTransportWorkerBuild = {
      state: 'silent',
      silentForMs: 60_000,
    }
    await act(async () => {
      jest.advanceTimersByTime(2_100)
    })
    await settle()

    expect(sectionRowStatus('Sync worker this tab is running')).toBe('broken')
    expect(sectionRow('Sync worker this tab is running')[1]).toContain('did not say which build it is')
  })

  /**
   * *** REFRESH RE-READS THE PANE, NOT A THIRD OF IT. *** Measured on a real
   * stack: a new web build was deployed under an open pane, Refresh was pressed,
   * and the pane went on naming the old build. It reloaded one of its three
   * reads and none of its checks.
   */
  it('re-reads everything the pane reads on Refresh, re-runs the read-only checks, and writes nothing', async () => {
    const current = 'c'.repeat(40)
    const next = 'd'.repeat(40)
    let served = current
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn().mockImplementation(async () => {
      return { ok: true, json: async () => ({ revision: served, version: 'rel-1.0.0' }) }
    })
    const application = makeApplication()
    await renderTab(application)
    const identity = (): string => container.querySelector('[data-diagnostics-identity]')?.textContent ?? ''
    const diagnosticsReads = (): number =>
      application.httpOnlyJsonRequest.mock.calls.filter(
        ([, path]: [string, string]) => path === '/v1/admin/sync-diagnostics',
      ).length
    const before = {
      diagnostics: diagnosticsReads(),
      status: application.legacyApi.adminGetServerStatus.mock.calls.length,
      syncs: application.sync.sync.mock.calls.length,
      tickets: application.serverJsonRequest.mock.calls.length,
    }
    expect(identity()).toContain(current)
    expect(before.syncs).toBe(1)

    // A deployment lands under the open pane.
    served = next
    await clickButton('Refresh')

    expect(diagnosticsReads()).toBe(before.diagnostics + 1)
    expect(application.legacyApi.adminGetServerStatus.mock.calls).toHaveLength(before.status + 1)
    // The marker: the pane now names the build the server serves.
    expect(identity()).toContain(next)
    expect(identity()).not.toContain(current)
    // The read-only checks ran again…
    expect(application.sync.sync.mock.calls).toHaveLength(before.syncs + 1)
    // …and neither check that writes did: no ticket minted, no upload opened.
    expect(application.serverJsonRequest.mock.calls).toHaveLength(before.tickets)
    expect(application.legacyApi.startUploadSession).not.toHaveBeenCalled()
  })

  it('keeps the results in the registry’s order however they were run', async () => {
    const application = makeApplication()
    await renderTab(application)
    await openSubtab('Checks')

    // Run out of registry order, on purpose.
    await clickProbe('control-plane')
    await clickProbe('ticket')
    await clickProbe('capabilities')
    await openSubtab('Copyable report')

    const report = reportText()
    const checks = report.slice(report.indexOf('## Checks'))
    const positions = CHECK_IDS.map((id) => checks.indexOf(`] ${CHECKS[id].title}: `))
    expect(positions.every((position) => position > -1)).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })
})

describe('AdminDiagnosticsTab — identity on the header', () => {
  const identity = (): string => container.querySelector('[data-diagnostics-identity]')?.textContent ?? ''

  it('names the build and the capture instant beside the verdict chips', async () => {
    await renderTab(makeApplication())

    expect(identity()).toContain('Build: unstamped (not stamped)')
    expect(identity()).toContain(`captured ${CAPTURED_AT}`)
  })

  it('prints a real revision and version when the marker carries them', async () => {
    const revision = 'ab3f90'.repeat(6) + 'cdef'
    ;(globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ revision, version: 'rel-1.2.3' }) })
    await renderTab(makeApplication())

    expect(identity()).toContain(revision)
    expect(identity()).toContain('version rel-1.2.3')
  })

  /**
   * The marker is served by whatever fronts the bundle, and this header is on a
   * screen operators photograph. It is admitted by the SAME shape rule the report
   * uses — not the denylist the marker used to go through, which printed
   * `token-sk-live-…` verbatim because it has no address shape.
   */
  it('refuses a marker that does not match the shape the Dockerfile validates', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ revision: 'token-sk-live-abcdef0123456789', version: 'v1.2.3-build@ci.internal.example' }),
    })
    await renderTab(makeApplication())

    expect(identity()).not.toContain('token-sk-live')
    expect(identity()).not.toContain('v1.2.3-build')
    expect(identity()).not.toContain('internal.example')
    // NOT vacuous: the row the marker feeds is really rendered.
    expect(identity()).toContain('withheld (unrecognised format)')
  })

  it('says the capture instant was not reported rather than inventing one', async () => {
    const application = makeApplication({
      ...answering({ status: 200, ok: true, data: { gate: {} } }),
    })
    await renderTab(application)

    expect(identity()).toContain('captured not reported')
  })
})

describe('Diagnostics run scopes and cancellation', () => {
  const probe = (id: string) => container.querySelector(`[data-diagnostics-probe="${id}"]`) as HTMLElement
  const clickProbe = async (id: string) => {
    await act(async () =>
      probe(id)
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await settle()
  }
  it('runs only checks mapped to the chosen section', async () => {
    const app = makeApplication()
    await renderTab(app)
    app.httpOnlyJsonRequest.mockClear()
    app.sync.sync.mockClear()
    app.serverGetJsonRequestObservingLane.mockClear()
    await openSubtab(SECTION_TITLE.websocket)
    await clickButton('Run section checks')
    expect(app.httpOnlyJsonRequest.mock.calls.map(([, path]) => path)).toEqual([
      '/v1/sockets/sync/capabilities',
      '/v1/sockets/sync/ticket',
    ])
    expect(app.serverGetJsonRequestObservingLane).toHaveBeenCalledTimes(1)
    expect(app.legacyApi.startUploadSession).not.toHaveBeenCalled()
    expect(app.sync.sync).not.toHaveBeenCalled()
  })
  it('aborts the current request, stops successors and ignores late completion after a new run', async () => {
    const app = makeApplication()
    await renderTab(app)
    let resolve!: (value: Answer) => void
    const pending = new Promise<Answer>((done) => {
      resolve = done
    })
    const normal = app.httpOnlyJsonRequest.getMockImplementation()!
    app.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/sockets/sync/capabilities' ? pending : normal(method, path)
    })
    app.httpOnlyJsonRequest.mockClear()
    await clickButton('Run all checks')
    const signal = app.httpOnlyJsonRequest.mock.calls[0][3] as AbortSignal
    await clickButton('Cancel diagnostics')
    expect(signal.aborted).toBe(true)
    expect(app.httpOnlyJsonRequest.mock.calls.some(([, path]) => path === '/v1/sockets/sync/ticket')).toBe(false)
    await openSubtab('Checks')
    app.httpOnlyJsonRequest.mockImplementation(normal)
    await clickProbe('capabilities')
    const fresh = probe('capabilities').textContent
    await act(async () => resolve({ status: 200, ok: true, data: { capabilities: ['one', 'two', 'three'] } }))
    await settle()
    expect(probe('capabilities').textContent).toBe(fresh)
    expect(app.legacyApi.startUploadSession).not.toHaveBeenCalled()
  })
  it('stops file substeps but cleans up the temporary object after cancellation', async () => {
    const app = makeApplication()
    await renderTab(app)
    await openSubtab('Checks')
    let complete!: (value: boolean) => void
    const pending = new Promise<boolean>((resolve) => {
      complete = resolve
    })
    app.legacyApi.uploadFileBytes.mockImplementationOnce(() => pending)
    await clickProbe('file-transfer')
    expect(app.legacyApi.startUploadSession).toHaveBeenCalledTimes(1)
    await clickButton('Cancel this check')
    await act(async () => complete(true))
    await settle()
    expect(app.legacyApi.uploadFileBytes).toHaveBeenCalledTimes(1)
    expect(app.legacyApi.closeUploadSession).not.toHaveBeenCalled()
    expect(app.legacyApi.deleteFile).toHaveBeenCalledTimes(1)
    expect(app.legacyApi.objects.size).toBe(0)
    expect(probe('file-transfer').getAttribute('data-diagnostics-probe-status')).toBe('untested')
  })
  it('withdraws a pending run when the account changes', async () => {
    let owner = 'first'
    const app = makeApplication({
      sessions: { isSignedIn: () => true, isSignedIntoFirstPartyServer: () => true, getUser: () => ({ uuid: owner }) },
    })
    await renderTab(app)
    let complete!: (value: Answer) => void
    const pending = new Promise<Answer>((resolve) => {
      complete = resolve
    })
    const normal = app.httpOnlyJsonRequest.getMockImplementation()!
    app.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/sockets/sync/capabilities' ? pending : normal(method, path)
    })
    app.httpOnlyJsonRequest.mockClear()
    await clickButton('Run all checks')
    owner = 'second'
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await act(async () => complete({ status: 200, ok: true, data: { capabilities: ['old'] } }))
    await settle()
    expect(app.httpOnlyJsonRequest.mock.calls.some(([, path]) => path === '/v1/sockets/sync/ticket')).toBe(false)
    await openSubtab('Checks')
    expect(probe('capabilities').getAttribute('data-diagnostics-probe-status')).toBe('untested')
  })
  it('refreshes Account readings only and ignores cancelled collector responses', async () => {
    const app = makeApplication()
    await renderTab(app)
    await openSubtab(SECTION_TITLE.account)
    app.httpOnlyJsonRequest.mockClear()
    let complete!: (value: { value: string }) => void
    const pending = new Promise<{ value: string }>((resolve) => {
      complete = resolve
    })
    app.settings.getSubscriptionSettingDetail.mockImplementation(() => pending)
    await clickButton('Refresh section readings')
    expect(app.httpOnlyJsonRequest.mock.calls.map(([, path]) => path)).toEqual(['/v1/items/storage-usage'])
    await clickButton('Cancel diagnostics')
    await act(async () => complete({ value: '999999999999' }))
    await settle()
    expect(container.textContent).not.toContain('Section readings refreshed.')
    expect(container.textContent).toContain('Cancelled.')
    expect(app.legacyApi.startUploadSession).not.toHaveBeenCalled()
  })
  it('refreshes Browser observations without server probes', async () => {
    const app = makeApplication()
    await renderTab(app)
    await openSubtab(SECTION_TITLE.browser)
    app.httpOnlyJsonRequest.mockClear()
    await clickButton('Refresh section readings')
    expect(app.httpOnlyJsonRequest).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Section readings refreshed.')
  })
  it('aborts on unmount and never starts subsequent work', async () => {
    const app = makeApplication()
    await renderTab(app)
    let complete!: (value: Answer) => void
    const pending = new Promise<Answer>((resolve) => {
      complete = resolve
    })
    const normal = app.httpOnlyJsonRequest.getMockImplementation()!
    app.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/sockets/sync/capabilities' ? pending : normal(method, path)
    })
    app.httpOnlyJsonRequest.mockClear()
    await clickButton('Run all checks')
    const signal = app.httpOnlyJsonRequest.mock.calls[0][3] as AbortSignal
    act(() => root.unmount())
    root = createRoot(container)
    expect(signal.aborted).toBe(true)
    await act(async () => complete({ status: 200, ok: true, data: { capabilities: ['late'] } }))
    await settle()
    expect(app.httpOnlyJsonRequest.mock.calls.some(([, path]) => path === '/v1/sockets/sync/ticket')).toBe(false)
  })
})

describe('Diagnostics session-generation guard', () => {
  it('ignores results from a previous login to the same account', async () => {
    let event!: (value: string) => Promise<void>
    const app = makeApplication({
      sessions: {
        isSignedIn: () => true,
        isSignedIntoFirstPartyServer: () => true,
        getUser: () => ({ uuid: 'same-account' }),
      },
      addEventObserver: (callback: typeof event) => {
        event = callback
        return () => {}
      },
    })
    await renderTab(app)
    let resolve!: (value: Answer) => void
    const pending = new Promise<Answer>((done) => {
      resolve = done
    })
    const normal = app.httpOnlyJsonRequest.getMockImplementation()!
    app.httpOnlyJsonRequest.mockImplementation((method: string, path: string) => {
      return path === '/v1/sockets/sync/capabilities' ? pending : normal(method, path)
    })
    app.httpOnlyJsonRequest.mockClear()
    await clickButton('Run all checks')
    await act(async () => {
      await event('signed-out')
      await event('signed-in')
    })
    await act(async () => {
      resolve({ status: 200, ok: true, data: { capabilities: ['old-session'] } })
    })
    await settle()
    expect(app.httpOnlyJsonRequest.mock.calls.some(([, path]) => path === '/v1/sockets/sync/ticket')).toBe(false)
    await openSubtab('Checks')
    expect(
      activePanel()
        .querySelector('[data-diagnostics-probe="capabilities"]')
        ?.getAttribute('data-diagnostics-probe-status'),
    ).toBe('untested')
  })

  it('does not let the initial Account collector overwrite a newer manual refresh', async () => {
    const app = makeApplication()
    let resolve!: (value: { value: string }) => void
    const pending = new Promise<{ value: string }>((done) => {
      resolve = done
    })
    app.settings.getSubscriptionSettingDetail
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(() => pending)
    await renderTab(app)
    await openSubtab(SECTION_TITLE.account)
    await clickButton('Refresh section readings')
    const fresh = activePanel().textContent
    expect(container.textContent).toContain('Section readings refreshed.')
    await act(async () => {
      resolve({ value: '999999999999' })
    })
    await settle()
    expect(activePanel().textContent).toBe(fresh)
  })
})

describe('Diagnostics native transfer cancellation', () => {
  it('forwards cancellation to the HTTP byte request and retains cleanup', async () => {
    const app = makeApplication()
    await renderTab(app)
    await openSubtab('Checks')
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    app.legacyApi.downloadFile.mockImplementationOnce(() => pending)
    const row = activePanel().querySelector('[data-diagnostics-probe="file-transfer"]') as HTMLElement
    await act(async () => row.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    const signal = app.legacyApi.downloadFile.mock.calls[0][0].abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)
    await clickButton('Cancel this check')
    expect(signal.aborted).toBe(true)
    await act(async () => resolve())
    await settle()
    expect(app.legacyApi.deleteFile).toHaveBeenCalledTimes(1)
    expect(app.legacyApi.objects.size).toBe(0)
    expect(row.getAttribute('data-diagnostics-probe-status')).toBe('untested')
  })
})

describe('Diagnostics sync operation accuracy', () => {
  it('keeps automatic sync automatic but explicitly initiated checks bypass manual-sync suppression', async () => {
    const app = makeApplication()
    await renderTab(app)
    expect(app.sync.sync).toHaveBeenCalledWith({
      sourceDescription: 'admin diagnostics: sync round trip',
      isUserInitiated: false,
    })
    app.sync.sync.mockClear()
    await openSubtab('Checks')
    const probe = activePanel().querySelector('[data-diagnostics-probe="sync"]') as HTMLElement
    await act(async () => probe.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(app.sync.sync).toHaveBeenCalledWith({
      sourceDescription: 'admin diagnostics: sync round trip',
      isUserInitiated: true,
    })
    app.sync.sync.mockClear()
    await openSubtab(SECTION_TITLE.backend)
    await clickButton('Run section checks')
    expect(app.sync.sync).toHaveBeenCalledWith({
      sourceDescription: 'admin diagnostics: sync round trip',
      isUserInitiated: true,
    })
    app.sync.sync.mockClear()
    await clickButton('Run all checks')
    expect(app.sync.sync).toHaveBeenCalledWith({
      sourceDescription: 'admin diagnostics: sync round trip',
      isUserInitiated: true,
    })
  })

  it('renders and reports an unfinished local sync without claiming server acceptance', async () => {
    const app = makeApplication()
    await renderTab(app)
    app.sync.sync.mockImplementationOnce(() => new Promise(() => {}))
    await openSubtab('Checks')
    const probe = activePanel().querySelector('[data-diagnostics-probe="sync"]') as HTMLElement
    await act(async () => probe.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => jest.advanceTimersByTime(45_000))
    await settle()
    expect(probe.textContent).toContain('application sync check unfinished after 45 s')
    expect(probe.textContent).toContain('Network dispatch or acceptance was not established')
    expect(probe.textContent).not.toContain('accepted the request')
    await openSubtab('Overview')
    expect(container.textContent).toContain('Sync round-trip check did not finish')
    await openSubtab('Copyable report')
    const report =
      (container.querySelector('textarea[aria-label="Diagnostics report"]') as HTMLTextAreaElement)?.value ??
      [...container.querySelectorAll('textarea')].map((e) => e.value).join('\n')
    expect(report).toContain('SYNC_OPERATION_TIMED_OUT')
    expect(report).toContain('Locate where application sync is waiting')
    expect(report).not.toContain('SERVER_NOT_ANSWERING')
    expect(report).not.toContain('The server is accepting requests and not answering them')
  })
})
