import { buildDiagnosticsReport, type DiagnosticsReportInput } from './diagnosticsReport'
import type { SyncDiagnosticsPayload } from './syncDiagnostics'

/**
 * The report is written on the assumption that it becomes public. These tests
 * split into two halves: it must SAY enough to be worth pasting, and it must
 * WITHHOLD everything that would make pasting it a mistake.
 */

const payload: SyncDiagnosticsPayload = {
  capturedAt: '2026-08-27T00:00:00.000Z',
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
      REDIS_HOST: true,
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
    syncLaneEnabled: true,
    syncItemsAdvertised: false,
    unmetPreconditions: [{ code: 'SYNCING_SERVER_GRPC_UNBOUND', remedy: 'configure SYNCING_SERVER_GRPC_URL' }],
    unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND'],
    files: { advertised: false, unmetCondition: 'FILES_INTERNAL_URL', remedy: 'no INTERNAL files service URL' },
  },
  live: { capabilities: [], unavailabilityReasons: [], ticketAvailable: true },
  protocol: { version: 1, serverOperations: ['SYNC_ITEMS', 'FILES_V1', 'FUTURE_LANE'] },
}

const input = (overrides: Partial<DiagnosticsReportInput> = {}): DiagnosticsReportInput => ({
  payload,
  transport: { state: 'READY', operations: ['FILES_V1'] },
  deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
  outcomes: [],
  loadError: null,
  generatedAt: '2026-08-27T12:00:00.000Z',
  ...overrides,
})

describe('buildDiagnosticsReport — what it says', () => {
  it('carries every section an issue reader needs', () => {
    const report = buildDiagnosticsReport(input())

    for (const heading of [
      '## Verdict',
      '## Deployment',
      '## Topology',
      '## Boot gate',
      '## Capabilities',
      '## Configuration presence',
      '## Checks',
    ]) {
      expect(report).toContain(heading)
    }
  })

  it('separates the lane verdict from the SYNC_ITEMS verdict', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('Sync lane enabled: yes')
    expect(report).toContain('SYNC_ITEMS advertised: no')
  })

  it('carries the topology-conditional remedy, not the server default', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('SERVICE_PROXY_TYPE=grpc')
    expect(report).toContain('Config + restart')
    // The stock advice would have sent the reader after a variable that IS set.
    expect(report).toContain('already set')
  })

  it('marks the deployment as unstamped and says a rebuild is the only fix', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('Stamped: no')
    expect(report).toContain('Rebuild required')
  })

  it('carries the capability matrix as a markdown table', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('| Operation | Server | Client | Negotiated | Status |')
    expect(report).toContain('| FILES_V1 |')
    // An operation only the server knows about must still get a row and a fix.
    expect(report).toContain('| FUTURE_LANE |')
    expect(report).toContain('Client update')
  })

  it('lists configuration presence as names and set/not set only', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('SYNCING_SERVER_GRPC_URL: set')
    expect(report).toContain('VALET_TOKEN_SECRET: not set')
    // The inert marking is the whole point of including presence at all.
    expect(report).toContain('(inert)')
  })

  it('says the checks were not run rather than implying they passed', () => {
    expect(buildDiagnosticsReport(input())).toContain('Not run.')
  })

  it('reports check outcomes when they have been run', () => {
    const report = buildDiagnosticsReport(
      input({
        outcomes: [{ name: 'Ticket issuance', passed: false, detail: 'irrelevant', reportDetail: 'Refused with 503.' }],
      }),
    )

    expect(report).toContain('[FAIL] Ticket issuance — Refused with 503.')
  })

  it('says so when the topology was not reported, instead of guessing one', () => {
    const report = buildDiagnosticsReport(input({ payload: { ...payload, deployment: undefined } }))

    expect(report).toContain('Topology: not reported')
    expect(report).toContain('generic advice')
  })

  it('still produces a usable report when the server answered nothing at all', () => {
    const report = buildDiagnosticsReport(
      input({ payload: undefined, transport: undefined, loadError: 'The server answered 403.' }),
    )

    expect(report).toContain('The server answered 403.')
    expect(report).toContain('Server captured: not reported')
  })
})

describe('buildDiagnosticsReport — what it withholds', () => {
  /**
   * The server is made to misbehave in every string-bearing field the report
   * reads, including the one field that is ALLOWED to carry a thrown message on
   * screen (`detail`). None of it may reach the report.
   */
  const SECRETS = [
    'redis://admin:hunter2@redis.internal.example:6379',
    'syncing.internal.example:50051',
    'https://notes.internal.example',
    'super-secret-jwt-signing-key',
    'hunter2',
    'internal.example',
    '10.4.2.9',
  ]

  const poisoned: SyncDiagnosticsPayload = {
    ...payload,
    capturedAt: 'redis://admin:hunter2@redis.internal.example:6379',
    gate: {
      ...payload.gate,
      unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: 'set REDIS_URL to redis://admin:hunter2@redis.internal.example:6379' }],
      unmetCodes: ['REDIS_UNBOUND'],
      files: { advertised: false, unmetCondition: 'FILES_INTERNAL_URL', remedy: 'https://notes.internal.example' },
    },
    live: { capabilities: [], unavailabilityReasons: ['no-allowed-origins'], ticketAvailable: false },
  }

  it('cannot carry a value, an address or a credential even when the server sends one', () => {
    const report = buildDiagnosticsReport(
      input({
        payload: poisoned,
        outcomes: [
          {
            name: 'Capability descriptor',
            passed: false,
            // Exactly the shape a thrown fetch error takes. It is shown on the
            // panel and must not travel into a pasteable report.
            detail: 'FetchError: request to https://notes.internal.example/v1/sockets failed (10.4.2.9)',
            reportDetail: 'The request threw before an answer arrived.',
          },
        ],
      }),
    )

    for (const secret of SECRETS) {
      expect(report).not.toContain(secret)
    }
    expect(report).not.toMatch(/https?:\/\//)
    expect(report).not.toMatch(/redis:\/\//)
    expect(report).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
    // And it still says the useful thing.
    expect(report).toContain('REDIS_UNBOUND')
    expect(report).toContain('The request threw before an answer arrived.')
  })

  it('carries capture timestamps only when they are timestamps', () => {
    const report = buildDiagnosticsReport(input({ payload: poisoned }))

    // capturedAt is echoed, so a server that puts a DSN there must not have it
    // reprinted. The scan above covers it; this pins the intent explicitly.
    expect(report).not.toContain('hunter2')
  })
})
