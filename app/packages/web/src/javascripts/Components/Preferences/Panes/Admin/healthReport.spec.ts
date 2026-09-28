import { buildHealthReport, errorKind, type HealthReportInput } from './healthReport'

/**
 * Every string a hostile or merely careless server could put in the status payload,
 * one distinct value per field, so a leak names the field that leaked.
 *
 * This is the assertion that has to survive: a copy button makes this text far more
 * likely to be pasted into a chat, an issue or a support thread, so a field added
 * later that forwards server text must fail HERE rather than in someone's incident
 * channel. Extending the report without extending this list is the failure mode.
 */
const PLANTED = {
  authStatus: 'connected to db.internal.example.com:3306',
  serviceName: 'auth@db-primary.internal.example.com',
  serviceDetail: 'probe failed: https://user:hunter2@files.internal.example.com/v1/files',
  container: 'db-primary.internal.example.com',
  provider: 'custom-provider-at-10.1.2.3',
  version: 'v1.2.3-build@ci.internal.example.com',
  trustProxy: '10.0.0.0/8,192.168.1.1',
  clientIpHeader: 'x-forwarded-for-internal',
  revision: 'token-sk-live-abcdef0123456789',
  noteTitle: 'My private note about the merger',
  accountUuid: '1f2e3d4c-5b6a-7980-9a8b-7c6d5e4f3a2b',
  email: 'owner@example.test',
}

function hostileInput(overrides: Partial<HealthReportInput> = {}): HealthReportInput {
  return {
    serverStatus: {
      services: [
        {
          name: PLANTED.serviceName,
          reachable: true,
          status: 'ok',
          detail: PLANTED.serviceDetail,
          responseTimeMs: 42,
        },
        // A well-formed row alongside the hostile one, so the scan cannot pass
        // merely because everything was rejected.
        { name: 'api-gateway', reachable: true, status: 'ok', detail: PLANTED.serviceDetail, responseTimeMs: 7 },
      ],
      masterSwitches: {
        ocrServerEnabled: true,
        workflowsEnabled: false,
        assistantConfigured: true,
        assistantProviders: ['anthropic', PLANTED.provider],
        updateCheckConfigured: true,
        currentVersion: PLANTED.version,
      },
      health: {
        gateway: { redis: true },
        auth: {
          reachable: true,
          status: PLANTED.authStatus,
          checks: { db: true, redis: false, [PLANTED.noteTitle]: true },
        },
      },
      network: { trustProxy: PLANTED.trustProxy, clientIpHeader: PLANTED.clientIpHeader },
      // Fields this report does not know about at all must not be echoed either.
      accountUuid: PLANTED.accountUuid,
      ownerEmail: PLANTED.email,
    },
    dockerControl: { enabled: true, available: true, containers: ['cache', PLANTED.container] },
    transport: { state: 'READY', operations: ['SYNC_ITEMS', 'API_RPC'] },
    deploymentMarker: { revision: PLANTED.revision, version: PLANTED.version },
    statusError: null,
    generatedAt: '2026-09-28T12:00:00.000Z',
    ...overrides,
  }
}

describe('buildHealthReport', () => {
  describe('the copyable report can never carry a secret-shaped value', () => {
    it('leaks none of the planted values, in any field', () => {
      const report = buildHealthReport(hostileInput())

      for (const [field, secret] of Object.entries(PLANTED)) {
        expect(`${field}: ${report}`).not.toContain(secret)
      }
    })

    it('leaks nothing when the server half is absent either', () => {
      const report = buildHealthReport(
        hostileInput({ serverStatus: undefined, statusError: 'The server answered 401 for the status endpoint.' }),
      )

      for (const [field, secret] of Object.entries(PLANTED)) {
        expect(`${field}: ${report}`).not.toContain(secret)
      }
    })

    it('never prints per-service failure detail, which is where addresses land', () => {
      const report = buildHealthReport(hostileInput())

      expect(report).not.toContain('probe failed')
      expect(report).toContain('Per-service failure detail is deliberately omitted')
    })

    it('reports address-shaped configuration as presence, never as a value', () => {
      const report = buildHealthReport(hostileInput())

      expect(report).toContain('- TRUST_PROXY: set (value withheld)')
      expect(report).toContain('- CLIENT_IP_HEADER: set (value withheld)')
      expect(buildHealthReport(hostileInput({ serverStatus: { network: {} } }))).toContain(
        '- TRUST_PROXY: not set (built-in default)',
      )
    })

    it('counts unrecognised names rather than naming them', () => {
      const report = buildHealthReport(hostileInput())

      expect(report).toContain('Additional auth dependencies reported (names withheld): 1')
      expect(report).toContain('Additional containers reported (names withheld): 1')
      expect(report).toContain('(+1 unrecognised, names withheld)')
    })
  })

  describe('what it does report', () => {
    it('keeps the client half separate from the server half', () => {
      const report = buildHealthReport(hostileInput())

      expect(report).toContain('## Known by this client')
      expect(report).toContain('- Negotiated operations: SYNC_ITEMS, API_RPC')
      expect(report).toContain('## Reported by the server')
      expect(report).toContain('- Auth server reachable: yes')
      expect(report).toContain('- Auth dependency "db": yes')
      expect(report).toContain('- Auth dependency "redis": no')
      expect(report).toContain('- Gateway cache (Redis): yes')
    })

    it('admits a well-formed service row and its latency', () => {
      const report = buildHealthReport(hostileInput())

      expect(report).toContain('- api-gateway: status ok, reachable yes, latency 7 ms')
      // The hostile name is refused rather than printed.
      expect(report).toContain('- withheld (unrecognised format): status ok, reachable yes, latency 42 ms')
    })

    it('admits a real version token but refuses a decorated one', () => {
      expect(buildHealthReport(hostileInput())).toContain('- Current version: withheld (unrecognised format)')
      expect(
        buildHealthReport(hostileInput({ serverStatus: { masterSwitches: { currentVersion: 'rel-1.2.3' } } })),
      ).toContain('- Current version: rel-1.2.3')
    })
  })

  describe('a failed server read degrades to "did not answer", never to "no"', () => {
    it('says the server did not answer, and says so is not a refusal', () => {
      const report = buildHealthReport(
        hostileInput({ serverStatus: undefined, statusError: 'The server answered 401 for the status endpoint.' }),
      )

      expect(report).toContain('The server did not answer the status endpoint')
      expect(report).toContain('this is NOT a report that the server answered "no"')
      expect(report).toContain('- Reported reason: unauthorized')
      // None of the server-sourced sections may render at all.
      expect(report).not.toContain('- Auth server reachable:')
      expect(report).not.toContain('## Services')
      expect(report).not.toContain('## Feature switches')
    })

    it('names the admin role when that is why the server half is unreadable', () => {
      const report = buildHealthReport(
        hostileInput({ serverStatus: undefined, statusError: 'The server answered 403.', isAdmin: false }),
      )

      expect(report).toContain('does not hold the admin role')
      expect(report).toContain('- Reported reason: forbidden')
    })

    it('still reports everything this client knows without the server', () => {
      const report = buildHealthReport(hostileInput({ serverStatus: undefined, statusError: 'unreachable' }))

      expect(report).toContain('## Known by this client')
      expect(report).toContain('- Negotiated operations: SYNC_ITEMS, API_RPC')
      expect(report).toContain('## Deployment')
    })
  })

  describe('errorKind', () => {
    it('maps a status-bearing message to a closed code', () => {
      expect(errorKind('The server answered 401 for the diagnostics endpoint.')).toBe('unauthorized')
      expect(errorKind('The server answered 403.')).toBe('forbidden')
      expect(errorKind('The server answered 404.')).toBe('not-found')
      expect(errorKind('Could not reach the endpoint.')).toBe('unreachable')
      expect(errorKind('something else entirely')).toBe('other')
    })
  })
})
