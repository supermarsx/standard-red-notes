import { buildDiagnosticsReport, buildDiagnosticsSummary, type DiagnosticsReportInput } from './diagnosticsReport'
import {
  CHECK_IDS,
  CHECKS,
  describeMarkerCheck,
  readingsFrom,
  type CheckId,
  type CheckOutcome,
} from './diagnosticChecks'
import { CLIENT_KNOWN_OPERATIONS, type SyncDiagnosticsPayload } from './syncDiagnostics'
import {
  safeConstant,
  safeCount,
  safeNotAvailableHere,
  safeTokens,
  SECTION_IDS,
  SECTION_TITLE,
  type SectionId,
  type SectionModel,
  type Verdict,
} from './diagnosticsSections'
import { buildWebsocketSection } from './websocketSection'
import { buildEnvironmentSection } from './environmentSection'
import { buildBackendSection } from './backendSection'
import { buildAccountSection } from './accountSection'
import { buildBrowserSection } from './browserSection'

/**
 * The report is written on the assumption that it becomes public. These tests
 * split into two halves: it must SAY enough to be worth pasting, and it must
 * WITHHOLD everything that would make pasting it a mistake.
 */

/**
 * A planted value with NO structure for a denylist to match — the class of secret
 * `sanitizeServerCopy` says in its own comment that it cannot catch. Built from
 * markers rather than plausible prose so no fragment collides with the build's own
 * copy, and asserted by head, middle AND tail: the tail sits past 60 characters,
 * which is where a peer's planted fragments silently landed behind a truncation
 * earlier tonight.
 */
const PLANTED_HEAD = 'SRNLEAKHEAD41'
const PLANTED_MIDDLE = 'SRNLEAKMIDDLE62'
const PLANTED_TAIL = 'SRNLEAKTAIL83'
const PLANTED_OPAQUE_OPERATION = `${PLANTED_HEAD}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_MIDDLE}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_TAIL}`
const PLANTED_FRAGMENTS = [PLANTED_HEAD, PLANTED_MIDDLE, PLANTED_TAIL, PLANTED_OPAQUE_OPERATION]

/**
 * The same markers in the shape of an environment variable NAME, for the
 * presence-key scan below. Upper snake case and inside the 64-character limit,
 * so the shape floor ADMITS it: that is the point of this plant, and the reason
 * a scan built only from the two above would pass against the defect.
 */
const PLANTED_ENV_SHAPED_KEY = `${PLANTED_HEAD}_WWWWWWWWW_${PLANTED_MIDDLE}_WWWWWWWWW_${PLANTED_TAIL}`

/**
 * The same two shapes for the BOOT GATE's own strings. `PLANTED_OPAQUE` carries
 * no scheme, no dot and no colon, so there is nothing in `sanitizeServerCopy`
 * for any pattern to match; `PLANTED_SHAPED` is the same marker alphabet in upper
 * snake case, which is the shape of a legitimate condition code and therefore
 * the class a shape floor would admit.
 */
const PLANTED_OPAQUE = 'zqx7v2-kkmr9pt4-jjdw3bn8-xxhf6cs1-vvqz5gy0-ttnb8dk2'
const PLANTED_SHAPED = 'ZQX7V2_KKMR9PT4_JJDW3BN8_XXHF6CS1_VVQZ5GY0'

/** Head, middle and tail, 20 characters each — see the note above. */
const windowsOf = (value: string): readonly string[] => {
  const middle = Math.max(0, Math.floor((value.length - 20) / 2))
  return [value.slice(0, 20), value.slice(middle, middle + 20), value.slice(-20)]
}

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
    // The structured verdict as a current server sends it. The boolean above is
    // derived FROM this state server-side; the report reads the state.
    syncItems: {
      state: 'WITHHELD',
      cause: 'DURABLE_BACKEND_UNBOUND',
      remedy: 'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL',
      probe: 'NEVER_PROBED',
    },
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
  checks: readingsFrom({}),
  loadError: null,
  generatedAt: '2026-08-27T12:00:00.000Z',
  ...overrides,
})

/** One check's outcome, with a closed result and a screen-only detail. */
const outcomeOf = (
  id: CheckId,
  state: CheckOutcome['state'],
  result: CheckOutcome['result'],
  detail = 'screen-only detail',
): CheckOutcome => ({ id, state, result, detail })

/**
 * The five section models, built from the same payload the rest of this file
 * uses. Real models rather than hand-made ones: a fixture that fakes a
 * `SectionModel` would also fake `reportLines`, and the thing under test is
 * whether the REAL lines of all five arrive.
 */
const sections = (): Record<SectionId, SectionModel> => ({
  websocket: buildWebsocketSection({ payload, transport: { state: 'READY', operations: ['FILES_V1'] } }),
  environment: buildEnvironmentSection({ topology: payload.deployment }),
  backend: buildBackendSection({ topology: payload.deployment }),
  account: buildAccountSection({ observations: { signedIn: true } }),
  browser: buildBrowserSection({ observations: { pageScheme: 'https:' } }),
})

describe('buildDiagnosticsReport — what it says', () => {
  it('carries every section an issue reader needs', () => {
    const report = buildDiagnosticsReport(input())

    for (const heading of [
      '## Summary',
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

  /**
   * *** ALL FIVE SECTIONS, IN THE CONTRACT'S ORDER. ***
   *
   * The pane is five topic sections plus three tabs that are not topics, and a
   * report that silently omits one is worse than no report: the reader cannot
   * tell a section that was dropped from a section that had nothing to say. The
   * builder iterates `SECTION_IDS` rather than the caller's object, so this also
   * pins that a sixth section added to the contract cannot be skipped.
   */
  it('carries every section in the contract, in the contract’s order', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))

    const positions = SECTION_IDS.map((id) => report.indexOf(`## ${SECTION_TITLE[id]}`))
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1)
    }
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })

  it('carries each section’s own worst verdict and its blocks, not just its heading', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))

    expect(report.split('\n- Status: ').length - 1).toBe(SECTION_IDS.length)
    for (const block of [
      '### Socket lane and boot gate',
      '### Deployment identity',
      '### Durable storage',
      '### Account and access',
      '### Clock',
    ]) {
      expect(report).toContain(block)
    }
  })

  /**
   * The caller is required to supply all five by the type, so an absent object
   * can only be a call site that predates them. It says so in words rather than
   * ending four sections early and leaving the reader to notice.
   */
  it('says the sections are missing rather than quietly ending early', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('five topic sections were not supplied')
    for (const id of SECTION_IDS) {
      expect(report).not.toContain(`## ${SECTION_TITLE[id]}`)
    }
  })

  /** A section's lines are all `SafeValue`s, so the public-report rule holds. */
  it('admits nothing from a section but names, booleans, codes, counts and durations', () => {
    const poisoned: SyncDiagnosticsPayload = {
      ...payload,
      gate: {
        ...payload.gate,
        syncItems: { state: 'redis://admin:hunter2@redis.internal.example:6379', cause: 'hunter2', remedy: null },
      },
    }
    const report = buildDiagnosticsReport(
      input({
        sections: {
          ...sections(),
          websocket: buildWebsocketSection({ payload: poisoned }),
        },
      }),
    )

    expect(report).not.toContain('hunter2')
    expect(report).not.toMatch(/redis:\/\//)
  })

  it('separates the lane verdict from the SYNC_ITEMS verdict', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('Sync lane enabled: yes')
    expect(report).toContain('SYNC_ITEMS advertised: no')
  })

  /**
   * The SYNC_ITEMS verdict, in the report that gets pasted into an issue.
   *
   * `cause` is a closed enum re-validated against this build's own list before it
   * is printed, so the code in the report is a literal from this build. The
   * explanation is constant copy from this build too — the `- What that means:`
   * shape the read-failure branch already uses — because the whole point of this
   * report is that someone else reads it without the panel in front of them.
   */
  describe('the SYNC_ITEMS verdict', () => {
    const withVerdict = (syncItems: NonNullable<NonNullable<SyncDiagnosticsPayload['gate']>['syncItems']>) =>
      input({ payload: { ...payload, gate: { ...payload.gate, syncItems } } })

    it('names the cause and what it means when SYNC_ITEMS is withheld', () => {
      const report = buildDiagnosticsReport(
        withVerdict({
          state: 'WITHHELD',
          cause: 'DURABLE_BACKEND_NOT_READY',
          remedy: 'the durable command port is bound but FAILED the readiness check the handshake itself makes',
          probe: 'NOT_READY',
        }),
      )

      expect(report).toContain('- SYNC_ITEMS advertised: no')
      expect(report).toContain('- SYNC_ITEMS cause: DURABLE_BACKEND_NOT_READY')
      expect(report).toContain('- What that means:')
      expect(report).toContain('AUTH_JWT_SECRET')
      expect(report).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(report).toContain('  - The server reports: the durable command port is bound')
    })

    it('reports the third state as undetermined rather than as a no', () => {
      const report = buildDiagnosticsReport(withVerdict({ state: 'NOT_OBSERVED', cause: 'PROBE_FAILED', remedy: null }))

      expect(report).toContain('- SYNC_ITEMS advertised: could not be determined')
      expect(report).not.toContain('- SYNC_ITEMS advertised: no')
      expect(report).not.toContain('- SYNC_ITEMS advertised: yes')
      expect(report).toContain('- SYNC_ITEMS cause: PROBE_FAILED')
      expect(report).toContain('unknown rather than no')
    })

    it('says nothing beyond yes when SYNC_ITEMS is advertised', () => {
      const report = buildDiagnosticsReport(withVerdict({ state: 'ADVERTISED', cause: null, remedy: null }))

      expect(report).toContain('- SYNC_ITEMS advertised: yes')
      expect(report).not.toContain('- SYNC_ITEMS cause:')
      expect(report).not.toContain('- What that means:')
    })

    /**
     * *** BACKWARD COMPATIBILITY, PINNED. *** A server older than the verdict
     * sends only the boolean, and on those builds it was derived from whether a
     * proxy OBJECT existed rather than from the predicate the handshake asks — so a
     * `true` there was printed over sockets that withheld the operation. The report
     * states that it cannot say, and never echoes the claim.
     */
    it('claims nothing from a payload that predates the verdict', () => {
      const report = buildDiagnosticsReport(
        input({ payload: { ...payload, gate: { ...payload.gate, syncItems: undefined, syncItemsAdvertised: true } } }),
      )

      expect(report).toContain('- SYNC_ITEMS advertised: could not be determined')
      expect(report).not.toContain('- SYNC_ITEMS advertised: yes')
      expect(report).toContain('does not report the SYNC_ITEMS verdict')
      expect(report).toContain('- What that means:')
    })

    it('prints the cause code only when this build recognises it', () => {
      const report = buildDiagnosticsReport(
        withVerdict({ state: 'WITHHELD', cause: 'DURABLE_BACKEND_ON_FIRE', remedy: null }),
      )

      expect(report).not.toContain('DURABLE_BACKEND_ON_FIRE')
      expect(report).toContain('- SYNC_ITEMS advertised: no')
      expect(report).toContain('does not recognise')
    })
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
    // An operation only the SERVER knows about is still reported, and still gets
    // a fix — as a count, because its name is a string the server chose and this
    // document is written to be pasted in public. The row it used to get printed
    // that name through a denylist.
    expect(report).not.toContain('| FUTURE_LANE |')
    expect(report).toContain('- Operations this build does not recognise: 1')
    expect(report).toContain('Client update')
  })

  it('lists configuration presence as names and set/not set only', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('SYNCING_SERVER_GRPC_URL: set')
    expect(report).toContain('VALET_TOKEN_SECRET: not set')
    // The inert marking is the whole point of including presence at all.
    expect(report).toContain('(inert)')
  })

  /**
   * EVERY registered check is listed, run or not, so "which checks exist, and
   * which were never run" has one answer — and the count is over the registry.
   * "5 of 5 passed" over a registry of nine is the flattering denominator.
   */
  it('lists every registered check as not tested rather than implying any of them passed', () => {
    const report = buildDiagnosticsReport(input())

    for (const id of CHECK_IDS) {
      expect(report).toContain(`- [NOT TESTED] ${CHECKS[id].title}: not run`)
    }
    expect(report).toContain(`- Checks: 0 of ${CHECK_IDS.length} checks passed, ${CHECK_IDS.length} not run yet.`)
    expect(report).not.toContain('checks passed.\n- Checks')
  })

  it('reports a check’s closed result under its status once it has run', () => {
    const report = buildDiagnosticsReport(
      input({
        checks: readingsFrom({
          ticket: outcomeOf('ticket', 'fail', safeTokens(safeConstant('refused with HTTP'), safeCount(503))),
        }),
      }),
    )

    expect(report).toContain('- [NOT WORKING] Socket ticket: refused with HTTP 503')
    // The screen-only half of the outcome is not in the document at all.
    expect(report).not.toContain('screen-only detail')
  })

  /**
   * The copyable report is the surface the operator pastes, so it is the surface
   * that said `[FAIL]` over a correct steady state. The third tag is asserted
   * ALONGSIDE the two that still mean what they meant: a tag that quietly turned
   * every failure into a note would satisfy half of this on its own.
   */
  it('tags a check with nothing to test here as N/A, and keeps OK and NOT WORKING meaning what they mean', () => {
    const report = buildDiagnosticsReport(
      input({
        checks: readingsFrom({
          capabilities: outcomeOf('capabilities', 'pass', safeConstant('advertises 1 capability entry')),
          ticket: outcomeOf('ticket', 'fail', safeTokens(safeConstant('refused with HTTP'), safeCount(503))),
          negotiation: outcomeOf(
            'negotiation',
            'not-applicable',
            safeNotAvailableHere('another tab holds the socket lane'),
          ),
        }),
      }),
    )

    expect(report).toContain('- [N/A] This tab’s live socket: not available here (another tab holds the socket lane)')
    expect(report).toContain('- [OK] Capability descriptor: advertises 1 capability entry')
    expect(report).toContain('- [NOT WORKING] Socket ticket: refused with HTTP 503')
    expect(report).not.toContain('[NOT WORKING] This tab’s live socket')
    // It leaves the denominator, and is named as what it is.
    // The denominator is the REGISTRY less the one with nothing to test, so a
    // check added later cannot be left out of it.
    expect(report).toContain(
      `1 of ${CHECK_IDS.length - 1} checks passed, ${CHECK_IDS.length - 3} not run yet, 1 did not pass, 1 had nothing to test here.`,
    )
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
      // The SYNC_ITEMS remedy is a frozen constant in the contract; this is the
      // future server change that breaks that assumption.
      syncItems: {
        state: 'WITHHELD',
        cause: 'DURABLE_BACKEND_NOT_READY',
        remedy: 'the durable backend at syncing.internal.example:50051 refused',
        probe: 'NOT_READY',
      },
      unmetPreconditions: [
        { code: 'REDIS_UNBOUND', remedy: 'set REDIS_URL to redis://admin:hunter2@redis.internal.example:6379' },
      ],
      unmetCodes: ['REDIS_UNBOUND'],
      files: { advertised: false, unmetCondition: 'FILES_INTERNAL_URL', remedy: 'https://notes.internal.example' },
    },
    live: { capabilities: [], unavailabilityReasons: ['no-allowed-origins'], ticketAvailable: false },
  }

  it('cannot carry a value, an address or a credential even when the server sends one', () => {
    const report = buildDiagnosticsReport(
      input({
        payload: poisoned,
        checks: readingsFrom({
          capabilities: outcomeOf(
            'capabilities',
            'fail',
            safeConstant('the request did not complete'),
            // Exactly the shape a thrown fetch error takes. It is shown on the
            // panel and must not travel into a pasteable report.
            'FetchError: request to https://notes.internal.example/v1/sockets failed (10.4.2.9)',
          ),
        }),
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
    expect(report).toContain('- [NOT WORKING] Capability descriptor: the request did not complete')
  })

  /**
   * *** THE LEAK THE CHECKS BLOCK ACTUALLY HAD. *** A check used to hand the report
   * a free string described as constant copy, and the marker check built that
   * string from the marker's revision — a value served by whatever fronts the web
   * bundle, passed through a denylist that prints anything with no address shape.
   * So an OPAQUE value in that field reached this document verbatim, twenty lines
   * below a Deployment block that refused the same value by shape.
   *
   * The sentinel is opaque on purpose: an address-shaped one would be caught by
   * the denylist too, and the test could not tell which mechanism saved it. It is
   * planted through the REAL check function, so the assertion is about the code
   * that runs and not about a hand-built outcome.
   */
  it('cannot carry a marker value through the checks, however the marker is shaped', () => {
    // Opaque AND outside the version shape: a version token is admitted by
    // shape on purpose, so a sentinel that happened to look like one would be
    // printed by design and prove nothing about the checks.
    const OPAQUE = ['zq', 'marker', 'sentinel', 'k9x2', 'vv7'].join('~ ')
    const SHAPED = ['build', 'internal.example.test'].join('@')

    for (const planted of [OPAQUE, SHAPED]) {
      const marker = { revision: planted, version: planted }
      const outcome = describeMarkerCheck(marker, 'answered')
      const report = buildDiagnosticsReport(
        input({ deploymentMarker: marker, checks: readingsFrom({ marker: { id: 'marker', ...outcome } }) }),
      )

      // Not a pass, and the result is this build's own words.
      expect(outcome.state).toBe('unknown')
      expect(String(outcome.result)).toBe('no usable build identity in the marker')
      for (const window of [planted, planted.slice(0, 12), planted.slice(-12)]) {
        expect(report).not.toContain(window)
      }
      // Not vacuous: the check's own line is in the document.
      expect(report).toContain('] Deployment marker: no usable build identity in the marker')
    }

    // And a REAL revision does print, so the admission is a shape and not a refusal of everything.
    const real = 'ab3f90'.repeat(6) + 'cdef'
    const stamped = describeMarkerCheck({ revision: real, version: 'rel-1.2.3' }, 'answered')
    expect(stamped.state).toBe('pass')
    expect(String(stamped.result)).toBe(`revision ${real}`)
  })

  it('carries capture timestamps only when they are timestamps', () => {
    const report = buildDiagnosticsReport(input({ payload: poisoned }))

    // capturedAt is echoed, so a server that puts a DSN there must not have it
    // reprinted. The scan above covers it; this pins the intent explicitly.
    expect(report).not.toContain('hunter2')
  })

  /**
   * The marker is served by whatever fronts the web bundle and used to reach the
   * report through `sanitizeServerCopy` alone — a denylist, which by its own
   * admission cannot catch a secret with no structure. Both of these leaked in
   * practice: the first has no address shape to match at all, and the second was
   * printed as `v1.2.3-build@[address withheld]`, host removed, prefix intact.
   */
  it('refuses a deployment marker that does not match the shape the Dockerfile validates', () => {
    const report = buildDiagnosticsReport(
      input({
        deploymentMarker: {
          revision: 'token-sk-live-abcdef0123456789',
          version: 'v1.2.3-build@ci.internal.example.com',
        },
      }),
    )

    expect(report).not.toContain('token-sk-live-abcdef0123456789')
    expect(report).not.toContain('v1.2.3-build')
    expect(report).toContain('- Revision: withheld (unrecognised format)')
    expect(report).toContain('- Version: withheld (unrecognised format)')
  })

  /**
   * *** THE REPORT HALF OF THE OPERATION-NAME LEAK. ***
   *
   * The Capabilities matrix printed `row.operation` through `sanitizeServerCopy`,
   * and the client-gap remedy under it joined the same names. A live probe
   * measured what that bought: an address-shaped operation name was withheld and
   * the opaque `hunter2` printed intact, in this very table, in a document whose
   * single purpose is to be pasted into an issue.
   *
   * The planted value has no shape to match, and `[address withheld]` is asserted
   * ABSENT on this path: if the redactor is ever reinstated as the defence, the
   * table starts printing that instead of nothing and this fails.
   */
  it('counts the operations it cannot name in the Capabilities matrix, and names none of them', () => {
    const report = buildDiagnosticsReport(
      input({
        payload: {
          ...payload,
          protocol: {
            version: 1,
            serverOperations: ['SYNC_ITEMS', PLANTED_OPAQUE_OPERATION, 'syncing.internal.example:50051'],
          },
        },
      }),
    )

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(report).not.toContain(fragment)
    }
    expect(report).not.toContain('syncing.internal.example')
    expect(report).not.toContain('[address withheld]')
    // The fact survives as a count, in the table's own section and in the remedy.
    expect(report).toContain('- Operations this build does not recognise: 2')
    expect(report).toContain('2 operations this build does not recognise')
    // And the table still names every operation this build declares, so the
    // count is read against a list rather than on its own.
    for (const operation of CLIENT_KNOWN_OPERATIONS) {
      expect(report).toContain(`| ${operation} |`)
    }
  })

  /**
   * *** THE SAME DEFECT IN THE TOPOLOGY BLOCK, MEASURED. ***
   *
   * `describeTopology` flattens four closed-union topology fields with
   * `topology.mode ?? 'unknown'` — raw — and those unions are a compile-time
   * claim about JSON cast at the boundary, exactly as `knownToken` says. Fed an
   * opaque string in all four, this block printed all four verbatim, and
   * `modeNote[topology.mode ?? 'unset']` printed the literal "undefined" as the
   * note beside them.
   *
   * This report is the only consumer of that helper, so the admission lives here.
   * `recorded: true` matters: the helper short-circuits to "not reported"
   * otherwise and the fields are never read.
   */
  it('refuses a topology enum value that is not one of this build’s own members', () => {
    const hostile = {
      ...payload.deployment,
      recorded: true,
      mode: PLANTED_OPAQUE_OPERATION,
      serviceProxySetting: PLANTED_OPAQUE_OPERATION,
      boundServiceProxy: PLANTED_OPAQUE_OPERATION,
      cacheSetting: PLANTED_OPAQUE_OPERATION,
    } as unknown as SyncDiagnosticsPayload['deployment']
    const report = buildDiagnosticsReport(input({ payload: { ...payload, deployment: hostile } }))

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(report).not.toContain(fragment)
    }
    expect(report).toContain('- MODE: withheld (unrecognised)')
    expect(report).toContain('- Service proxy in use: withheld (unrecognised)')
    // The note for an unrecognised MODE is `undefined` at runtime, and printing
    // that word is worse than omitting it: it reads as a bug in the server.
    expect(report).not.toContain('— undefined')
    // A denylist is not what is doing the work here either.
    expect(report).not.toContain('[address withheld]')
  })

  it('still prints every legal topology member, so the guard is not a blanket refusal', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('- MODE: self-hosted')
    expect(report).toContain('- SERVICE_PROXY_TYPE: unset')
    expect(report).toContain('- Service proxy in use: http')
    expect(report).toContain('- CACHE_TYPE: redis')
    expect(report).toContain('- Redis bound: yes')
    expect(report).not.toContain('withheld (unrecognised)')
  })

  /**
   * *** THE SAME DEFECT IN `## Configuration presence`, MEASURED. ***
   *
   * `buildEnvironmentPresence` put a presence KEY it had never heard of into a
   * row through `sanitizeServerCopy` — a denylist — and this block printed the
   * result. A probe over the payload the live stack actually returns settled what
   * that bought: the address-shaped key was withheld, and the two opaque ones
   * printed into this very block verbatim, in a document whose single purpose is
   * to be pasted into an issue.
   *
   * The keys of an object off the wire are as much its content as its values, so
   * the rule is the one the rest of this report follows: name only what this
   * build declares, count the rest. The third plant is shaped like a variable
   * name on purpose — a shape floor admits that one, which is why shape was never
   * the answer here either.
   */
  it('counts the presence keys it cannot name in Configuration presence, and names none of them', () => {
    const report = buildDiagnosticsReport(
      input({
        payload: {
          ...payload,
          deployment: {
            ...payload.deployment,
            presence: {
              ...payload.deployment?.presence,
              [PLANTED_OPAQUE_OPERATION]: true,
              [PLANTED_ENV_SHAPED_KEY]: false,
              'syncing.internal.example:50051': true,
            },
          },
        },
      }),
    )

    for (const fragment of [...PLANTED_FRAGMENTS, PLANTED_ENV_SHAPED_KEY]) {
      expect(report).not.toContain(fragment)
    }
    expect(report).not.toContain('syncing.internal.example')
    expect(report).not.toContain('[address withheld]')
    expect(report).toContain('- Variables reported by a newer server that this build does not recognise: 3')
    // Not vacuous: the variables this build declares are still named, so the
    // count is read against a list rather than on its own.
    expect(report).toContain('- REDIS_URL: set (required)')
  })

  /**
   * *** THE SAME DEFECT IN `## Boot gate`, MEASURED. ***
   *
   * Four strings reached this block through `sanitizeServerCopy` alone: an unmet
   * precondition's CODE on its own line, the server's REMEDY for it through
   * `remedyForPrecondition`'s generic branch, a live refusal REASON, and the
   * FILES_V1 sub-gate's CONDITION. A probe over the live stack's own payload
   * settled what the denylist bought: a marker-built value with no address shape
   * printed intact in all four, and so did one shaped exactly like a legitimate
   * upper snake case condition code — the class a shape floor admits.
   *
   * The sweep above this one could not see any of it: it plants only
   * address-shaped values, which a denylist AND a correct allowlist both catch,
   * so it cannot discriminate between the two mechanisms.
   */
  it('counts the gate conditions, reasons and sub-gate conditions it cannot name, and names none of them', () => {
    const hostile: SyncDiagnosticsPayload = {
      ...payload,
      gate: {
        ...payload.gate,
        unmetPreconditions: [
          { code: PLANTED_OPAQUE, remedy: PLANTED_OPAQUE },
          { code: PLANTED_SHAPED, remedy: PLANTED_SHAPED },
        ],
        unmetCodes: [PLANTED_OPAQUE, PLANTED_SHAPED],
        files: { advertised: false, unmetCondition: PLANTED_SHAPED, remedy: PLANTED_OPAQUE },
        host: { unmetCondition: PLANTED_OPAQUE, remedy: PLANTED_SHAPED },
      },
      live: { capabilities: [], unavailabilityReasons: [PLANTED_OPAQUE, PLANTED_SHAPED], ticketAvailable: false },
    }
    const report = buildDiagnosticsReport(input({ payload: hostile, sections: sections() }))

    for (const fragment of [...windowsOf(PLANTED_OPAQUE), ...windowsOf(PLANTED_SHAPED)]) {
      expect(report).not.toContain(fragment)
    }
    // The denylist is NOT what is doing the work: its presence here would mean it
    // had been reinstated as the defence.
    expect(report).not.toContain('[address withheld]')
    // Every fact survives as a count.
    expect(report).toContain('- Conditions this build does not recognise: 2')
    expect(report).toContain('- Reasons this build does not recognise: 2')
    expect(report).toContain('2 unmet conditions outside the closed set this build knows')
    expect(report).toContain('- FILES_V1 advertised: no (a condition this build does not recognise)')
  })

  it('still names a condition, a reason and a sub-gate condition inside their closed sets', () => {
    const report = buildDiagnosticsReport(
      input({
        payload: {
          ...payload,
          gate: {
            ...payload.gate,
            unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: PLANTED_OPAQUE }],
            unmetCodes: ['REDIS_UNBOUND'],
            files: { advertised: false, unmetCondition: 'VALET_TOKEN_SECRET', remedy: PLANTED_OPAQUE },
          },
          live: { capabilities: [], unavailabilityReasons: ['no-allowed-origins'], ticketAvailable: false },
        },
      }),
    )

    expect(report).toContain('  - REDIS_UNBOUND')
    expect(report).toContain('  - no-allowed-origins')
    expect(report).toContain('- FILES_V1 advertised: no (VALET_TOKEN_SECRET)')
    // The remedies beside them are this build's own copy, naming the variable and
    // never the server's sentence.
    expect(report).toContain('WEBSOCKET_SYNC_ALLOWED_ORIGINS')
    for (const fragment of windowsOf(PLANTED_OPAQUE)) {
      expect(report).not.toContain(fragment)
    }
  })

  it('reports a zero rather than omitting the line, because none is a reading', () => {
    const report = buildDiagnosticsReport(
      input({ payload: { ...payload, protocol: { version: 1, serverOperations: ['SYNC_ITEMS'] } } }),
    )

    expect(report).toContain('- Operations this build does not recognise: 0')
    // The same rule for the gate's own count: the fixture's one unmet condition
    // IS one this build knows, and saying so is a reading rather than silence.
    expect(report).toContain('- Conditions this build does not recognise: 0')
  })

  it('prints the presence count at zero, and omits it entirely when no presence block was reported', () => {
    expect(buildDiagnosticsReport(input())).toContain(
      '- Variables reported by a newer server that this build does not recognise: 0',
    )

    // A server that reported no presence block at all says so in words. A `0`
    // there would be a measurement of something nobody sent.
    const unreported = buildDiagnosticsReport(input({ payload: { ...payload, deployment: undefined } }))
    expect(unreported).toContain('Not reported by this server build.')
    expect(unreported).not.toContain('Variables reported by a newer server')
  })

  it('still prints a real revision, a real version and the unstamped sentinel', () => {
    const real = 'ab3f90'.repeat(6) + 'cdef'

    expect(buildDiagnosticsReport(input({ deploymentMarker: { revision: real, version: 'rel-1.2.3' } }))).toContain(
      `- Revision: ${real}`,
    )
    expect(buildDiagnosticsReport(input({ deploymentMarker: { revision: real, version: 'rel-1.2.3' } }))).toContain(
      '- Version: rel-1.2.3',
    )
    expect(buildDiagnosticsReport(input())).toContain('- Revision: unstamped')
  })
})

/**
 * *** THE ANSWER, BEFORE THE EVIDENCE. ***
 *
 * Measured on a realistic self-hosted deployment, the previous report was 445
 * lines over 12 sections and 39 blocks; the first `broken` finding sat at line
 * 171 under three healthy blocks and the last at line 331 under about forty more,
 * and every one of the thirteen findings reached the document as exactly
 * `- Finding: CODE verdict` — no title, no detail and no remedy, because
 * `buildSectionModel` dropped `finding.remedy` on the floor. Nine fully-written
 * remedies existed in the model and none of them was in the document the operator
 * pastes.
 *
 * These tests pin the four properties that fixed it, and each one is written so
 * that a restructure which merely moved text around would fail: the ordering is
 * asserted on POSITIONS, the de-duplication on OCCURRENCE COUNTS, and the summary
 * on what it does NOT carry.
 */
describe('buildDiagnosticsReport — leading with the answer', () => {
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  it('carries the generated instant, the capture instant and the build identity in its first lines', () => {
    const head = buildDiagnosticsReport(input({ sections: sections() }))
      .split('\n')
      .slice(0, 8)
      .join('\n')

    expect(head).toContain('Generated: 2026-08-27T12:00:00.000Z')
    expect(head).toContain('Server captured: 2026-08-27T00:00:00.000Z')
    // *** IDENTITY AT THE TOP. *** A paste that gets trimmed is trimmed from the
    // bottom, and "which commit is live" is the first question anyone asks.
    expect(head).toContain('Build: revision unstamped')
    expect(head).toContain('stamped no')
    expect(head).toContain('Transport in use:')
  })

  it('answers "is this healthy", "what is wrong" and "what first" before any evidence', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const verdict = report.indexOf('## Summary')
    const actions = report.indexOf('## What needs attention')

    expect(verdict).toBeGreaterThan(-1)
    expect(actions).toBeGreaterThan(verdict)
    // Every detail block comes after the answer.
    for (const heading of ['## Deployment', '## Topology', '## Boot gate', '## Capabilities', '## Checks']) {
      expect(report.indexOf(heading)).toBeGreaterThan(actions)
    }
    // The headline is the FIRST line under the heading: a status word, then one
    // sentence saying what the word is worth.
    const afterHeading = report
      .slice(verdict)
      .split('\n')
      .filter((line) => line.length > 0)[1]
    expect(afterHeading).toBe(
      '**NOT WORKING** — At least one thing is not working. The first entry under “What needs attention” says what.',
    )
    expect(report).toContain('- Do first: ')
    expect(report).toContain('- Findings needing action: ')
    expect(report).toContain('- Evidence below: ')
    expect(report).toContain('- Checks: ')
    expect(report).toContain('- Covers: ')
    expect(report).toContain('Does not cover: ')
    expect(report).toContain('- Ranked findings this build has no fix for: 0')
  })

  /**
   * *** ONE LINE PER SECTION, BEFORE ANY EVIDENCE. *** The first per-section
   * status used to be 175 lines down, behind five collapsed regions. The table is
   * parsed back here, cell by cell, and checked against the section MODELS — so a
   * table that printed a tidy constant, or the wrong section's counts, fails.
   */
  it('opens with a table giving each section its status and how many rows carry each one', () => {
    const models = sections()
    const report = buildDiagnosticsReport(input({ sections: models }))
    const table = report
      .slice(report.indexOf('## Summary'), report.indexOf('## What needs attention'))
      .split('\n')
      .filter((line) => line.startsWith('|'))
    const cells = (line: string): string[] =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())

    const header = cells(table[0])
    expect(header.slice(0, 2)).toEqual(['Section', 'Status'])
    // Worst first, and every status has a column.
    expect(header.slice(2)).toEqual(['NOT WORKING', 'DEGRADED', 'UNKNOWN', 'NOT TESTED', 'OK', 'INFO', 'N/A'])
    expect(table).toHaveLength(2 + SECTION_IDS.length)

    const verdictOfTag: Record<string, Verdict> = {
      'NOT WORKING': 'broken',
      DEGRADED: 'degraded',
      UNKNOWN: 'undetermined',
      'NOT TESTED': 'untested',
      OK: 'healthy',
      INFO: 'informational',
      'N/A': 'not-applicable',
    }
    SECTION_IDS.forEach((id, index) => {
      const row = cells(table[2 + index])
      const model = models[id]

      expect(row[0]).toBe(SECTION_TITLE[id])
      expect(verdictOfTag[row[1]]).toBe(model.worstVerdict)
      header.slice(2).forEach((tag, column) => {
        expect({ id, tag, count: Number(row[2 + column]) }).toEqual({ id, tag, count: model.counts[verdictOfTag[tag]] })
      })
      // Not vacuous: the counts add up to the rows the section really has.
      const total = row.slice(2).reduce((sum, cell) => sum + Number(cell), 0)
      expect(total).toBe(model.blocks.reduce((sum, block) => sum + block.rows.length, 0))
      expect(total).toBeGreaterThan(0)
    })
  })

  it('ranks the broken findings above the degraded ones, and numbers them', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const first = report.indexOf('### 1. ')
    const list = report.indexOf('## What needs attention')
    const broken = report.indexOf('NOT WORKING — ', list)
    const degraded = report.indexOf('DEGRADED — ', list)
    const unknown = report.indexOf('UNKNOWN — ', list)

    expect(first).toBeGreaterThan(-1)
    expect(broken).toBeGreaterThan(-1)
    expect(degraded).toBeGreaterThan(broken)
    expect(unknown).toBeGreaterThan(degraded)
    // The first entry IS the one the Verdict block named.
    const fixFirst = /- Do first: ([^,]+),/.exec(report)?.[1]
    expect(fixFirst).toBeDefined()
    expect(report.slice(first, first + 120)).toContain(fixFirst as string)
  })

  /**
   * *** EVERY RANKED ENTRY SAYS WHAT TO DO. *** The 17 findings in this tree that
   * carried no remedy now carry one, and the count in the Verdict block is the
   * guard: a finding added later without advice turns that zero into a number
   * rather than passing silently.
   */
  it('prints a fix under every ranked entry', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const entries = occurrences(report, '- Seen in: ')

    expect(entries).toBeGreaterThan(0)
    expect(occurrences(report, '\n- Do (')).toBe(entries)
    expect(report).not.toContain('No fix is recorded in this client build')
  })

  /**
   * *** ONE ACTION PER ENTRY, AND THE REASONING BEHIND A FOLD. *** The only finding
   * on a healthy deployment used to arrive as six bullets with the instruction
   * somewhere among them. Each entry is checked for its SHAPE: the line after
   * "Seen in" is the action, and every step and every "Because" sits inside the
   * fold that follows it — present in the text, so nothing is dropped.
   */
  it('gives every ranked entry one action line and folds its steps and reasoning beneath', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const list = report.slice(report.indexOf('## What needs attention'), report.indexOf('## How to read this'))
    const entries = list.split('\n### ').slice(1)

    expect(entries.length).toBeGreaterThan(3)
    for (const entry of entries) {
      const lines = entry.split('\n').filter((line) => line.length > 0)

      expect(lines[1].startsWith('- Seen in: ')).toBe(true)
      expect(lines[2].startsWith('- Do')).toBe(true)
      const fold = entry.indexOf('<details>')
      const close = entry.indexOf('</details>')
      const because = entry.indexOf('- Because: ')
      if (because !== -1) {
        expect(fold).toBeGreaterThan(-1)
        expect(because).toBeGreaterThan(fold)
        expect(because).toBeLessThan(close)
      }
      // Nothing but the heading, where it was seen and the action comes before the fold.
      const head = (fold === -1 ? entry : entry.slice(0, fold)).split('\n').filter((line) => line.length > 0)
      expect(head).toHaveLength(3)
    }
  })

  /**
   * *** ONE FACT, ONE ENTRY. *** `SYNCING_SERVER_GRPC_UNBOUND` is printed by the
   * boot-gate block AND raised as a WebSocket finding, `DEPLOYMENT_UNSTAMPED` by
   * the deployment marker AND by Environment & setup, and `CLIENT_GAP` by two
   * sections. All three used to print their remedy twice.
   */
  it('prints one fact once, naming every place it was observed', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))

    for (const code of ['SYNCING_SERVER_GRPC_UNBOUND', 'DEPLOYMENT_UNSTAMPED', 'CLIENT_GAP']) {
      expect(occurrences(report, `— ${code}\n`)).toBe(1)
    }
    // And the topology-conditional instruction appears exactly once, not twice.
    expect(occurrences(report, 'Set SERVICE_PROXY_TYPE=grpc.')).toBe(1)
    expect(occurrences(report, 'docker compose up -d --build')).toBe(1)
    // The folded entry names both observers rather than dropping one. The gate
    // condition is the case that always folds in this fixture: the WebSocket
    // section raises it AND the boot-gate block contributes the same code.
    expect(report).toContain('- Seen in: WebSocket · Boot gate')
    // The marker's own entry is contributed by this file, and folds with the
    // Environment section's wherever that section was given a marker to read.
    expect(report).toContain('- Seen in: Deployment')
  })

  /**
   * The fold across a SECTION and this file, driven directly: the Environment
   * section raises `DEPLOYMENT_UNSTAMPED` only when it is given a marker to read,
   * and the boot-gate block of this file contributes the same code regardless. One
   * entry, two sources, one copy of the rebuild instruction.
   */
  it('folds a section finding together with this file’s own observation of the same fact', () => {
    const report = buildDiagnosticsReport(
      input({
        sections: {
          ...sections(),
          environment: buildEnvironmentSection({
            topology: payload.deployment,
            deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
          }),
        },
      }),
    )

    expect(report).toContain(`- Seen in: ${SECTION_TITLE.environment} · Deployment`)
    expect(report.split(`— DEPLOYMENT_UNSTAMPED${String.fromCharCode(10)}`).length - 1).toBe(1)
    expect(report.split('docker compose up -d --build').length - 1).toBe(1)
  })

  it('tells the reader what every status means and which silence a row with no value is', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const legend = report.slice(report.indexOf('## How to read this'), report.indexOf('## Deployment'))

    expect(legend).toContain('NOT WORKING (not working)')
    expect(legend).toContain('DEGRADED (working, with something lost)')
    expect(legend).toContain('NOT TESTED (not tested yet')
    expect(legend).toContain('N/A (not applicable here')
    // The two quiet statuses that still keep the headline off OK are named as such.
    expect(legend).toContain('UNKNOWN and NOT TESTED both keep the headline off OK')
    expect(legend).toContain('"no answer" — this build asked and nothing came back')
    expect(legend).toContain('"nothing to report" — ')
    expect(legend).toContain('"not available here" — ')
    expect(legend).toContain('no URL, host, port, token or key')
  })

  /**
   * *** THE NOISE IS COLLAPSED AND NEVER DROPPED. *** The operator pastes this to
   * reason about their deployment and several of the quietest rows are themselves
   * diagnostic, so the test is two-sided: the detail is inside a collapsible
   * region AND still present as text.
   */
  it('collapses every detail block without removing a line of it', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))

    expect(occurrences(report, '<details>')).toBe(occurrences(report, '</details>'))
    expect(occurrences(report, '<details>')).toBe(occurrences(report, '<summary>'))
    // One per top-level detail block plus one per section plus the context list.
    expect(occurrences(report, '<details>')).toBeGreaterThanOrEqual(6 + SECTION_IDS.length)
    // Nothing is omitted: the rows are still in the text.
    expect(report).toContain('- REDIS_URL: set (required)')
    expect(report).toContain('| SYNC_ITEMS |')
    expect(report).toContain('- [INFO] Boot gate recorded: yes')
    // And each section's summary names it with its own verdict, so a collapsed
    // document is still an index.
    for (const id of SECTION_IDS) {
      expect(report).toContain(`<summary>${SECTION_TITLE[id]} — `)
    }
  })

  /**
   * The ONLY markup permitted. The report is markdown that must stay readable as
   * plain text, so a restructure that reached for a table or a div would fail
   * here rather than in somebody's issue tracker.
   */
  it('uses no markup beyond the disclosure tags', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const tags = report.match(/<[^>]+>/g) ?? []

    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) {
      expect(['<details>', '</details>', '<summary>', '</summary>']).toContain(tag)
    }
  })

  it('tags every section row with exactly one status, from the closed set', () => {
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const rows = report.split('\n').filter((line) => /^- \[/.test(line))
    const tags = ['OK', 'DEGRADED', 'NOT WORKING', 'UNKNOWN', 'NOT TESTED', 'N/A', 'INFO']

    expect(rows.length).toBeGreaterThan(20)
    for (const row of rows) {
      const tag = /^- \[([^\]]+)\] /.exec(row)?.[1]
      expect({ row, known: tags.includes(tag ?? '') }).toEqual({ row, known: true })
    }
    // Not vacuous in either direction: the fixture really has rows that are fine
    // and rows that are not.
    expect(rows.some((row) => row.startsWith('- [OK] '))).toBe(true)
    expect(rows.some((row) => row.startsWith('- [UNKNOWN] '))).toBe(true)
    expect(rows.some((row) => row.startsWith('- [NOT WORKING] '))).toBe(true)
  })

  it('says a healthy deployment has nothing to act on, rather than printing an empty list', () => {
    const healthy = buildDiagnosticsReport({
      payload: undefined,
      transport: { state: 'READY', operations: ['SYNC_ITEMS'] },
      deploymentMarker: { revision: 'ab3f90'.repeat(6) + 'cdef', version: 'rel-1.2.3' },
      checks: readingsFrom({}),
      loadError: null,
      generatedAt: '2026-08-27T12:00:00.000Z',
      sections: {
        websocket: buildWebsocketSection(),
        environment: buildEnvironmentSection(),
        backend: buildBackendSection(),
        account: buildAccountSection(),
        browser: buildBrowserSection(),
      },
    })

    expect(healthy).toContain('## What needs attention')
    expect(healthy).toContain('- Do first: nothing.')
    expect(healthy).toContain('- Findings needing action: 0')
    expect(healthy).toContain('Nothing needs action.')
  })

  /**
   * *** AND A PANE THAT READ NOTHING IS NOT HEALTHY. *** The counterpart to the
   * test above, and the more important of the two: a report opening with HEALTHY
   * over sections nobody supplied would be the single most expensive line in this
   * project.
   */
  it('opens with UNKNOWN, never HEALTHY, when no sections were supplied', () => {
    const report = buildDiagnosticsReport(input())

    expect(report).toContain('**UNKNOWN** — ')
    expect(report).toContain('this is NOT a pass')
    expect(report).not.toContain('**OK**')
    expect(report).toContain('- Coverage: the five topic sections were not supplied')
    expect(report).toContain('five topic sections were not supplied')
  })
})

describe('buildDiagnosticsSummary', () => {
  /**
   * The server made to misbehave in every string-bearing field the summary's own
   * ranked list reads: the gate's precondition code and its remedy, the live
   * refusal reason, and the SYNC_ITEMS verdict the WebSocket section turns into a
   * finding.
   */
  const summaryPoison: SyncDiagnosticsPayload = {
    ...payload,
    capturedAt: 'redis://admin:hunter2@redis.internal.example:6379',
    gate: {
      ...payload.gate,
      syncItems: {
        state: 'WITHHELD',
        cause: 'DURABLE_BACKEND_NOT_READY',
        remedy: 'the durable backend at syncing.internal.example:50051 refused',
        probe: 'NOT_READY',
      },
      unmetPreconditions: [
        { code: 'REDIS_UNBOUND', remedy: 'set REDIS_URL to redis://admin:hunter2@redis.internal.example:6379' },
        { code: PLANTED_OPAQUE, remedy: PLANTED_SHAPED },
      ],
      unmetCodes: ['REDIS_UNBOUND', PLANTED_OPAQUE],
      files: { advertised: false, unmetCondition: PLANTED_SHAPED, remedy: 'https://notes.internal.example' },
    },
    live: { capabilities: [], unavailabilityReasons: ['no-allowed-origins', PLANTED_OPAQUE], ticketAvailable: false },
  }

  /**
   * The summary carries the ANSWER and not the evidence. Both halves are asserted,
   * because a "summary" that happened to be the whole document would satisfy every
   * `toContain` on its own — a `toContain` assertion cannot forbid more content.
   */
  it('carries the verdict, the ranked list and the legend, and no evidence', () => {
    const summary = buildDiagnosticsSummary(input({ sections: sections() }))
    const report = buildDiagnosticsReport(input({ sections: sections() }))

    expect(summary).toContain('# Standard Red Notes — capability diagnostics')
    expect(summary).toContain('Build: revision unstamped')
    expect(summary).toContain('## Summary')
    // Named for the one lane it is about: as "Diagnosis" it read as the verdict,
    // two lines under the line that is the verdict.
    expect(summary).toContain('- Realtime lane diagnosis: ')
    expect(summary).not.toContain('- Diagnosis: ')
    expect(summary).toContain('## What needs attention')
    expect(summary).toContain('### 1. ')
    expect(summary).toContain('## How to read this')
    expect(summary).toContain('This is the SUMMARY only.')

    for (const absent of [
      '## Deployment',
      '## Topology',
      '## Boot gate',
      '## Capabilities',
      '## Configuration presence',
      '## Checks',
      '| Operation |',
      '- REDIS_URL: set (required)',
    ]) {
      expect(summary).not.toContain(absent)
    }
    for (const id of SECTION_IDS) {
      expect(summary).not.toContain(`## ${SECTION_TITLE[id]}`)
    }
    // Shorter, but the real test is the structural absence above: a ratio is
    // prose-sensitive and the eight headings are not.
    expect(summary.length).toBeLessThan(report.length)
  })

  /** One derivation, two renderers: the two cannot disagree about the answer. */
  it('agrees with the report line for line about the answer', () => {
    const summary = buildDiagnosticsSummary(input({ sections: sections() }))
    const report = buildDiagnosticsReport(input({ sections: sections() }))
    const answer = summary.slice(0, summary.indexOf('## How to read this'))

    expect(report).toContain(answer)
  })

  /**
   * The summary is pasted too, so it is held to the same rule — and it carries the
   * ranked remedies, which is the part of the document a server string would most
   * plausibly have reached through.
   */
  it('cannot carry a value, an address or a credential either', () => {
    const summary = buildDiagnosticsSummary(
      input({
        payload: summaryPoison,
        sections: { ...sections(), websocket: buildWebsocketSection({ payload: summaryPoison }) },
        deploymentMarker: {
          revision: 'token-sk-live-abcdef0123456789',
          version: 'v1.2.3-build@ci.internal.example.com',
        },
      }),
    )

    for (const fragment of ['hunter2', 'internal.example', 'token-sk-live', 'v1.2.3-build', '10.4.2.9']) {
      expect(summary).not.toContain(fragment)
    }
    expect(summary).not.toMatch(/https?:\/\//)
    expect(summary).not.toMatch(/redis:\/\//)
    expect(summary).not.toContain('[address withheld]')
    // NOT vacuous: the ranked entries the poisoned fields feed are really here.
    expect(summary).toContain('## What needs attention')
    expect(summary).toContain('### 1. ')
    expect(summary).toContain('- Seen in: ')
    expect(summary).toContain('\n- Do (')
  })
})
