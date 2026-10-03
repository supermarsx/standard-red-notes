import { EFFORT_LABEL, type DeploymentTopology } from './diagnosticRemedies'
import {
  UNRECOGNISED,
  VERDICTS,
  type DiagnosticFinding,
  type DiagnosticRow,
  type SectionModel,
} from './diagnosticsSections'
import {
  buildEnvironmentSection,
  describeIdentityState,
  describeInternalGrpcSecret,
  ENVIRONMENT_RELEVANCES,
  GRPC_FAILURE_CLASSES,
  PROXY_DECISIONS,
  type EnvironmentRuntimeView,
  type TransportFallbackView,
} from './environmentSection'
import { WITHHELD } from './reportAllowlist'

/**
 * Standard Red Notes: the Environment & setup section's own tests.
 *
 * *** WHAT THIS FILE IS ACTUALLY GUARDING ***
 *
 * Three properties, each of which this directory has already got wrong once:
 *
 *  1. A positive presence reading must NOT read as healthy. The live defect is
 *     recorded in `diagnosticsSections.ts`: a green chip over a socket that
 *     withheld note syncing, because a short internal secret is still a present
 *     one. Every `required`/`present` row and every `sufficient` secret reading
 *     is therefore asserted to be CAPPED — `claimed: 'healthy'` and
 *     `verdict: 'undetermined'` with a caveat — and the same proxy's negative arm
 *     is asserted to SURVIVE as `broken`. Asserting only the second half would
 *     pass against a row with no evidence discipline at all.
 *  2. An absent field must not become a negative answer. The whole model is built
 *     with no input and all 21 rows are checked individually, not as a set: an
 *     assertion over a set is satisfied by any member of it.
 *  3. No configured VALUE and no secret LENGTH may reach a row, a finding, a
 *     remedy or the copyable report. The planted-value scan below serialises the
 *     whole model, because asserting on the report alone would miss a value
 *     interpolated into a note that an operator reads on screen.
 *
 * Properties are asserted per row rather than over `allRows(...)` wherever the
 * row's identity matters, and `rowOf` THROWS on a missing label so that renaming
 * a row turns its assertions red instead of silently vacuous.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const topology = (overrides: Partial<DeploymentTopology> = {}): DeploymentTopology => ({
  recorded: true,
  mode: 'self-hosted',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'redis',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: true,
  redisBound: true,
  presence: {},
  ...overrides,
})

const runtime = (overrides: Partial<EnvironmentRuntimeView> = {}): EnvironmentRuntimeView => ({ ...overrides })

type LaneMap = NonNullable<TransportFallbackView['lanes']>

/** Both lanes present and quiet — what a healthy gateway's ledger looks like. */
const lanes = (overrides: LaneMap = {}): LaneMap => ({
  'session-validation': { degradedCalls: 0, refusedCalls: 0, lastFailureClass: null, lastFailureAgeMs: null },
  'items-sync': { degradedCalls: 0, refusedCalls: 0, lastFailureClass: null, lastFailureAgeMs: null },
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/* Lookups that fail loudly                                                   */
/* -------------------------------------------------------------------------- */

const allRows = (model: SectionModel): readonly DiagnosticRow[] => model.blocks.flatMap((block) => block.rows)

const allFindings = (model: SectionModel): readonly DiagnosticFinding[] =>
  model.blocks.flatMap((block) => block.findings)

const rowOf = (model: SectionModel, label: string): DiagnosticRow => {
  const found = allRows(model).find((row) => row.label === label)
  if (found === undefined) {
    throw new Error(
      `no row labelled "${label}" — the model has: ${allRows(model)
        .map((row) => row.label)
        .join(' | ')}`,
    )
  }

  return found
}

const findingOf = (model: SectionModel, code: string): DiagnosticFinding | undefined =>
  allFindings(model).find((finding) => finding.code === code)

const codesOf = (model: SectionModel): string[] => allFindings(model).map((finding) => String(finding.code))

const headingsOf = (model: SectionModel): string[] => model.blocks.map((block) => String(block.heading))

/* -------------------------------------------------------------------------- */
/* Absent is not false                                                        */
/* -------------------------------------------------------------------------- */

describe('buildEnvironmentSection with nothing reported', () => {
  it('claims absent evidence and no verdict for every single row', () => {
    const model = buildEnvironmentSection()
    const rows = allRows(model)

    expect(rows).toHaveLength(21)
    for (const row of rows) {
      expect({
        label: String(row.label),
        kind: row.evidence.kind,
        verdict: row.verdict,
        value: String(row.value),
      }).toEqual({ label: String(row.label), kind: 'absent', verdict: 'undetermined', value: 'not reported' })
    }
  })

  it('raises no finding and reports the section as undetermined rather than healthy', () => {
    const model = buildEnvironmentSection()

    expect(codesOf(model)).toEqual([])
    expect(model.worstVerdict).toBe('undetermined')
    expect(model.worst).toBe('neutral')
    expect(model.headline).toBeUndefined()
  })

  it('says the server reported no configuration presence instead of leaving a blank panel', () => {
    const model = buildEnvironmentSection()
    const block = model.blocks.find((candidate) => String(candidate.heading) === 'Configuration presence')

    expect(block?.rows).toEqual([])
    expect(block?.emptyNote).toContain('reports no configuration presence at all')
    expect(model.reportLines.join('\n')).toContain('- Nothing was reported for this block.')
  })

  it('does not treat recorded:false as a set of falses', () => {
    const model = buildEnvironmentSection({ topology: { recorded: false, presence: { REDIS_URL: true } } })

    expect(rowOf(model, 'Deployment shape').evidence.kind).toBe('absent')
    expect(rowOf(model, 'MODE').value).toBe('not reported')
    // The presence row still appears — presence was reported — but with no claim
    // about whether this topology reads it.
    expect(rowOf(model, 'REDIS_URL').value).toBe('set (relevance not established)')
    expect(rowOf(model, 'REDIS_URL').verdict).toBe('informational')
    expect(codesOf(model)).toEqual([])
  })

  /**
   * The first defect this spec caught in its own module. `presence[key] === true`
   * reads a MISSING key as `false`, which turns a server that said nothing about
   * a variable into a confident "not set" with a finding and a remedy attached.
   */
  it('treats a key missing from the presence map as silence, not as "not set"', () => {
    const silent = buildEnvironmentSection({ topology: topology({ presence: { REDIS_URL: true } }) })

    expect(rowOf(silent, 'Internal gRPC auth secret').value).toBe('not reported')
    expect(rowOf(silent, 'Internal gRPC auth secret').evidence.kind).toBe('absent')
    expect(codesOf(silent)).toEqual([])

    // And the same read still produces the finding when the server DOES report it.
    const named = buildEnvironmentSection({ topology: topology({ presence: { AUTH_JWT_SECRET: false } }) })

    expect(codesOf(named)).toContain('SESSION_SIGNING_KEY_ABSENT')
  })
})

/* -------------------------------------------------------------------------- */
/* Section identity                                                           */
/* -------------------------------------------------------------------------- */

describe('buildEnvironmentSection shape', () => {
  it('builds the four always-present blocks, in order, under the section title', () => {
    const model = buildEnvironmentSection()

    expect(model.id).toBe('environment')
    expect(model.title).toBe('Environment & setup')
    expect(headingsOf(model)).toEqual([
      'Deployment shape',
      'Durable backend transport',
      'Sessions and cookies',
      'Deployment identity',
      'Configuration presence',
    ])
  })

  it('appends one block per reported configuration group, renaming the identity group to avoid a collision', () => {
    const model = buildEnvironmentSection({
      topology: topology({ presence: { REDIS_URL: true, SRN_DEPLOY_REVISION: true, SQS_QUEUE_URL: false } }),
    })

    expect(headingsOf(model)).toContain('Shared state')
    expect(headingsOf(model)).toContain('Event fan-out')
    expect(headingsOf(model)).toContain('Deployment identity variables')
    // The block above owns the plain heading; two blocks with one heading is how
    // a report line stops naming which block produced it.
    expect(headingsOf(model).filter((heading) => heading === 'Deployment identity')).toHaveLength(1)
    expect(headingsOf(model)).not.toContain('Configuration presence')
  })

  it('shows only the probe results tagged for this section, and only when there are some', () => {
    const none = buildEnvironmentSection({
      outcomes: [{ name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' }],
    })
    const some = buildEnvironmentSection({
      outcomes: [
        { name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' },
        { name: 'Marker fetch', passed: false, detail: 'd', reportDetail: 'r', section: 'environment' },
      ],
    })

    expect(headingsOf(none)).not.toContain('Operator-triggered checks')
    const checks = some.blocks.find((block) => String(block.heading) === 'Operator-triggered checks')
    expect(checks?.outcomes).toHaveLength(1)
    expect(checks?.outcomes?.[0]?.name).toBe('Marker fetch')
  })

  /**
   * The second defect this spec caught in its own module: the checks block was
   * appended inside the branch that handles a REPORTED presence map, so a
   * deployment whose server reports none — the one most likely to have run a
   * probe — silently lost its results.
   */
  it('keeps the probe results when the server reported no configuration presence at all', () => {
    const model = buildEnvironmentSection({
      outcomes: [{ name: 'Marker fetch', passed: false, detail: 'd', reportDetail: 'r', section: 'environment' }],
    })

    expect(headingsOf(model)).toEqual([
      'Deployment shape',
      'Durable backend transport',
      'Sessions and cookies',
      'Deployment identity',
      'Configuration presence',
      'Operator-triggered checks',
    ])
  })

  it('states the three withholdings in the copyable report rather than leaving them silent', () => {
    const report = buildEnvironmentSection().reportLines.join('\n')

    expect(report).toContain('## Environment & setup')
    expect(report).toContain('- Configured values: never collected')
    expect(report).toContain('- Secret lengths: never reported; a secret appears as a threshold state only')
    expect(report).toContain('- Build revision and version: reported under the Deployment heading of this report')
  })
})

/* -------------------------------------------------------------------------- */
/* The reused classifier                                                      */
/* -------------------------------------------------------------------------- */

describe('configuration presence, from the reused classifier', () => {
  it('caps a present required variable to undetermined and says why', () => {
    const model = buildEnvironmentSection({
      topology: topology({ presence: { WEB_SOCKET_CONNECTION_TOKEN_SECRET: true } }),
    })
    const row = rowOf(model, 'WEB_SOCKET_CONNECTION_TOKEN_SECRET')

    expect(row.value).toBe('set (required here)')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.tone).toBe('neutral')
    expect(row.evidence.kind).toBe('proxy')
    expect(row.caveat).toContain('does not establish')
    expect(codesOf(model)).toEqual([])
  })

  it('reports an absent required variable as broken, never as healthy', () => {
    const model = buildEnvironmentSection({
      topology: topology({ presence: { WEB_SOCKET_CONNECTION_TOKEN_SECRET: false } }),
    })
    const row = rowOf(model, 'WEB_SOCKET_CONNECTION_TOKEN_SECRET')

    expect(row.value).toBe('not set (required here)')
    expect(row.claimed).toBe('broken')
    // The necessary-condition proxy failing is conclusive, so the claim SURVIVES.
    expect(row.verdict).toBe('broken')
    expect(row.tone).toBe('bad')
    expect(codesOf(model)).toContain('REQUIRED_CONFIG_ABSENT')
    expect(findingOf(model, 'REQUIRED_CONFIG_ABSENT')?.remedy?.summary).toContain('WEB_SOCKET_CONNECTION_TOKEN_SECRET')
    expect(findingOf(model, 'REQUIRED_CONFIG_ABSENT')?.remedy?.effort).toBe('restart')
  })

  it('warns about a variable that is set and never read, and stays quiet when it is unset', () => {
    const set = buildEnvironmentSection({
      topology: topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }),
    })
    const unset = buildEnvironmentSection({
      topology: topology({ cacheSetting: 'memory', presence: { REDIS_URL: false } }),
    })

    expect(rowOf(set, 'REDIS_URL').value).toBe('set (never read here)')
    expect(rowOf(set, 'REDIS_URL').verdict).toBe('degraded')
    expect(rowOf(set, 'REDIS_URL').evidence.kind).toBe('direct')
    // The note is the classifier's own prose, printed verbatim rather than restated.
    expect(rowOf(set, 'REDIS_URL').note).toContain('CACHE_TYPE=memory suppresses the Redis binding')
    expect(codesOf(set)).toContain('CONFIG_SET_BUT_NEVER_READ')
    expect(findingOf(set, 'CONFIG_SET_BUT_NEVER_READ')?.remedy?.summary).toContain('REDIS_URL')

    expect(rowOf(unset, 'REDIS_URL').value).toBe('not set (never read here)')
    expect(rowOf(unset, 'REDIS_URL').verdict).toBe('informational')
    expect(codesOf(unset)).not.toContain('CONFIG_SET_BUT_NEVER_READ')
  })

  it('never recommends a gRPC variable on a single container', () => {
    const model = buildEnvironmentSection({
      topology: topology({
        mode: 'home-server',
        grpcProxyBindableInThisMode: false,
        presence: { SYNCING_SERVER_GRPC_URL: true },
      }),
    })

    expect(rowOf(model, 'gRPC variables apply here').value).toBe('no')
    expect(rowOf(model, 'SYNCING_SERVER_GRPC_URL').value).toBe('set (never read here)')
    expect(rowOf(model, 'SYNCING_SERVER_GRPC_URL').note).toContain('Never read in home-server mode')
    expect(rowOf(model, 'Deployment shape').value).toBe('single container (home server)')
    expect(rowOf(model, 'Deployment shape').note).toContain('bound in-process and unconditionally')
  })

  it('tells the two bundled topologies apart, so compose operators are not sent after a container they do not run', () => {
    const compose = buildEnvironmentSection({ topology: topology({ mode: 'self-hosted' }) })
    const single = buildEnvironmentSection({ topology: topology({ mode: 'home-server' }) })
    const bare = buildEnvironmentSection({ topology: topology({ mode: 'unset' }) })
    const strange = buildEnvironmentSection({ topology: topology({ mode: 'other' }) })

    expect(rowOf(compose, 'Deployment shape').value).toBe('bundled compose stack')
    expect(rowOf(single, 'Deployment shape').value).toBe('single container (home server)')
    expect(rowOf(bare, 'Deployment shape').value).toBe('started outside the shipped entrypoints')
    expect(rowOf(strange, 'Deployment shape').value).toBe('unrecognised MODE, behaves as unset')
    expect(rowOf(strange, 'MODE').value).toBe('other')
  })

  it('admits every relevance the classifier can emit, so none collapses to unrecognised', () => {
    const models = [
      buildEnvironmentSection({ topology: topology({ presence: { REDIS_URL: true, SQS_QUEUE_URL: true } }) }),
      buildEnvironmentSection({
        topology: topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }),
      }),
      buildEnvironmentSection({ topology: { recorded: false, presence: { REDIS_URL: true } } }),
    ]

    const suffixes = new Set(
      models
        .flatMap((model) => allRows(model))
        .map((row) => String(row.value))
        .filter((value) => value.includes('(')),
    )

    expect(suffixes.size).toBeGreaterThan(0)
    for (const value of suffixes) {
      expect(value).not.toContain(UNRECOGNISED)
    }
    expect(ENVIRONMENT_RELEVANCES).toEqual(['required', 'optional', 'inert', 'unknown'])
  })

  it('keeps a key a newer server reports, and withholds it when it is not shaped like a variable name', () => {
    const known = buildEnvironmentSection({ topology: topology({ presence: { SOME_FUTURE_VARIABLE: true } }) })
    const unshaped = buildEnvironmentSection({
      topology: topology({ presence: { 'sk-live-PLANTED-SECRET-0123456789abcdef': true } }),
    })

    expect(rowOf(known, 'SOME_FUTURE_VARIABLE').value).toBe('set (relevance not established)')
    expect(rowOf(unshaped, WITHHELD).value).toBe('set (relevance not established)')
    expect(JSON.stringify(unshaped)).not.toContain('sk-live-PLANTED')
  })
})

/* -------------------------------------------------------------------------- */
/* The internal gRPC secret: three states, and never a length                 */
/* -------------------------------------------------------------------------- */

describe('the internal gRPC auth secret', () => {
  const sectionFor = (decision: string | undefined, present: boolean): SectionModel =>
    buildEnvironmentSection({
      topology: topology({ presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: present } }),
      runtime: runtime({ serviceProxyDecision: decision }),
    })

  it('separates a short secret from an absent one, on direct evidence', () => {
    const short = sectionFor('no-secret', true)
    const absent = sectionFor('no-secret', false)

    expect(rowOf(short, 'Internal gRPC auth secret').value).toBe('set, shorter than 32 bytes')
    expect(rowOf(short, 'Internal gRPC auth secret').verdict).toBe('broken')
    expect(rowOf(short, 'Internal gRPC auth secret').evidence.kind).toBe('direct')
    expect(findingOf(short, 'GRPC_SECRET_TOO_SHORT')?.title).toContain('shorter than the minimum')
    expect(findingOf(short, 'GRPC_SECRET_TOO_SHORT')?.remedy?.because?.[0]).toContain('The variable IS set')

    expect(rowOf(absent, 'Internal gRPC auth secret').value).toBe('not set')
    expect(rowOf(absent, 'Internal gRPC auth secret').verdict).toBe('broken')
    expect(findingOf(absent, 'GRPC_SECRET_TOO_SHORT')?.title).toContain('is not set')
    expect(findingOf(absent, 'GRPC_SECRET_TOO_SHORT')?.remedy?.because?.[0]).toContain('The variable is not set')
  })

  it('caps a sufficient secret to undetermined, because both sides must also agree', () => {
    for (const decision of ['grpc-default', 'auth-grpc-unreachable', 'syncing-grpc-unreachable']) {
      const row = rowOf(sectionFor(decision, true), 'Internal gRPC auth secret')

      expect(row.value).toBe('at least 32 bytes')
      expect(row.claimed).toBe('healthy')
      expect(row.verdict).toBe('undetermined')
      expect(row.evidence.kind).toBe('proxy')
      expect(row.caveat).toContain('does not establish')
    }
  })

  it('falls back to presence, as a proxy, when the resolver never reached the length test', () => {
    const set = rowOf(sectionFor('not-colocated', true), 'Internal gRPC auth secret')
    const unset = rowOf(sectionFor('no-grpc-urls', false), 'Internal gRPC auth secret')

    expect(set.value).toBe('set (length not established)')
    expect(set.claimed).toBe('healthy')
    expect(set.verdict).toBe('undetermined')
    expect(set.note).toContain('returned before it reached the length test')

    expect(unset.value).toBe('not set (length not established)')
    expect(unset.claimed).toBe('broken')
    expect(unset.verdict).toBe('broken')
  })

  it('reports nothing at all when no topology was reported', () => {
    const row = rowOf(
      buildEnvironmentSection({ runtime: runtime({ serviceProxyDecision: 'operator' }) }),
      'Internal gRPC auth secret',
    )

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
  })

  it('derives the state from the two closed inputs and nothing else', () => {
    expect(describeInternalGrpcSecret('no-secret', true)).toBe('too-short')
    expect(describeInternalGrpcSecret('no-secret', false)).toBe('absent')
    expect(describeInternalGrpcSecret('grpc-default', true)).toBe('sufficient')
    expect(describeInternalGrpcSecret('grpc-default', false)).toBe('sufficient')
    expect(describeInternalGrpcSecret('operator', true)).toBe('unmeasured')
    expect(describeInternalGrpcSecret(undefined, undefined)).toBeUndefined()
  })

  it('emits only threshold wording, never a length', () => {
    const values = PROXY_DECISIONS.flatMap((decision) =>
      [true, false].map((present) => String(rowOf(sectionFor(decision, present), 'Internal gRPC auth secret').value)),
    )

    expect(new Set(values)).toEqual(
      new Set([
        'at least 32 bytes',
        'set, shorter than 32 bytes',
        'not set',
        'set (length not established)',
        'not set (length not established)',
      ]),
    )
    for (const model of PROXY_DECISIONS.map((decision) => sectionFor(decision, true))) {
      // The only digits a secret row may carry are the threshold itself.
      expect(String(rowOf(model, 'Internal gRPC auth secret').value).replace('32', '')).not.toMatch(/\d/)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The transport decision and the runtime ledger                              */
/* -------------------------------------------------------------------------- */

describe('why this transport was chosen', () => {
  it('surfaces the reason when the payload carries it', () => {
    const model = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ serviceProxyDecision: 'not-colocated' }),
    })
    const row = rowOf(model, 'Why this transport was chosen')

    expect(row.value).toBe('not-colocated')
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
  })

  it('reports undetermined rather than guessing when the payload does not carry it', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Why this transport was chosen')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('the reason is undetermined')
  })

  it('refuses a decision code this build does not recognise instead of echoing it', () => {
    const model = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ serviceProxyDecision: 'PLANTED-DECISION-MARKER' }),
    })

    expect(rowOf(model, 'Why this transport was chosen').value).toBe(UNRECOGNISED)
    expect(JSON.stringify(model)).not.toContain('PLANTED-DECISION-MARKER')
  })

  it('names an unreachable listener as the lane resolver recorded it', () => {
    const auth = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ serviceProxyDecision: 'auth-grpc-unreachable' }),
    })
    const syncing = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ serviceProxyDecision: 'syncing-grpc-unreachable' }),
    })

    expect(rowOf(auth, 'Why this transport was chosen').verdict).toBe('degraded')
    expect(findingOf(auth, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.steps?.[0]).toContain('auth server is up')
    expect(findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.steps?.[0]).toContain('syncing server is up')
    // The closest available effort, with the real location of the fix in the summary.
    expect(findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.effort).toBe('wait')
    expect(findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.summary).toContain('Nothing on THIS container')
    expect(EFFORT_LABEL.wait).toBe('Transient')
  })

  it('does not raise a listener finding for a decision that is not about a listener', () => {
    for (const decision of ['operator', 'grpc-default', 'not-colocated', 'no-grpc-urls']) {
      const model = buildEnvironmentSection({
        topology: topology(),
        runtime: runtime({ serviceProxyDecision: decision }),
      })

      expect(codesOf(model)).not.toContain('GRPC_LISTENER_UNREACHABLE')
    }
  })
})

describe('the three states the runtime ledger separates', () => {
  it('reads plain HTTP as a configuration, with no claim about gRPC', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'http' }),
      fallback: { observed: false, everDegraded: false, lanes: lanes() },
    })
    const row = rowOf(model, 'gRPC transport health')

    expect(row.value).toBe('HTTP by configuration')
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
    expect(codesOf(model)).toEqual([])
  })

  it('caps a bound gRPC proxy with no recorded fallback, because an idle gateway reads the same', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: { observed: false, everDegraded: false, lanes: lanes() },
    })
    const row = rowOf(model, 'gRPC transport health')

    expect(row.value).toBe('gRPC, no fallback recorded')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('proxy')
    expect(row.caveat).toContain('does not establish')
    expect(codesOf(model)).toEqual([])
  })

  it('reports gRPC bound and HTTP serving, which neither input shows on its own', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: lanes({
          'items-sync': {
            degradedCalls: 7,
            refusedCalls: 0,
            lastFailureClass: 'channel-unavailable',
            lastFailureAgeMs: 4000,
          },
        }),
      },
    })

    expect(rowOf(model, 'gRPC transport health').value).toBe('gRPC bound, HTTP serving')
    expect(rowOf(model, 'gRPC transport health').verdict).toBe('degraded')
    expect(rowOf(model, 'gRPC transport health').evidence.kind).toBe('direct')
    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('7')
    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').verdict).toBe('degraded')
    expect(rowOf(model, 'Most recent gRPC failure').value).toBe('channel-unavailable')
    expect(rowOf(model, 'Lane of the most recent gRPC failure').value).toBe('items-sync')
    expect(rowOf(model, 'Time since the last gRPC failure').value).toBe('4s')
    expect(codesOf(model)).toContain('GRPC_BOUND_SERVING_HTTP')
    expect(model.worstVerdict).toBe('degraded')
  })

  it('withholds the state entirely when a bound gRPC proxy has no runtime record beside it', () => {
    const model = buildEnvironmentSection({ topology: topology({ boundServiceProxy: 'grpc' }) })
    const row = rowOf(model, 'gRPC transport health')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
  })

  it('reads an in-process direct call as a topology rather than a transport', () => {
    const model = buildEnvironmentSection({
      topology: topology({ mode: 'home-server', boundServiceProxy: 'direct-call' }),
      fallback: { observed: false, everDegraded: false, lanes: lanes() },
    })

    expect(rowOf(model, 'gRPC transport health').value).toBe('in-process, no transport')
    expect(rowOf(model, 'gRPC transport health').verdict).toBe('informational')
  })

  it('sums both lanes and attributes the most recent failure to the freshest one', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: {
          'session-validation': {
            degradedCalls: 4,
            refusedCalls: 1,
            lastFailureClass: 'never-dispatched',
            lastFailureAgeMs: 600_000,
          },
          'items-sync': {
            degradedCalls: 2,
            refusedCalls: 3,
            lastFailureClass: 'method-unimplemented',
            lastFailureAgeMs: 90_000,
          },
        },
      },
    })

    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('6')
    expect(rowOf(model, 'Calls refused rather than retried').value).toBe('4')
    // 90s ago is MORE recent than 600s ago: these are durations since the
    // failure, so the freshest one is the smallest.
    expect(rowOf(model, 'Most recent gRPC failure').value).toBe('method-unimplemented')
    expect(rowOf(model, 'Lane of the most recent gRPC failure').value).toBe('items-sync')
    expect(rowOf(model, 'Time since the last gRPC failure').value).toBe('1m 30s')
    expect(codesOf(model)).toContain('GRPC_CALLS_REFUSED')
  })

  it('keeps refused calls visible beside the degradations rather than letting one imply the other', () => {
    const degradedOnly = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: lanes({
          'items-sync': { degradedCalls: 3, refusedCalls: 0, lastFailureClass: 'cancelled', lastFailureAgeMs: 10 },
        }),
      },
    })

    expect(rowOf(degradedOnly, 'Calls refused rather than retried').value).toBe('0')
    expect(rowOf(degradedOnly, 'Calls refused rather than retried').verdict).toBe('informational')
    expect(codesOf(degradedOnly)).not.toContain('GRPC_CALLS_REFUSED')
  })

  it('reads a zero count as informational rather than healthy, because an idle gateway is also zero', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: { observed: false, everDegraded: false, lanes: lanes() },
    })

    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('0')
    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').verdict).toBe('informational')
  })

  it('reports no count at all when the fallback block names no lane', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: { observed: false, everDegraded: false },
    })

    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('not reported')
    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').evidence.kind).toBe('absent')
  })

  it('refuses a failure class this build does not recognise', () => {
    const model = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: lanes({
          'items-sync': {
            degradedCalls: 1,
            refusedCalls: 0,
            lastFailureClass: 'PLANTED-FAILURE-MARKER',
            lastFailureAgeMs: 5,
          },
        }),
      },
    })

    expect(rowOf(model, 'Most recent gRPC failure').value).toBe(UNRECOGNISED)
    expect(JSON.stringify(model)).not.toContain('PLANTED-FAILURE-MARKER')
    expect(GRPC_FAILURE_CLASSES).toContain('channel-unavailable')
  })
})

/* -------------------------------------------------------------------------- */
/* Sessions and cookies                                                       */
/* -------------------------------------------------------------------------- */

describe('sessions and cookies', () => {
  it('flags Partitioned without Secure as broken, because the browser drops the whole cookie', () => {
    const model = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ cookieSecure: false, cookiePartitioned: true }),
    })

    expect(rowOf(model, 'Cookie Partitioned flag').value).toBe('on')
    expect(rowOf(model, 'Cookie Partitioned flag').verdict).toBe('broken')
    expect(rowOf(model, 'Cookie Secure flag').value).toBe('off')
    expect(rowOf(model, 'Cookie Secure flag').verdict).toBe('degraded')
    expect(findingOf(model, 'COOKIE_PARTITIONED_WITHOUT_SECURE')?.verdict).toBe('broken')
    expect(findingOf(model, 'COOKIE_PARTITIONED_WITHOUT_SECURE')?.remedy?.effort).toBe('restart')
    expect(model.worstVerdict).toBe('broken')
  })

  it('leaves a coherent pair alone, in either direction', () => {
    const secureAndPartitioned = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ cookieSecure: true, cookiePartitioned: true }),
    })
    const plainLocal = buildEnvironmentSection({
      topology: topology(),
      runtime: runtime({ cookieSecure: false, cookiePartitioned: false }),
    })

    expect(codesOf(secureAndPartitioned)).not.toContain('COOKIE_PARTITIONED_WITHOUT_SECURE')
    expect(codesOf(plainLocal)).not.toContain('COOKIE_PARTITIONED_WITHOUT_SECURE')
    expect(rowOf(plainLocal, 'Cookie Partitioned flag').verdict).toBe('informational')
  })

  it('flags end-to-end test mode loudly, and says a green suite proves nothing about cookie sessions', () => {
    const on = buildEnvironmentSection({ topology: topology(), runtime: runtime({ e2eTesting: true }) })
    const off = buildEnvironmentSection({ topology: topology(), runtime: runtime({ e2eTesting: false }) })

    expect(rowOf(on, 'End-to-end test mode').value).toBe('yes')
    expect(rowOf(on, 'End-to-end test mode').verdict).toBe('broken')
    expect(rowOf(on, 'End-to-end test mode').note).toContain('cookie-session faults cannot occur')
    expect(findingOf(on, 'E2E_TEST_MODE_ENABLED')?.remedy?.because?.[0]).toContain('FORCE_LEGACY_SESSIONS')

    expect(rowOf(off, 'End-to-end test mode').value).toBe('no')
    expect(rowOf(off, 'End-to-end test mode').verdict).toBe('healthy')
    expect(codesOf(off)).not.toContain('E2E_TEST_MODE_ENABLED')
  })

  it('names an empty session signing key as its own cause, reusing the existing remedy', () => {
    const absent = buildEnvironmentSection({ topology: topology({ presence: { AUTH_JWT_SECRET: false } }) })
    const present = buildEnvironmentSection({ topology: topology({ presence: { AUTH_JWT_SECRET: true } }) })
    const finding = findingOf(absent, 'SESSION_SIGNING_KEY_ABSENT')

    expect(finding?.verdict).toBe('broken')
    expect(finding?.detail).toContain('closes the lane outright rather than withholding one operation')
    // Reused verbatim from diagnosticRemedies, not rewritten here.
    expect(finding?.remedy?.summary).toContain('AUTH_JWT_SECRET is empty')
    expect(finding?.remedy?.code).toBe('authorization-adapter-unavailable')
    expect(codesOf(present)).not.toContain('SESSION_SIGNING_KEY_ABSENT')
  })
})

/* -------------------------------------------------------------------------- */
/* Deployment identity, and the defect it must not misrepresent               */
/* -------------------------------------------------------------------------- */

describe('deployment identity', () => {
  const STAMPED = { revision: 'a'.repeat(40), version: '1.2.3' }

  it('reports a published identity as healthy on direct evidence', () => {
    const model = buildEnvironmentSection({ topology: topology(), deploymentMarker: STAMPED })
    const row = rowOf(model, 'Deployment identity')

    expect(row.value).toBe('published')
    expect(row.verdict).toBe('healthy')
    expect(row.evidence.kind).toBe('direct')
    expect(codesOf(model)).not.toContain('DEPLOYMENT_UNSTAMPED')
  })

  it('separates the four marker states', () => {
    expect(describeIdentityState(STAMPED)).toBe('published')
    expect(describeIdentityState({ revision: 'unstamped', version: 'unstamped' })).toBe('unstamped-marker')
    expect(describeIdentityState({ revision: '', version: '' })).toBe('no-identity')
    expect(describeIdentityState(undefined)).toBe('no-identity')
    // Survives `describeDeployment` and is still not a revision: refused rather
    // than published, which is the direction a shape check must fail in.
    expect(describeIdentityState({ revision: 'not-a-revision', version: '1.2.3' })).toBe('malformed-marker')
  })

  it('asserts WHICH cause produced an unstamped identity for neither of the two', () => {
    const sentinel = buildEnvironmentSection({
      topology: topology({ presence: { SRN_DEPLOY_REVISION: false, SRN_DEPLOY_VERSION: false } }),
      deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
    })
    const rejected = buildEnvironmentSection({
      topology: topology({ presence: { SRN_DEPLOY_REVISION: true, SRN_DEPLOY_VERSION: false } }),
      deploymentMarker: { revision: '', version: '' },
    })

    for (const model of [sentinel, rejected]) {
      const finding = findingOf(model, 'DEPLOYMENT_UNSTAMPED')

      expect(finding?.detail).toContain('this panel cannot tell them apart')
      expect(finding?.detail).toContain('SRN_DEPLOY_VERSION was empty')
      // A correlated proxy: neither its success nor its failure establishes the
      // cause, so the claim caps and the caveat says so.
      expect(finding?.claimed).toBe('degraded')
      expect(finding?.verdict).toBe('undetermined')
      expect(finding?.caveat).toContain('does not establish')
      // The ROW keeps its verdict, because "no identity is published" WAS observed.
      expect(rowOf(model, 'Deployment identity').verdict).toBe('degraded')
      expect(rowOf(model, 'Deployment identity').evidence.kind).toBe('direct')
    }

    expect(findingOf(rejected, 'DEPLOYMENT_UNSTAMPED')?.detail).toContain('SRN_DEPLOY_REVISION IS set')
    expect(findingOf(sentinel, 'DEPLOYMENT_UNSTAMPED')?.detail).toContain('SRN_DEPLOY_REVISION is not set')
  })

  it('claims no evidence about the runtime variables when the server reported none', () => {
    const model = buildEnvironmentSection({
      topology: topology({ presence: {} }),
      deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
    })
    const detail = findingOf(model, 'DEPLOYMENT_UNSTAMPED')?.detail ?? ''

    expect(detail).toContain('no evidence here either way')
    expect(detail).not.toContain('SRN_DEPLOY_REVISION IS set')
    expect(detail).not.toContain('SRN_DEPLOY_REVISION is not set')
  })

  it('reuses the existing unstamped remedy and marks the rebuild as necessary rather than sufficient', () => {
    const model = buildEnvironmentSection({
      topology: topology(),
      deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
    })
    const finding = findingOf(model, 'DEPLOYMENT_UNSTAMPED')

    expect(finding?.remedy?.code).toBe('DEPLOYMENT_UNSTAMPED')
    expect(finding?.remedy?.effort).toBe('rebuild')
    expect(finding?.remedy?.steps?.[0]).toContain('--build-arg SRN_DEPLOY_REVISION')
    expect(finding?.detail).toContain('necessary rather than sufficient')
  })

  it('says nothing at all when the marker was not read', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Deployment identity')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
  })

  it('does not repeat the revision as a row, and says where it is reported instead', () => {
    const model = buildEnvironmentSection({ topology: topology(), deploymentMarker: STAMPED })

    expect(rowOf(model, 'Deployment identity').note).toContain('printed in the copyable report')
    expect(allRows(model).map((row) => String(row.label))).not.toContain('Revision')
    expect(JSON.stringify(model)).not.toContain('a'.repeat(40))
  })
})

/* -------------------------------------------------------------------------- */
/* Nothing a value could travel in                                            */
/* -------------------------------------------------------------------------- */

describe('no configured value reaches a row, a finding, a remedy or the report', () => {
  /**
   * Planted into every field this section reads that is typed as a string off
   * the wire. There is deliberately no field for a configured VALUE — presence
   * is a boolean and the cookie flags are booleans — so these are planted where
   * a value COULD be smuggled: the decision enum, the deployment marker, an
   * unrecognised failure class, and a variable name a newer server reports.
   */
  const SECRETS = [
    'sk-live-PLANTED-SECRET-0123456789abcdef',
    'PLANTED-DECISION-MARKER',
    'token-PLANTED-REVISION-MARKER',
    'v9.9.9-PLANTED-VERSION-MARKER',
    'PLANTED-FAILURE-CLASS-MARKER',
    'redis://user:PLANTED-PASSWORD@cache.internal:6379',
    'PLANTED-PASSWORD',
  ]

  const planted = (): SectionModel =>
    buildEnvironmentSection({
      topology: topology({
        presence: {
          'sk-live-PLANTED-SECRET-0123456789abcdef': true,
          'redis://user:PLANTED-PASSWORD@cache.internal:6379': true,
          SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true,
          AUTH_JWT_SECRET: false,
          REDIS_URL: false,
          // Both deploy variables are reported, so the unstamped finding takes
          // its longest prose branch — the one that names the runtime evidence
          // for each. A fixture that left them out let a mutation interpolating
          // the raw marker into that branch survive the planted-value scan.
          SRN_DEPLOY_REVISION: true,
          SRN_DEPLOY_VERSION: false,
        },
      }),
      deploymentMarker: {
        revision: 'token-PLANTED-REVISION-MARKER',
        version: 'v9.9.9-PLANTED-VERSION-MARKER',
      },
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: {
          'items-sync': {
            degradedCalls: 2,
            refusedCalls: 1,
            lastFailureClass: 'PLANTED-FAILURE-CLASS-MARKER',
            lastFailureAgeMs: 1000,
          },
        },
      },
      runtime: runtime({
        serviceProxyDecision: 'PLANTED-DECISION-MARKER',
        cookieSecure: false,
        cookiePartitioned: true,
        e2eTesting: true,
        processUptimeSeconds: 3600,
      }),
    })

  it('keeps every planted value out of the serialised model', () => {
    const serialised = JSON.stringify(planted())

    for (const secret of SECRETS) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('keeps every planted value out of the copyable report', () => {
    const report = planted().reportLines.join('\n')

    for (const secret of SECRETS) {
      expect(report).not.toContain(secret)
    }
    // And the scan is not vacuous: the report is real, and full.
    expect(report).toContain('## Environment & setup')
    expect(report).toContain('- Worst verdict: broken')
    expect(report).toContain(`- ${WITHHELD}: set (relevance not established)`)
  })

  it('still reports the facts beside the refusals, so the scan is not passing on an empty model', () => {
    const model = planted()

    expect(rowOf(model, 'Why this transport was chosen').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Most recent gRPC failure').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Deployment identity').value).toBe('marker in an unrecognised format')
    expect(rowOf(model, 'Time since this process started').value).toBe('1h 0m')
    expect(codesOf(model).sort()).toEqual(
      [
        'CONFIG_SET_BUT_NEVER_READ',
        'COOKIE_PARTITIONED_WITHOUT_SECURE',
        'DEPLOYMENT_UNSTAMPED',
        'E2E_TEST_MODE_ENABLED',
        'GRPC_CALLS_REFUSED',
        'REQUIRED_CONFIG_ABSENT',
        'SESSION_SIGNING_KEY_ABSENT',
      ].sort(),
    )
  })

  it('emits only verdicts the contract declares', () => {
    const model = planted()

    for (const row of allRows(model)) {
      expect(VERDICTS).toContain(row.verdict)
      expect(VERDICTS).toContain(row.claimed)
    }
    for (const finding of allFindings(model)) {
      expect(VERDICTS).toContain(finding.verdict)
    }
  })
})
