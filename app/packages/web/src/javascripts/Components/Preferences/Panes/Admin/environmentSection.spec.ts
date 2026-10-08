import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

import { DECLARED_ENV_KEYS } from './diagnosticEnvironment'
import { EFFORT_LABEL, type DeploymentTopology } from './diagnosticRemedies'
import { EFFORT_TONE } from './diagnosticsPresentation'
import {
  NOT_PUBLISHED,
  UNRECOGNISED,
  VERDICTS,
  type DiagnosticFinding,
  type DiagnosticRow,
  type SectionModel,
} from './diagnosticsSections'
import {
  AUTH_RUNTIME_PROBES,
  BOUND_SERVICE_PROXIES,
  buildEnvironmentSection,
  CACHE_SETTINGS,
  DEPLOYMENT_MODES,
  describeIdentityState,
  describeInternalGrpcSecret,
  ENVIRONMENT_RELEVANCES,
  GRPC_FAILURE_CLASSES,
  INTERNAL_GRPC_SECRET_STATES,
  PROXY_DECISIONS,
  SERVICE_PROXY_DECISIONS,
  SERVICE_PROXY_SETTINGS,
  SYNC_SWITCH_SETTINGS,
  type EnvironmentRuntimeView,
  type EnvironmentSectionInput,
  type TransportFallbackView,
} from './environmentSection'
import { WITHHELD } from './reportAllowlist'
import type { SyncDiagnosticsPayload } from './syncDiagnostics'

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
 *     with no input and all 22 rows are checked individually, not as a set: an
 *     assertion over a set is satisfied by any member of it. A counter is the
 *     sharpest case: an absent count must read "not reported", never `0` — the
 *     first means "did not ask" and the second means "measured none".
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

    // Three runtime rows collapsed into one, so the count fell by two; the
    // secret's ORIGIN added one back when the launcher's state reached the
    // deployment report, and the auth uptime and the auth-runtime read added two
    // more when the runtime block landed.
    expect(rows).toHaveLength(23)
    for (const row of rows) {
      expect({ label: String(row.label), kind: row.evidence.kind, verdict: row.verdict }).toEqual({
        label: String(row.label),
        kind: 'absent',
        verdict: 'undetermined',
      })
    }

    /**
     * *** THE STRUCTURAL WORDING IS NOW WRONG FOR EVERY ROW IN THIS SECTION,
     * AND THAT IS ASSERTED RATHER THAN ASSUMED. ***
     *
     * "no endpoint publishes this" is for a field with no producer anywhere.
     * Three rows wore it: the lane decision, the gateway uptime, and the
     * collapsed cookie/session-mode row. All three have producers now — the
     * deployment block and the runtime block — so every absence in this section
     * is "a field that could have been reported and was not", which is exactly
     * what "not reported" means.
     *
     * A list that has emptied cannot be iterated into an assertion, so the
     * property is stated directly: EVERY row reads "not reported", and NO row
     * carries the structural wording. The second half would pass trivially if the
     * two strings were ever made equal, so the constant is asserted distinct
     * first — that is what keeps this from becoming a scan that cannot fail.
     */
    expect(NOT_PUBLISHED).not.toBe('not reported')
    for (const row of rows) {
      expect({ label: String(row.label), value: String(row.value) }).toEqual({
        label: String(row.label),
        value: 'not reported',
      })
    }
    expect(rows.map((row) => String(row.value))).not.toContain(String(NOT_PUBLISHED))
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
    expect(report).toContain('- Build version: reported under the Deployment heading of this report')
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

  it('names a variable that is set and never read, and stays quiet when it is unset', () => {
    const set = buildEnvironmentSection({
      topology: topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }),
    })
    const unset = buildEnvironmentSection({
      topology: topology({ cacheSetting: 'memory', presence: { REDIS_URL: false } }),
    })

    expect(rowOf(set, 'REDIS_URL').value).toBe('set (never read here)')
    // UNTIDY, NOT IMPAIRED. The row is still here, still says "never read here",
    // and no longer claims a degradation: nothing is impaired by a variable that
    // is merely unread. The test that this cannot hide a real fault is the next
    // one — the variable this topology DOES read, absent, is still `broken`.
    expect(rowOf(set, 'REDIS_URL').verdict).toBe('informational')
    expect(rowOf(set, 'REDIS_URL').evidence.kind).toBe('direct')
    // The note is the classifier's own prose, printed verbatim rather than restated.
    expect(rowOf(set, 'REDIS_URL').note).toContain('CACHE_TYPE=memory suppresses the Redis binding')
    expect(codesOf(set)).toContain('CONFIG_SET_BUT_NEVER_READ')
    expect(findingOf(set, 'CONFIG_SET_BUT_NEVER_READ')?.verdict).toBe('informational')
    expect(findingOf(set, 'CONFIG_SET_BUT_NEVER_READ')?.remedy?.summary).toContain('REDIS_URL')

    expect(rowOf(unset, 'REDIS_URL').value).toBe('not set (never read here)')
    expect(rowOf(unset, 'REDIS_URL').verdict).toBe('informational')
    expect(codesOf(unset)).not.toContain('CONFIG_SET_BUT_NEVER_READ')
  })

  /**
   * *** THE CONTROL FOR THAT DOWNGRADE. ***
   *
   * The reading that prompted it is this deployment's own: `REDIS_HOST` and
   * `REDIS_PORT` set on a topology that binds Redis from `REDIS_URL`, where the
   * rows were right, nothing was impaired, and the section's chip said Degraded.
   *
   * The case where being unread MATTERS is the asymmetric one: the operator set
   * the inert half of the pair and not the half this topology reads. That has its
   * own row and its own finding, computed from the same presence rows in the same
   * pass, and it is `broken` — so the pane did not lose the ability to report it.
   */
  it('still reports the pair where the variable this topology reads is the absent one', () => {
    const inertOnly = buildEnvironmentSection({
      topology: topology({ presence: { REDIS_HOST: true, REDIS_PORT: true, REDIS_URL: false } }),
    })

    // Precondition: the inert half really is inert and really is reported, or the
    // rest of this test would be asserting over rows that are not there.
    expect(rowOf(inertOnly, 'REDIS_HOST').value).toBe('set (never read here)')
    expect(rowOf(inertOnly, 'REDIS_PORT').value).toBe('set (never read here)')
    expect(codesOf(inertOnly)).toContain('CONFIG_SET_BUT_NEVER_READ')

    // The half with a consequence, undowngraded.
    expect(rowOf(inertOnly, 'REDIS_URL').value).toBe('not set (required here)')
    expect(rowOf(inertOnly, 'REDIS_URL').verdict).toBe('broken')
    expect(findingOf(inertOnly, 'REQUIRED_CONFIG_ABSENT')?.verdict).toBe('broken')
    expect(findingOf(inertOnly, 'REQUIRED_CONFIG_ABSENT')?.remedy?.summary).toContain('REDIS_URL')
    expect(inertOnly.worstVerdict).toBe('broken')
  })

  it('does not rate a correctly configured deployment degraded over inert variables alone', () => {
    // The live reading, reproduced: the pair is set, the variable this topology
    // reads is set too, and nothing is impaired.
    const tidyEnough = buildEnvironmentSection({
      topology: topology({ presence: { REDIS_HOST: true, REDIS_PORT: true, REDIS_URL: true } }),
    })

    expect(codesOf(tidyEnough)).toContain('CONFIG_SET_BUT_NEVER_READ')
    expect(codesOf(tidyEnough)).not.toContain('REQUIRED_CONFIG_ABSENT')
    expect(tidyEnough.worstVerdict).not.toBe('degraded')
    expect(tidyEnough.worstVerdict).not.toBe('broken')
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

  /**
   * *** THE SECTION HALF OF THE PRESENCE-KEY LEAK. ***
   *
   * This test used to assert the defect as a feature. A key a newer server
   * reports became a row LABEL, admitted by SHAPE — so a key off the wire in
   * upper snake case was printed on screen and in the report, while a
   * differently shaped one was refused. Shape is not membership, and the KEYS of
   * a presence map are chosen by the server exactly as its values would be.
   *
   * The fact survives as a count, which is the more useful half: it says the gap
   * is on the CLIENT. Both plants are asserted absent, including the
   * variable-shaped one, and so is the redactor's sentinel — its appearance
   * would mean a denylist had been put back in a row label.
   */
  it('counts a key a newer server reports and never labels a row with one', () => {
    const planted = buildEnvironmentSection({
      topology: topology({
        presence: {
          REDIS_URL: true,
          SOME_FUTURE_VARIABLE: true,
          'sk-live-PLANTED-SECRET-0123456789abcdef': true,
        },
      }),
    })
    const serialised = JSON.stringify(planted)

    expect(rowOf(planted, 'Variables this build does not recognise').value).toBe('2')
    expect(rowOf(planted, 'Variables this build does not recognise').verdict).toBe('informational')
    // Not vacuous: the variables this build DOES declare are still named beside
    // the count, so the count is read against a list rather than on its own.
    expect(rowOf(planted, 'REDIS_URL').value).toBe('set (required here)')
    expect(serialised).not.toContain('SOME_FUTURE_VARIABLE')
    expect(serialised).not.toContain('sk-live-PLANTED')
    expect(serialised).not.toContain('[address withheld]')
    // No refusal sentinel in a label position either: one would mean a wire key
    // had reached a label and been scrubbed there instead of never arriving.
    expect(allRows(planted).map((row) => String(row.label))).not.toContain(WITHHELD)
  })

  it('reports the count at zero, because none is a reading and an absent row is not', () => {
    const model = buildEnvironmentSection({ topology: topology({ presence: { REDIS_URL: true } }) })

    expect(rowOf(model, 'Variables this build does not recognise').value).toBe('0')
  })
})

/* -------------------------------------------------------------------------- */
/* The internal gRPC secret: three states, and never a length                 */
/* -------------------------------------------------------------------------- */

describe('the internal gRPC auth secret', () => {
  // The decision arrives WITH the topology, which is where the server puts it.
  const sectionFor = (decision: string | undefined, present: boolean): SectionModel =>
    buildEnvironmentSection({
      topology: topology({
        presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: present },
        serviceProxyDecision: decision,
      }),
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
    // A decision on an UNRECORDED block is silence, not a reading: the whole
    // block is gated on `recorded`, so this must stay "not reported".
    const row = rowOf(
      buildEnvironmentSection({ topology: { recorded: false, serviceProxyDecision: 'operator' } }),
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

  /* ------------------------------------------------------------------------ */
  /* The threshold check that did not run                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * NO DECISION REPORTED IS NOT A RESOLVER THAT RETURNED EARLY.
   *
   * This is the state every deployment is actually in: nothing reports the lane
   * DECISION, which is the only thing that carries the resolver's measurement of
   * this secret against the 32-byte minimum, so the threshold check cannot run.
   * The row said `set (length not established)` and explained it with the
   * `unmeasured` sentence — "the boot-time lane resolver returned before it
   * reached the length test on this deployment" — over a deployment whose
   * resolver was never read at all. A confident statement about an observation
   * that was never made.
   */
  it('says the threshold check did not run, rather than why a resolver stopped', () => {
    const row = rowOf(
      buildEnvironmentSection({
        topology: topology({ presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true } }),
      }),
      'Internal gRPC auth secret',
    )

    expect(describeInternalGrpcSecret(undefined, true)).toBe('unreported')
    expect(String(row.value)).toBe('set (threshold not established: no lane decision reported)')
    expect(row.note).toContain('The threshold check did not run here')
    // The sentence that was wrong here, and is still right where it belongs.
    expect(row.note).not.toContain('returned before it reached the length test')
    expect(rowOf(sectionFor('not-colocated', true), 'Internal gRPC auth secret').note).toContain(
      'returned before it reached the length test',
    )
  })

  it('still reports a short or absent secret as broken, with no decision needed for either', () => {
    // *** THE CONTROL. *** The two readings that matter are reached from the
    // DECISION, not from the row's wording, so splitting the honest states apart
    // must not touch them.
    const short = rowOf(sectionFor('no-secret', true), 'Internal gRPC auth secret')
    const absent = rowOf(sectionFor('no-secret', false), 'Internal gRPC auth secret')

    expect(String(short.value)).toBe('set, shorter than 32 bytes')
    expect(short.verdict).toBe('broken')
    expect(String(absent.value)).toBe('not set')
    expect(absent.verdict).toBe('broken')

    // And an unreported threshold over an UNSET variable is still broken on
    // presence alone — the row that could not run its check has not gone quiet.
    const unsetRow = rowOf(
      buildEnvironmentSection({
        topology: topology({ presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: false } }),
      }),
      'Internal gRPC auth secret',
    )
    expect(String(unsetRow.value)).toBe('not set (threshold not established: no lane decision reported)')
    expect(unsetRow.verdict).toBe('broken')
  })

  it('reports a threshold state and never a length, in either honest state', () => {
    const values = [true, false].map((present) =>
      String(
        rowOf(
          buildEnvironmentSection({
            topology: topology({ presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: present } }),
          }),
          'Internal gRPC auth secret',
        ).value,
      ),
    )

    expect(values).toHaveLength(2)
    for (const value of values) {
      // The only digits a secret row may carry are the threshold itself, and this
      // state does not even carry that.
      expect(value.replace('32', '')).not.toMatch(/\d/)
    }
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
  const withDecision = (decision: string): EnvironmentSectionInput => ({
    topology: topology({ serviceProxyDecision: decision }),
  })

  it('surfaces the reason when the payload carries it', () => {
    const model = buildEnvironmentSection(withDecision('not-colocated'))
    const row = rowOf(model, 'Why this transport was chosen')

    expect(row.value).toBe('not-colocated')
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
  })

  /**
   * *** EVERY RESOLVER OUTCOME IS RENDERABLE, OR THE ROW CALLS A WORKING
   * LAUNCHER A TYPO. ***
   *
   * This is the defect `SERVICE_PROXY_SETTINGS` already had: a tuple too narrow
   * for the server's union reported a deliberate setting as unrecognised. The
   * behaviour is asserted per token rather than over a set, because an assertion
   * over a set is satisfied by any member of it.
   */
  for (const decision of PROXY_DECISIONS) {
    it(`prints ${decision} as itself rather than as unrecognised`, () => {
      const row = rowOf(buildEnvironmentSection(withDecision(decision)), 'Why this transport was chosen')

      expect(row.value).toBe(decision)
      expect(row.value).not.toBe(UNRECOGNISED)
      expect(row.evidence.kind).toBe('direct')
    })
  }

  /**
   * *** THE ROW THE EXPORT FIX FILLED, AND THE THREE NON-ANSWERS IT MUST STILL
   * KEEP APART. ***
   *
   * The launcher assigned `SRN_SERVICE_PROXY_TYPE_DECISION` in eight branches and
   * never exported it, so no child process — the gateway included — could see it
   * and this row could only ever be blank. It reads a decision now, which makes
   * three different absences newly distinguishable, and each of them is a
   * different sentence:
   *
   *   - the server did not send the field (older than it),
   *   - the server sent `unset`: no launcher recorded a decision at all,
   *   - the server sent `other`: the launcher recorded a token its own gateway
   *     could not name.
   *
   * Collapsing any pair would print a confident statement about an observation
   * nobody made, which is what the row did before this split: it said a shell
   * variable was never exported, over a deployment where it now is.
   */
  it('reports undetermined rather than guessing when the payload does not carry it', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Why this transport was chosen')

    // "not reported" rather than the structural wording: the field HAS a
    // producer now, so an absent reading is an old server and not a gap in the
    // system. The verdict and the evidence are unchanged — the row still claims
    // nothing about which condition declined gRPC.
    expect(row.value).toBe('not reported')
    expect(row.value).not.toBe('no endpoint publishes this')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('the reason is undetermined')
    // The traced-to-a-missing-export paragraph described a defect that is fixed.
    expect(row.note).not.toContain('never EXPORTS that variable')
  })

  it('reads the unset sentinel as a launcher that recorded nothing, not as an undetermined reason', () => {
    const row = rowOf(buildEnvironmentSection(withDecision('unset')), 'Why this transport was chosen')

    expect(row.value).toBe('unset')
    expect(row.value).not.toBe(UNRECOGNISED)
    // A REPORTED sentinel is a reading, so the evidence is direct — and the row
    // still carries no verdict, because nothing is wrong on the strength of it.
    expect(row.evidence.kind).toBe('direct')
    expect(row.verdict).toBe('informational')
    expect(row.note).toContain('NO LAUNCHER RECORDED A DECISION')
    expect(row.note).not.toContain('Nothing was reported for it here')
    // And it does not pull the threshold row into the wrong explanation either.
    const secret = rowOf(
      buildEnvironmentSection({
        topology: topology({
          serviceProxyDecision: 'unset',
          presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true },
        }),
      }),
      'Internal gRPC auth secret',
    )
    expect(String(secret.value)).toBe('set (threshold not established: no lane decision reported)')
    expect(secret.note).not.toContain('returned before it reached the length test')
  })

  it("keeps the server's own collapse apart from this build being behind", () => {
    const serverCollapsed = rowOf(buildEnvironmentSection(withDecision('other')), 'Why this transport was chosen')
    const clientBehind = rowOf(
      buildEnvironmentSection(withDecision('PLANTED-DECISION-MARKER')),
      'Why this transport was chosen',
    )

    expect(serverCollapsed.value).toBe('other')
    expect(serverCollapsed.note).toContain('its own gateway could not name')
    expect(clientBehind.value).toBe(UNRECOGNISED)
    expect(clientBehind.note).toContain('The gap is on the CLIENT')
    expect(serverCollapsed.note).not.toBe(clientBehind.note)
  })

  it('refuses a decision code this build does not recognise instead of echoing it', () => {
    const model = buildEnvironmentSection(withDecision('PLANTED-DECISION-MARKER'))

    expect(rowOf(model, 'Why this transport was chosen').value).toBe(UNRECOGNISED)
    expect(JSON.stringify(model)).not.toContain('PLANTED-DECISION-MARKER')
  })

  it('does not treat a decision on an unrecorded block as a reading', () => {
    const row = rowOf(
      buildEnvironmentSection({ topology: { recorded: false, serviceProxyDecision: 'grpc-default' } }),
      'Why this transport was chosen',
    )

    expect(row.value).toBe('not reported')
    expect(row.evidence.kind).toBe('absent')
  })

  it('names an unreachable listener as the lane resolver recorded it', () => {
    const auth = buildEnvironmentSection(withDecision('auth-grpc-unreachable'))
    const syncing = buildEnvironmentSection(withDecision('syncing-grpc-unreachable'))

    expect(rowOf(auth, 'Why this transport was chosen').verdict).toBe('degraded')
    expect(findingOf(auth, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.steps?.[0]).toContain('auth server is up')
    expect(findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.steps?.[0]).toContain('syncing server is up')
    expect(findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE')?.remedy?.summary).toContain('Nothing on THIS container')
  })

  /**
   * A dead gRPC listener is repaired on the service that should be listening, and
   * the chip is the part of a remedy an operator reads first. It wore `wait` until
   * `peer-service` existed, and `wait`'s label — "Transient" — advises doing
   * nothing about a listener that may be permanently down.
   *
   * Both halves are asserted. A test that only pinned the new member would also
   * pass if `wait` had simply been RELABELLED, which would have moved the defect
   * into every genuinely transient remedy instead of fixing it.
   */
  it('sends an unreachable listener to the service that owns the fix, not to "Transient"', () => {
    const syncing = buildEnvironmentSection(withDecision('syncing-grpc-unreachable'))
    const serving = buildEnvironmentSection({
      topology: topology({ boundServiceProxy: 'grpc' }),
      fallback: {
        observed: true,
        everDegraded: true,
        lanes: lanes({
          'items-sync': {
            degradedCalls: 1,
            refusedCalls: 0,
            lastFailureClass: 'channel-unavailable',
            lastFailureAgeMs: 50,
          },
        }),
      },
    })

    for (const finding of [
      findingOf(syncing, 'GRPC_LISTENER_UNREACHABLE'),
      findingOf(serving, 'GRPC_BOUND_SERVING_HTTP'),
    ]) {
      expect(finding?.remedy?.effort).toBe('peer-service')
      expect(finding?.remedy?.effort).not.toBe('wait')
      expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'wait']).toBe('Another service')
    }

    // `wait` keeps its own meaning for the remedies that really are transient.
    expect(EFFORT_LABEL.wait).toBe('Transient')
    expect(EFFORT_LABEL['peer-service']).not.toBe(EFFORT_LABEL.wait)
    // And the chip is not neutral, because neutral is the tone of "nothing to do".
    expect(EFFORT_TONE['peer-service']).toBe('warn')
    expect(EFFORT_TONE['peer-service']).not.toBe(EFFORT_TONE.wait)
  })

  it('does not raise a listener finding for a decision that is not about a listener', () => {
    for (const decision of ['operator', 'grpc-default', 'not-colocated', 'no-grpc-urls', 'unset', 'other']) {
      const model = buildEnvironmentSection(withDecision(decision))

      expect(codesOf(model)).not.toContain('GRPC_LISTENER_UNREACHABLE')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The runtime block: two uptimes, and the probe that gates the auth half     */
/* -------------------------------------------------------------------------- */

/**
 * *** THE ROWS THAT SAID NOBODY PUBLISHES THEM, AND THE ONE RULE THAT KEEPS
 * THEM HONEST NOW. ***
 *
 * `payload.runtime` answers the gateway uptime and — through a probe of the auth
 * process — auth's uptime, the two EFFECTIVE session-cookie attributes and the
 * legacy-session switch. The four auth-owned ones are absent together whenever
 * that probe did not answer, and `unreachable` is the CORRECT outcome on the
 * bundled single container, where auth runs in-process with no HTTP listener.
 *
 * So the property under test is not "the rows render". It is that NO arm of the
 * probe is treated as a fault, because a pane that paints the commonest
 * single-container reading red is worse than one that says nothing.
 */
describe('the runtime block', () => {
  const withRuntime = (overrides: Partial<EnvironmentRuntimeView>): SectionModel =>
    buildEnvironmentSection({ topology: topology(), runtime: runtime(overrides) })

  it('reports the gateway uptime as a duration, and as nothing when the block is absent', () => {
    const reported = rowOf(withRuntime({ processUptimeSeconds: 7200 }), 'Time since this process started')
    const absent = rowOf(buildEnvironmentSection({ topology: topology() }), 'Time since this process started')

    expect(reported.value).toBe('2h 0m')
    expect(reported.verdict).toBe('informational')
    expect(reported.evidence.kind).toBe('direct')
    // The field has a producer now, so an absence is an older server rather than
    // a gap in the system — "not reported", never the structural wording.
    expect(absent.value).toBe('not reported')
    expect(absent.value).not.toBe(String(NOT_PUBLISHED))
    expect(absent.evidence.kind).toBe('absent')
  })

  /**
   * TWO UPTIMES, NOT ONE READ TWICE. They differ exactly when one half of the
   * deployment restarted alone, which is the state in which a setting took on one
   * container and not the other — the question the gateway row is most often
   * opened to answer, and the one it cannot answer by itself.
   */
  it('reports the auth uptime separately, so a half-restarted deployment is visible', () => {
    const model = withRuntime({ processUptimeSeconds: 120, authProcessUptimeSeconds: 864000 })

    expect(rowOf(model, 'Time since this process started').value).toBe('2m 0s')
    expect(rowOf(model, 'Time since the auth process started').value).toBe('10d 0h')
    expect(rowOf(model, 'Time since the auth process started').verdict).toBe('informational')
    // A gap is not a fault on its own, and the row must not invent one.
    expect(model.worstVerdict).not.toBe('degraded')
    expect(model.worstVerdict).not.toBe('broken')
  })

  it('reads an absent auth uptime as absent rather than as the gateway figure', () => {
    const row = rowOf(withRuntime({ processUptimeSeconds: 7200 }), 'Time since the auth process started')

    expect(row.value).toBe('not reported')
    expect(row.value).not.toBe('2h 0m')
    expect(row.evidence.kind).toBe('absent')
  })

  for (const outcome of AUTH_RUNTIME_PROBES) {
    it(`prints the ${outcome} probe outcome as itself and carries no verdict for it`, () => {
      const row = rowOf(withRuntime({ authRuntimeProbe: outcome }), 'Auth runtime read')

      expect(row.value).toBe(outcome)
      expect(row.value).not.toBe(UNRECOGNISED)
      expect(row.evidence.kind).toBe('direct')
      // *** NO ARM IS A FAULT. *** `unreachable` is what the bundled single
      // container reports, every time, by design.
      expect(row.verdict).toBe('informational')
      expect(row.tone).toBe('neutral')
    })
  }

  it('does not let an unreachable auth process drag the section down', () => {
    const model = buildEnvironmentSection({
      topology: topology({ mode: 'home-server', grpcProxyBindableInThisMode: false }),
      runtime: runtime({ processUptimeSeconds: 60, authRuntimeProbe: 'unreachable' }),
    })

    expect(rowOf(model, 'Auth runtime read').note).toContain('ORDINARY ON THE SINGLE CONTAINER')
    expect(model.worstVerdict).not.toBe('broken')
    expect(model.worstVerdict).not.toBe('degraded')
    expect(codesOf(model)).toEqual([])
  })

  it('refuses a probe outcome this build does not recognise instead of echoing it', () => {
    const model = withRuntime({ authRuntimeProbe: 'PLANTED-PROBE-MARKER' })

    expect(rowOf(model, 'Auth runtime read').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Auth runtime read').note).toContain('The gap is on the CLIENT')
    expect(JSON.stringify(model)).not.toContain('PLANTED-PROBE-MARKER')
  })

  it('says nothing was reported for the probe when the whole block is absent', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Auth runtime read')

    expect(row.value).toBe('not reported')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('a server older than this block')
  })

  /**
   * *** EFFECTIVE, NOT PRESENT — WHICH IS THE WHOLE REASON TO ASK THE SERVER.
   * ***
   *
   * Both cookie flags default to TRUE when unset, so "not set" and "off" are
   * opposite answers; a presence boolean would invert the diagnosis. The rows say
   * so, and the three return as three rows the moment the probe answers.
   */
  it('returns the three session-mode rows as themselves once the probe answers', () => {
    const model = withRuntime({
      authRuntimeProbe: 'answered',
      cookieSecure: true,
      cookiePartitioned: false,
      e2eTesting: false,
    })

    expect(rowOf(model, 'Cookie Secure flag').value).toBe('on')
    expect(rowOf(model, 'Cookie Secure flag').note).toContain('EFFECTIVE value, read off the attributes')
    expect(rowOf(model, 'Cookie Partitioned flag').value).toBe('off')
    expect(rowOf(model, 'Cookie Partitioned flag').note).toContain('EFFECTIVE attribute rather than the variable')
    expect(rowOf(model, 'End-to-end test mode').value).toBe('no')
    expect(allRows(model).map((row) => String(row.label))).not.toContain('Effective cookie and session-mode flags')
  })

  it('still raises the partitioned-without-secure fault off the effective pair', () => {
    const model = withRuntime({ authRuntimeProbe: 'answered', cookieSecure: false, cookiePartitioned: true })

    expect(codesOf(model)).toContain('COOKIE_PARTITIONED_WITHOUT_SECURE')
    expect(rowOf(model, 'Cookie Partitioned flag').verdict).toBe('broken')
  })

  /**
   * The collapse SURVIVES for the deployments where it is still the truth, and
   * its one row now says WHICH of the two it is instead of implying that nobody
   * publishes the facts.
   */
  it('keeps the collapsed row when the probe could not read them, and names the reason', () => {
    const probed = withRuntime({ authRuntimeProbe: 'unreachable', processUptimeSeconds: 10 })
    const older = buildEnvironmentSection({ topology: topology() })

    for (const model of [probed, older]) {
      const row = rowOf(model, 'Effective cookie and session-mode flags')
      expect(row.value).toBe('not reported')
      expect(row.value).not.toBe(String(NOT_PUBLISHED))
      expect(row.verdict).toBe('undetermined')
      expect(allRows(model).map((label) => String(label.label))).not.toContain('Cookie Secure flag')
    }

    expect(rowOf(probed, 'Effective cookie and session-mode flags').note).toContain('absent by design rather than')
    expect(rowOf(older, 'Effective cookie and session-mode flags').note).toContain('older than the whole block')
  })
})

/* -------------------------------------------------------------------------- */
/* The same secret, asked how it came to be                                   */
/* -------------------------------------------------------------------------- */

/**
 * *** THE SECOND VARIABLE THAT WAS RECORDED AND NEVER EXPORTED. ***
 *
 * `SRN_INTERNAL_GRPC_SECRET_STATE` had the identical defect to the lane decision
 * and hid better: its only reader was a `case` in the shell that sourced the
 * helper, so the boot log was correct while no child process could see the
 * variable at all. It is exported now and reaches the deployment report as a
 * closed union, and this block is what that union renders as.
 *
 * It answers a DIFFERENT question from the threshold row beside it, and the two
 * must not be conflated: the threshold is "is the secret long enough", this is
 * "where did the secret come from, and will it still be there after a restart".
 * The two states that matter are the two that look like success from outside.
 */
describe('how the internal gRPC secret came to be', () => {
  const withOrigin = (state: string): SectionModel =>
    buildEnvironmentSection({ topology: topology({ internalGrpcSecretState: state }) })

  for (const state of INTERNAL_GRPC_SECRET_STATES) {
    it(`prints ${state} as itself rather than as unrecognised`, () => {
      const row = rowOf(withOrigin(state), 'Internal gRPC secret origin')

      expect(row.value).toBe(state)
      expect(row.value).not.toBe(UNRECOGNISED)
      expect(row.evidence.kind).toBe('direct')
    })
  }

  it('reports nothing rather than a default when the server does not carry the field', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Internal gRPC secret origin')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('predates the fix that made the launcher export')
  })

  it('does not treat an origin on an unrecorded block as a reading', () => {
    const row = rowOf(
      buildEnvironmentSection({ topology: { recorded: false, internalGrpcSecretState: 'mint-failed' } }),
      'Internal gRPC secret origin',
    )

    expect(row.value).toBe('not reported')
    expect(row.evidence.kind).toBe('absent')
    expect(
      codesOf(buildEnvironmentSection({ topology: { recorded: false, internalGrpcSecretState: 'mint-failed' } })),
    ).not.toContain('GRPC_SECRET_NOT_DURABLE')
  })

  it('refuses an origin state this build does not recognise instead of echoing it', () => {
    const model = withOrigin('PLANTED-SECRET-STATE-MARKER')

    expect(rowOf(model, 'Internal gRPC secret origin').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Internal gRPC secret origin').note).toContain('The gap is on the CLIENT')
    expect(JSON.stringify(model)).not.toContain('PLANTED-SECRET-STATE-MARKER')
    // The server's OWN collapse sentinel is a different fact and keeps its own
    // sentence; sharing one would say the client is behind over a launcher that
    // reported something its own gateway could not name.
    expect(rowOf(withOrigin('other'), 'Internal gRPC secret origin').note).not.toContain('The gap is on the CLIENT')
  })

  it('calls a failed mint broken and names the fix, because nothing authenticates the lane', () => {
    const model = withOrigin('mint-failed')
    const row = rowOf(model, 'Internal gRPC secret origin')

    expect(row.verdict).toBe('broken')
    expect(row.evidence.kind).toBe('direct')
    expect(model.worstVerdict).toBe('broken')
    const finding = findingOf(model, 'GRPC_SECRET_NOT_DURABLE')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.title).toContain('could not obtain')
    expect(finding?.remedy?.effort).toBe('restart')
    expect(finding?.remedy?.steps?.[0]).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
  })

  it('calls an ephemeral mint a degradation, because it is correct until one half restarts', () => {
    const model = withOrigin('minted-ephemeral')
    const row = rowOf(model, 'Internal gRPC secret origin')

    expect(row.verdict).toBe('degraded')
    expect(row.note).toContain('THE STATE THAT LOOKS LIKE SUCCESS')
    const finding = findingOf(model, 'GRPC_SECRET_NOT_DURABLE')
    expect(finding?.verdict).toBe('degraded')
    expect(finding?.title).toContain('only in this process')
    expect(finding?.remedy?.summary).toContain('never written down')
  })

  /**
   * *** THE THREE DURABLE ORIGINS CARRY NO VERDICT, DELIBERATELY. ***
   *
   * A secret that survives a restart is still only half the condition — both
   * sides must hold the SAME one — and that claim is made, and capped, on the
   * threshold row. Rating these `healthy` would be the second green chip over one
   * secret, which is exactly the shape of the defect this pane was built after.
   */
  it('claims nothing for the three durable origins, and raises no finding for them', () => {
    for (const state of ['supplied', 'persisted', 'minted-persisted', 'not-colocated', 'unset', 'other']) {
      const model = withOrigin(state)

      expect(rowOf(model, 'Internal gRPC secret origin').verdict).toBe('informational')
      expect(codesOf(model)).not.toContain('GRPC_SECRET_NOT_DURABLE')
    }
  })

  /**
   * *** AT MOST ONE FINDING ABOUT THIS SECRET, SWEPT RATHER THAN SPOT-CHECKED.
   * ***
   *
   * Two questions are asked of one secret — is it long enough, and where did it
   * come from — and their answers overlap on a reachable state: a launcher that
   * could not mint leaves the resolver with no secret, so `mint-failed` and the
   * threshold's `absent` arrive together and both findings say "set the
   * variable" with different steps. The cross-product is swept instead of
   * sampled, because the colliding pair is one cell of it and a spot check is
   * how you miss the cell you did not think of.
   */
  it('never raises two findings about one secret, across every origin and decision', () => {
    const SECRET_CODES = ['GRPC_SECRET_TOO_SHORT', 'GRPC_SECRET_NOT_DURABLE']

    for (const state of INTERNAL_GRPC_SECRET_STATES) {
      for (const decision of [...PROXY_DECISIONS, 'unset', undefined]) {
        for (const present of [true, false]) {
          const model = buildEnvironmentSection({
            topology: topology({
              internalGrpcSecretState: state,
              serviceProxyDecision: decision,
              presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: present },
            }),
          })
          const raised = codesOf(model).filter((code) => SECRET_CODES.includes(code))

          expect({ state, decision, present, raised: raised.length }).toEqual({
            state,
            decision,
            present,
            raised: raised.length > 1 ? 'at most one' : raised.length,
          })
        }
      }
    }
  })

  /**
   * The control for that guard, in both directions: the colliding cell really
   * does reach both conditions, and the suppressed finding is NOT suppressed
   * where it is the only thing that can see the fault. Without the first half the
   * sweep above would be passing over a pair that never meets.
   */
  it('yields the durability finding to the absent-secret one, and only there', () => {
    const collides = buildEnvironmentSection({
      topology: topology({
        internalGrpcSecretState: 'mint-failed',
        serviceProxyDecision: 'no-secret',
        presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: false },
      }),
    })

    // Both conditions are genuinely met in this cell.
    expect(rowOf(collides, 'Internal gRPC auth secret').value).toBe('not set')
    expect(rowOf(collides, 'Internal gRPC secret origin').value).toBe('mint-failed')
    // And exactly one finding is raised: the fundamental one.
    expect(codesOf(collides)).toContain('GRPC_SECRET_TOO_SHORT')
    expect(codesOf(collides)).not.toContain('GRPC_SECRET_NOT_DURABLE')

    // Where the threshold says nothing, the durability finding is the only thing
    // that can see the fault and still fires.
    const alone = buildEnvironmentSection({ topology: topology({ internalGrpcSecretState: 'mint-failed' }) })
    expect(codesOf(alone)).toContain('GRPC_SECRET_NOT_DURABLE')
    // An ephemeral mint is never suppressed: the threshold finding cannot fire
    // with it, because that secret is present and long enough.
    const ephemeral = buildEnvironmentSection({
      topology: topology({
        internalGrpcSecretState: 'minted-ephemeral',
        serviceProxyDecision: 'grpc-default',
        presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true },
      }),
    })
    expect(codesOf(ephemeral)).toContain('GRPC_SECRET_NOT_DURABLE')
    expect(codesOf(ephemeral)).not.toContain('GRPC_SECRET_TOO_SHORT')
  })

  it('reports an origin and a threshold as two different facts about one secret', () => {
    const model = buildEnvironmentSection({
      topology: topology({
        serviceProxyDecision: 'grpc-default',
        internalGrpcSecretState: 'minted-ephemeral',
        presence: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true },
      }),
    })

    // Long enough AND not durable, which is a pair no single row could carry.
    expect(rowOf(model, 'Internal gRPC auth secret').value).toBe('at least 32 bytes')
    expect(rowOf(model, 'Internal gRPC secret origin').value).toBe('minted-ephemeral')
  })

  it('never emits a length or a path from either secret row', () => {
    for (const state of INTERNAL_GRPC_SECRET_STATES) {
      const value = String(rowOf(withOrigin(state), 'Internal gRPC secret origin').value)

      expect(value).not.toMatch(/\d/)
      expect(value).not.toContain('/')
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
/* The payload field the server was already sending                           */
/* -------------------------------------------------------------------------- */

/**
 * `transportFallback` has been on the admin response since the per-lane counters
 * landed, and was missing from `SyncDiagnosticsPayload` — so every row above read
 * "not reported" on a deployment that was reporting, and the section's own view
 * type was local plumbing nothing could be wired to.
 *
 * These tests run the real payload type through the section input, which is the
 * only thing that proves the two shapes agree: a wire type and a client type that
 * drift are worse than no client type, because the drift is invisible until an
 * operator reads a wrong row during an incident.
 */
describe('transportFallback, as the payload type declares it', () => {
  const grpc = (): DeploymentTopology => topology({ boundServiceProxy: 'grpc' })

  it('feeds payload.transportFallback into the section with no adaptation', () => {
    const wire: SyncDiagnosticsPayload = {
      deployment: grpc(),
      transportFallback: {
        observed: true,
        everDegraded: true,
        lanes: {
          'items-sync': {
            degradedCalls: 5,
            refusedCalls: 2,
            lastFailureClass: 'transport-internal',
            lastFailureAgeMs: 2_000,
          },
        },
      },
    }
    const model = buildEnvironmentSection({ topology: wire.deployment, fallback: wire.transportFallback })

    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('5')
    expect(rowOf(model, 'Calls refused rather than retried').value).toBe('2')
    expect(rowOf(model, 'Most recent gRPC failure').value).toBe('transport-internal')
    expect(rowOf(model, 'gRPC transport health').value).toBe('gRPC bound, HTTP serving')
    expect(codesOf(model)).toContain('GRPC_BOUND_SERVING_HTTP')
  })

  it('types the payload field as the section input, so neither can drift from the other', () => {
    const fromWire: NonNullable<SyncDiagnosticsPayload['transportFallback']> = {
      observed: true,
      everDegraded: true,
      lanes: {
        'session-validation': {
          degradedCalls: 1,
          refusedCalls: 0,
          lastFailureClass: 'cancelled',
          lastFailureAgeMs: 1,
        },
      },
    }
    const asSectionInput: EnvironmentSectionInput['fallback'] = fromWire
    const model = buildEnvironmentSection({ topology: grpc(), fallback: asSectionInput })

    expect(rowOf(model, 'Calls served over HTTP instead of gRPC').value).toBe('1')
    expect(rowOf(model, 'Lane of the most recent gRPC failure').value).toBe('session-validation')
  })

  /**
   * *** ABSENT IS NOT ZERO ***
   *
   * A zero counter means "the gateway measured none". An absent one means "this
   * build asked a server that does not answer the question". Both are asserted
   * here against the SAME two rows, because the defect is not that either reading
   * is wrong on its own — it is that they are indistinguishable once conflated,
   * and a fabricated zero reads as a clean bill of health.
   */
  it('reads an absent transportFallback as "did not ask" and a reported zero as "measured none"', () => {
    const older: SyncDiagnosticsPayload = { deployment: grpc() }
    const answered: SyncDiagnosticsPayload = {
      deployment: grpc(),
      transportFallback: { observed: false, everDegraded: false, lanes: lanes() },
    }

    expect(older.transportFallback).toBeUndefined()

    const silent = buildEnvironmentSection({ topology: older.deployment, fallback: older.transportFallback })
    const measured = buildEnvironmentSection({ topology: answered.deployment, fallback: answered.transportFallback })

    for (const label of ['Calls served over HTTP instead of gRPC', 'Calls refused rather than retried'] as const) {
      expect(rowOf(silent, label).value).toBe('not reported')
      expect(rowOf(silent, label).value).not.toBe('0')
      expect(rowOf(silent, label).evidence.kind).toBe('absent')
      expect(rowOf(silent, label).verdict).toBe('undetermined')

      expect(rowOf(measured, label).value).toBe('0')
      expect(rowOf(measured, label).evidence.kind).toBe('direct')
      // Zero is INFORMATIONAL, not healthy: an idle gateway reads the same.
      expect(rowOf(measured, label).verdict).toBe('informational')
    }

    // The same distinction one level up: a bound gRPC proxy with no ledger beside
    // it claims nothing, rather than claiming a healthy lane.
    expect(rowOf(silent, 'gRPC transport health').value).toBe('not reported')
    expect(rowOf(silent, 'gRPC transport health').evidence.kind).toBe('absent')
    expect(rowOf(measured, 'gRPC transport health').value).toBe('gRPC, no fallback recorded')
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
    // t108 reworded the shared step: a `--build-arg` alone bakes a correct
    // marker and then starts a container with no runtime value to compare it
    // against, which publishes {null, null} — so the instruction now sets the
    // variable for the whole command, which compose feeds to BOTH halves.
    expect(finding?.remedy?.steps?.[0]).toContain(
      'SRN_DEPLOY_REVISION=$(git rev-parse HEAD) docker compose up -d --build',
    )
    expect(finding?.remedy?.steps?.join(' ')).not.toContain('--build-arg SRN_DEPLOY_REVISION')
    expect(finding?.detail).toContain('necessary rather than sufficient')
  })

  it('says nothing at all when the marker was not read', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Deployment identity')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
  })

  /**
   * The row this section could not have before `safeToken`: a 40-character git
   * revision is none of the other permitted categories, so printing it would have
   * taken the cast the contract bans, and the section sent the reader to the
   * copyable report — which had been admitting the same literal, by the same
   * shape, all along.
   */
  it('prints the revision itself, admitted by the shape the Dockerfile validates', () => {
    const model = buildEnvironmentSection({ topology: topology(), deploymentMarker: STAMPED })
    const row = rowOf(model, 'Build revision')

    expect(row.value).toBe('a'.repeat(40))
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
    // It reaches the copyable report through the ordinary row path, with no
    // hand-written line and no second admission rule.
    expect(model.reportLines.join('\n')).toContain(`- [v] Build revision: ${'a'.repeat(40)}`)
    // The verdict still belongs to the state row; this one is context.
    expect(rowOf(model, 'Deployment identity').verdict).toBe('healthy')
  })

  /**
   * *** THE ROW'S WHOLE REASON FOR BEING SAFE ***
   *
   * The marker is served by whatever fronts the web bundle, so its revision is
   * untrusted input — and this is not theoretical: the health report's
   * planted-secret scan caught a revision reading `token-sk-live-…` printed
   * verbatim, because an opaque secret has no address shape for a denylist to
   * match. Shape admission refuses instead, and REFUSING MUST NOT ECHO: a
   * partially scrubbed string is not safe, and a withheld value that quotes what
   * it withheld has leaked it.
   *
   * Each candidate is asserted individually rather than over a set, because an
   * assertion over a set is satisfied by any member of it.
   */
  it('withholds anything that is not a revision, without echoing a byte of it', () => {
    const notRevisions = [
      'syncing-server:50051',
      'https://sync.internal.example.com/v1/items',
      'postgres://srn:PLANTED-PASSWORD@db.internal:5432/srn',
      'sk-live-0123456789abcdef0123456789abcdef',
      'A'.repeat(40),
      `${'a'.repeat(40)} `,
      `prefix-${'a'.repeat(40)}`,
      'a'.repeat(39),
    ]

    for (const revision of notRevisions) {
      const model = buildEnvironmentSection({
        topology: topology(),
        deploymentMarker: { revision, version: '1.2.3' },
      })

      expect(rowOf(model, 'Build revision').value).toBe(WITHHELD)
      expect(rowOf(model, 'Deployment identity').value).toBe('marker in an unrecognised format')
      // Not in the row, not in a note, not in a finding, not in the report.
      expect(JSON.stringify(model)).not.toContain(revision)
      expect(model.reportLines.join('\n')).not.toContain(revision)
    }
  })

  it('names the two sentinels rather than calling a build that stated its own unstamped-ness malformed', () => {
    const sentinel = buildEnvironmentSection({
      topology: topology(),
      deploymentMarker: { revision: 'unstamped', version: 'unstamped' },
    })
    const blank = buildEnvironmentSection({ topology: topology(), deploymentMarker: { revision: '', version: '' } })

    expect(rowOf(sentinel, 'Build revision').value).toBe('unstamped (stated by the build)')
    expect(rowOf(blank, 'Build revision').value).toBe('none published')
    for (const model of [sentinel, blank]) {
      expect(rowOf(model, 'Build revision').value).not.toBe(WITHHELD)
    }
  })

  it('reports no revision at all when the marker was not read', () => {
    const row = rowOf(buildEnvironmentSection({ topology: topology() }), 'Build revision')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
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
   *
   * The LAST of those is planted three ways on purpose — address-shaped, opaque
   * and shaped exactly like a variable name — because only the third tells the
   * member check apart from the two mechanisms that resemble one. A denylist
   * catches the first and misses the second; a shape floor admits the third and
   * refuses the first two. Nothing but "is this a literal this build compiled
   * in" refuses all three.
   */
  const SECRETS = [
    'sk-live-PLANTED-SECRET-0123456789abcdef',
    'PLANTED-DECISION-MARKER',
    'PLANTED-SECRET-STATE-MARKER',
    'PLANTED-PROBE-MARKER',
    'token-PLANTED-REVISION-MARKER',
    'v9.9.9-PLANTED-VERSION-MARKER',
    'PLANTED-FAILURE-CLASS-MARKER',
    'redis://user:PLANTED-PASSWORD@cache.internal:6379',
    'PLANTED-PASSWORD',
    'PLANTED_VARIABLE_SHAPED_KEY',
  ]

  /**
   * The input, returned so the sweep can prove it is not passing on a fixture
   * that stopped carrying one of its plants.
   *
   * *** A PLANT THAT IS NOT IN THE INPUT PROVES NOTHING. *** Every field this
   * section reads that is a `string` off the wire is poisoned here, and the test
   * below asserts each marker is PRESENT in the serialised input before asserting
   * it is absent from the output. Two fields were added to the deployment report
   * — the lane decision and the secret origin — and a hand-maintained list is
   * exactly the thing that silently fails to grow with them; this is the cheapest
   * check that notices.
   */
  const plantedInput = (): EnvironmentSectionInput => ({
    topology: topology({
      serviceProxyDecision: 'PLANTED-DECISION-MARKER',
      internalGrpcSecretState: 'PLANTED-SECRET-STATE-MARKER',
      presence: {
        'sk-live-PLANTED-SECRET-0123456789abcdef': true,
        'redis://user:PLANTED-PASSWORD@cache.internal:6379': true,
        PLANTED_VARIABLE_SHAPED_KEY: true,
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
      // The runtime block's only string field, poisoned like every other one.
      // The three booleans and the two durations cannot carry a value by
      // construction, which is why they are not in the plant list — and is
      // exactly the shape the server was asked for them in.
      authRuntimeProbe: 'PLANTED-PROBE-MARKER',
      cookieSecure: false,
      cookiePartitioned: true,
      e2eTesting: true,
      processUptimeSeconds: 3600,
      authProcessUptimeSeconds: 7200,
    }),
  })

  const planted = (): SectionModel => buildEnvironmentSection(plantedInput())

  /**
   * *** THE SWEEP'S OWN NON-VACUITY, FIELD BY FIELD. ***
   *
   * Asserted before the refusals: a marker that is no longer anywhere in the
   * INPUT cannot be kept out of the output by anything, and a fixture that quietly
   * stopped carrying one would leave its half of this scan reading green forever.
   * This is what makes the two fields added to the deployment report provably
   * inside the sweep rather than merely listed beside it.
   */
  it('actually feeds every planted value into the section', () => {
    const serialisedInput = JSON.stringify(plantedInput())

    for (const secret of SECRETS) {
      expect(serialisedInput).toContain(secret)
    }
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
    // The three unnameable keys survive as a count. A refusal sentinel in that
    // position is asserted ABSENT: it would mean a wire key had reached a label
    // and been scrubbed there rather than never arriving.
    expect(report).toContain('- [v] Variables this build does not recognise: 3')
    expect(report).not.toContain(`- ${WITHHELD}: set`)
    expect(report).not.toContain('[address withheld]')
  })

  it('still reports the facts beside the refusals, so the scan is not passing on an empty model', () => {
    const model = planted()

    expect(rowOf(model, 'Why this transport was chosen').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Internal gRPC secret origin').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Auth runtime read').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Most recent gRPC failure').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Time since the auth process started').value).toBe('2h 0m')
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

/* -------------------------------------------------------------------------- */
/* The closed vocabularies, and the server they are supposed to mirror        */
/* -------------------------------------------------------------------------- */

/**
 * A value the server can emit must never render as "other (unrecognised)".
 *
 * This is the defect this block exists for, and it was not hypothetical:
 * `SERVICE_PROXY_SETTINGS` admitted `['grpc', 'unset', 'other']` while the
 * gateway reported `http` and `auto` distinctly, so an operator who had pinned
 * HTTP, or left the self-configuring `auto` that `scripts/setup.sh` and
 * `.env.example` WRITE by default, was told their setting was unrecognised —
 * i.e. a typo. No verdict was wrong; only the label, on the row an operator
 * greps their compose file for.
 *
 * Widening the list fixes today and drifts again at the next token, so the two
 * halves below test different things on purpose:
 *
 *  1. The BEHAVIOUR an operator sees: each token goes through the real
 *     `buildEnvironmentSection` and the row must print it, with the negative
 *     control that a value genuinely outside the set still collapses and that
 *     the row does not case-fold. Asserting only the collapse would pass against
 *     the three-token list this fix replaced.
 *  2. The TIE. `DeploymentTopology` is a hand-written mirror of the server's
 *     `DeploymentDiagnostics.ts`, in a package that cannot import from the
 *     server one, so nothing in either tree notices when the mirror falls
 *     behind. The vocabularies are therefore pinned by parsing the server's own
 *     unions back out of its source and comparing them for set equality — the
 *     same recipe `2fc7213d` used to pin the Dockerfile version derivations. The
 *     parse THROWS when its anchor is missing, and three controls plant a
 *     divergence to prove the comparison actually fails on one.
 *
 * The compile-time half of the tie lives in `environmentSection.ts` itself: the
 * `…IsNamed` assertions make a tuple that is too narrow a type error. That
 * catches a token added to the mirror, and this block catches the mirror itself
 * falling behind the server.
 */
describe('the topology vocabularies this section can name', () => {
  /**
   * Walk up to the repository root rather than counting `..` segments: nine of
   * them is unreadable, and a silently wrong count would make every assertion
   * below depend on `readFileSync` throwing in the right way. This throws with
   * the directory it searched from instead.
   */
  const repositoryRoot = (): string => {
    let directory = __dirname

    for (let hop = 0; hop < 16; hop += 1) {
      if (existsSync(join(directory, 'server', 'packages', 'api-gateway'))) {
        return directory
      }

      const parent = dirname(directory)
      if (parent === directory) {
        break
      }
      directory = parent
    }

    throw new Error(`no directory above ${__dirname} holds server/packages/api-gateway`)
  }

  const SERVER_SOURCE = join(
    repositoryRoot(),
    'server',
    'packages',
    'api-gateway',
    'src',
    'Service',
    'Diagnostics',
    'DeploymentDiagnostics.ts',
  )

  const serverSource = (): string => readFileSync(SERVER_SOURCE, 'utf8')

  /** The one line each union is declared on, matched once or not at all. */
  const declarationPattern = (name: string): RegExp => new RegExp(`^export type ${name} = (.+)$`, 'm')

  /**
   * One exported union, as the tokens it admits.
   *
   * THROWS when the declaration is not there. A parse that answered `[]` on a
   * renamed or reformatted union would turn every comparison below into a
   * comparison against nothing, which is the shape of gate that reads green
   * because it never ran.
   */
  const unionTokens = (source: string, name: string): string[] => {
    const declaration = declarationPattern(name).exec(source)
    if (declaration === null) {
      throw new Error(`no "export type ${name} = …" line in ${SERVER_SOURCE}`)
    }

    const tokens = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    if (tokens.length === 0) {
      throw new Error(`"export type ${name}" declares no quoted members: ${declaration[1]}`)
    }

    return tokens
  }

  /**
   * Add a member to one union in a COPY of the source, for the controls.
   *
   * The occurrence count is checked rather than assumed: a `.replace` against a
   * fragment that has come to appear twice silently stops editing the one the
   * test means, and the control then proves nothing.
   */
  const plantExtraMember = (source: string, name: string, member: string): string => {
    const occurrences = source.split('\n').filter((line) => declarationPattern(name).test(line)).length
    if (occurrences !== 1) {
      throw new Error(`expected exactly one "export type ${name}" line, found ${occurrences}`)
    }

    return source.replace(declarationPattern(name), `export type ${name} = '${member}' | $1`)
  }

  const MIRRORED: ReadonlyArray<[string, readonly string[]]> = [
    ['DeploymentMode', DEPLOYMENT_MODES],
    ['ServiceProxySetting', SERVICE_PROXY_SETTINGS],
    ['BoundServiceProxy', BOUND_SERVICE_PROXIES],
    ['CacheSetting', CACHE_SETTINGS],
    ['SyncSwitchSetting', SYNC_SWITCH_SETTINGS],
  ]

  for (const [name, tokens] of MIRRORED) {
    it(`names exactly the ${name} tokens the server declares`, () => {
      expect([...unionTokens(serverSource(), name)].sort()).toEqual([...tokens].sort())
    })
  }

  it('is reading a real file with all five unions in it', () => {
    const source = serverSource()

    // Without this the five assertions above could all be comparing against a
    // parse of the same accidental match, and the file being present at all is
    // the premise the whole block rests on.
    expect(source).toContain('export function observeDeployment')
    for (const [name] of MIRRORED) {
      expect(declarationPattern(name).test(source)).toBe(true)
    }
  })

  it('fails when the server declares a proxy token this build does not name', () => {
    const planted = plantExtraMember(serverSource(), 'ServiceProxySetting', 'quic')

    expect(unionTokens(planted, 'ServiceProxySetting')).toContain('quic')
    expect([...unionTokens(planted, 'ServiceProxySetting')].sort()).not.toEqual([...SERVICE_PROXY_SETTINGS].sort())
  })

  it('fails when the server declares a mode token this build does not name', () => {
    const planted = plantExtraMember(serverSource(), 'DeploymentMode', 'kubernetes')

    expect([...unionTokens(planted, 'DeploymentMode')].sort()).not.toEqual([...DEPLOYMENT_MODES].sort())
  })

  it('throws rather than passing vacuously when the declaration it parses is gone', () => {
    const renamed = serverSource().replace(declarationPattern('ServiceProxySetting'), 'export type ProxyMode = never')

    expect(() => unionTokens(renamed, 'ServiceProxySetting')).toThrow('no "export type ServiceProxySetting = …" line')
    // And the un-renamed source does parse, so the control is not passing on a
    // replace that did nothing.
    expect(unionTokens(serverSource(), 'ServiceProxySetting').length).toBeGreaterThan(1)
  })

  it('pins the regression itself: the old three-token list is not the server set', () => {
    expect([...unionTokens(serverSource(), 'ServiceProxySetting')].sort()).not.toEqual(['grpc', 'other', 'unset'])
    expect(unionTokens(serverSource(), 'ServiceProxySetting')).toEqual(
      expect.arrayContaining(['grpc', 'http', 'auto', 'unset', 'other']),
    )
  })

  /* ------------------------------------------------------------------------ */
  /* The two unions the launcher's own decisions arrive as                    */
  /* ------------------------------------------------------------------------ */

  /**
   * The same tie for a union written across several lines.
   *
   * `unionTokens` matches one LINE, which is all the five above need and is why
   * it throws rather than returning `[]` when the shape changes. The two
   * launcher unions are declared in the leading-`|` form, so they need a parser
   * that reads to the end of the declaration — taken as the first blank line,
   * which is what separates every declaration in that file from the comment
   * block of the next one.
   *
   * It throws on a missing declaration for exactly the reason the other one
   * does: a parse that answered `[]` on a renamed union would turn its
   * comparison into a comparison against nothing.
   */
  const declaredUnion = (source: string, name: string): string[] => {
    const marker = `\nexport type ${name} =`
    const start = source.replace(/\r\n/g, '\n').indexOf(marker)
    if (start < 0) {
      throw new Error(`no "export type ${name} =" declaration in ${SERVER_SOURCE}`)
    }

    const body = source.replace(/\r\n/g, '\n').slice(start + marker.length)
    const end = body.indexOf('\n\n')
    const tokens = [...(end < 0 ? body : body.slice(0, end)).matchAll(/'([^']+)'/g)].map((match) => match[1])
    if (tokens.length === 0) {
      throw new Error(`"export type ${name}" declares no quoted members`)
    }

    return tokens
  }

  const CONTINUED: ReadonlyArray<[string, readonly string[]]> = [
    ['ServiceProxyDecision', SERVICE_PROXY_DECISIONS],
    ['InternalGrpcSecretState', INTERNAL_GRPC_SECRET_STATES],
  ]

  for (const [name, tokens] of CONTINUED) {
    it(`names exactly the ${name} tokens the server declares`, () => {
      expect([...declaredUnion(serverSource(), name)].sort()).toEqual([...tokens].sort())
    })
  }

  it('reads the multi-line parser against a declaration it can also prove is there', () => {
    const source = serverSource()

    for (const [name] of CONTINUED) {
      expect(source).toContain(`export type ${name} =`)
      expect(declaredUnion(source, name).length).toBeGreaterThan(1)
    }
    // And it stops at the end of the declaration rather than swallowing the next
    // one: the two unions are adjacent in that file, and a parser that ran on
    // would make each of the comparisons above pass against the union of both.
    expect(declaredUnion(source, 'ServiceProxyDecision')).not.toContain('mint-failed')
    expect(declaredUnion(source, 'InternalGrpcSecretState')).not.toContain('grpc-default')
  })

  it('throws rather than passing vacuously when a continued declaration is gone', () => {
    const renamed = serverSource().replace('export type InternalGrpcSecretState =', 'export type SecretOrigin =')

    expect(() => declaredUnion(renamed, 'InternalGrpcSecretState')).toThrow(
      'no "export type InternalGrpcSecretState =" declaration',
    )
    expect(declaredUnion(serverSource(), 'InternalGrpcSecretState').length).toBeGreaterThan(1)
  })

  it('fails when the server declares a secret-origin token this build does not name', () => {
    const planted = serverSource().replace(
      'export type InternalGrpcSecretState =\n',
      "export type InternalGrpcSecretState =\n  | 'rotated'\n",
    )

    expect(declaredUnion(planted, 'InternalGrpcSecretState')).toContain('rotated')
    expect([...declaredUnion(planted, 'InternalGrpcSecretState')].sort()).not.toEqual(
      [...INTERNAL_GRPC_SECRET_STATES].sort(),
    )
  })

  /* ------------------------------------------------------------------------ */
  /* The env-key list, which had no tie at all — and that is why it drifted   */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE MIRROR NOBODY WAS WATCHING. ***
   *
   * The five topology unions have been pinned to the server source for a while.
   * `DIAGNOSTIC_ENV_KEYS` was not pinned to anything, and it drifted exactly as
   * an unpinned mirror does: the server added `API_GATEWAY_SQS_QUEUE_URL`, this
   * build had no row for it, and the only trace was the count on the
   * "Reported by a newer server" row reading 1 — which is the mechanism working
   * as designed, and is still a row an operator has to interpret.
   *
   * Set equality in BOTH directions, because the two failures are different: a
   * key the server reports and this build cannot name is a row the operator
   * loses, and a key this build declares that the server never sends is a row
   * that silently never appears — a knob implied to exist.
   */
  const envKeys = (source: string): string[] => {
    const anchor = 'export const DIAGNOSTIC_ENV_KEYS = ['
    const start = source.indexOf(anchor)
    if (start < 0) {
      throw new Error(`no "${anchor}" in ${SERVER_SOURCE}`)
    }

    const end = source.indexOf('] as const', start)
    if (end < 0) {
      throw new Error(`"${anchor}" is not terminated in ${SERVER_SOURCE}`)
    }

    const tokens = [...source.slice(start + anchor.length, end).matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(
      (match) => match[1],
    )
    if (tokens.length === 0) {
      throw new Error(`"${anchor}" lists no variable names`)
    }

    return tokens
  }

  it('declares a row for exactly the variables the server reports presence for', () => {
    expect([...envKeys(serverSource())].sort()).toEqual([...DECLARED_ENV_KEYS].sort())
  })

  it('is parsing a real list rather than an accidental match', () => {
    const keys = envKeys(serverSource())

    expect(keys.length).toBeGreaterThan(15)
    // The two halves of the pair the queue rows read, both present by name.
    expect(keys).toContain('SQS_QUEUE_URL')
    expect(keys).toContain('API_GATEWAY_SQS_QUEUE_URL')
    // Nothing from the surrounding prose: the block is full of backquoted names.
    for (const key of keys) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('fails when the server reports a variable this build has no row for', () => {
    const planted = serverSource().replace("  'SNS_TOPIC_ARN',", "  'SNS_TOPIC_ARN',\n  'SOME_LATER_QUEUE_VARIABLE',")

    expect(envKeys(planted)).toContain('SOME_LATER_QUEUE_VARIABLE')
    expect([...envKeys(planted)].sort()).not.toEqual([...DECLARED_ENV_KEYS].sort())
  })

  it('throws rather than passing vacuously when the list it parses is gone', () => {
    const renamed = serverSource().replace('export const DIAGNOSTIC_ENV_KEYS = [', 'export const ENV_KEYS = [')

    expect(() => envKeys(renamed)).toThrow('no "export const DIAGNOSTIC_ENV_KEYS = ["')
  })

  /**
   * The BEHAVIOUR the tie exists for, asserted through the real builder: a
   * payload carrying every key the server sends must leave nothing for the
   * unrecognised count. Asserting the tie alone would pass over a client that
   * knows the names and still fails to group one of them into a row.
   */
  it('recognises every key a current server sends, so the count reads zero', () => {
    const model = buildEnvironmentSection({
      topology: topology({ presence: Object.fromEntries(envKeys(serverSource()).map((key) => [key, true])) }),
    })

    expect(rowOf(model, 'Variables this build does not recognise').value).toBe('0')
    // Not vacuous: the key that WAS unrecognised is now a row of its own.
    expect(rowOf(model, 'API_GATEWAY_SQS_QUEUE_URL').value).toBe('set (optional)')
  })
})

describe('the SERVICE_PROXY_TYPE row', () => {
  /**
   * The wire field is a `string`; `DeploymentTopology` types it as a union as a
   * compile-time mirror of the server, and a newer or misbehaving server can put
   * anything there. Crossing that boundary is the whole reason the row goes
   * through `safeEnum`, so the fixture has to be able to cross it too.
   */
  const withSetting = (value: string): EnvironmentSectionInput => ({
    topology: topology({ serviceProxySetting: value as DeploymentTopology['serviceProxySetting'] }),
  })

  for (const setting of ['grpc', 'http', 'auto', 'unset']) {
    it(`prints ${setting} as itself rather than as unrecognised`, () => {
      const row = rowOf(buildEnvironmentSection(withSetting(setting)), 'SERVICE_PROXY_TYPE')

      expect(row.value).toBe(setting)
      expect(row.value).not.toBe(UNRECOGNISED)
      // Only the LABEL was ever wrong here: the row carries no verdict, and
      // widening the vocabulary must not have given it one.
      expect(row.verdict).toBe('informational')
    })
  }

  it('still collapses a value outside the set, and does not case-fold', () => {
    for (const rejected of ['GRPC', 'grpc ', 'direct', 'Auto', '']) {
      expect(rowOf(buildEnvironmentSection(withSetting(rejected)), 'SERVICE_PROXY_TYPE').value).toBe(UNRECOGNISED)
    }
  })

  it('never echoes the refused value, on the row or anywhere in the model', () => {
    const model = buildEnvironmentSection(withSetting('PLANTED-PROXY-SETTING-MARKER'))

    expect(JSON.stringify(model)).not.toContain('PLANTED-PROXY-SETTING-MARKER')
    expect(rowOf(model, 'SERVICE_PROXY_TYPE').value).toBe(UNRECOGNISED)
  })
})
