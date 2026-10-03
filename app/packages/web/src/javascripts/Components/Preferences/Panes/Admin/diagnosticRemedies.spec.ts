import {
  EFFORT_LABEL,
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnrecognisedPreconditions,
  remedyForUnstampedDeployment,
  type DeploymentTopology,
  type RemedyEffort,
} from './diagnosticRemedies'
import { EFFORT_TONE } from './diagnosticsPresentation'
import { CLIENT_KNOWN_OPERATIONS, UNRECOGNISED_OPERATION, type KnownLiveRefusalReason } from './syncDiagnostics'

/**
 * A planted value with NO structure for a denylist to match — the class of
 * secret `sanitizeServerCopy` says itself it cannot catch, and the class the
 * live probe proved printed verbatim.
 *
 * Built from markers rather than plausible prose so a fragment cannot collide
 * with the build's own copy, and asserted by its head, middle and tail so a
 * truncation at any width still fails: the tail sits past 60 characters, which
 * is where a peer's planted fragments all quietly landed earlier tonight.
 */
const PLANTED_HEAD = 'SRNLEAKHEAD41'
const PLANTED_MIDDLE = 'SRNLEAKMIDDLE62'
const PLANTED_TAIL = 'SRNLEAKTAIL83'
const PLANTED_OPAQUE_OPERATION = `${PLANTED_HEAD}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_MIDDLE}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_TAIL}`
const PLANTED_FRAGMENTS = [PLANTED_HEAD, PLANTED_MIDDLE, PLANTED_TAIL, PLANTED_OPAQUE_OPERATION]

/**
 * The remedies are the part of the panel that can do damage. A wrong instruction
 * here costs an operator a restart and points their suspicion at the wrong
 * subsystem — which is the exact failure the panel was built to end — so these
 * tests are written around the cases where the OBVIOUS advice is wrong.
 */

const topology = (overrides: Partial<DeploymentTopology> = {}): DeploymentTopology => ({
  recorded: true,
  mode: 'unset',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'unset',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: true,
  redisBound: false,
  presence: {},
  ...overrides,
})

const STOCK_GRPC_REMEDY =
  'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend'

describe('remedyForPrecondition — no topology reported', () => {
  /**
   * *** THE SERVER'S COPY IS NO LONGER WHAT THIS BRANCH PRINTS. ***
   *
   * It used to be: `remedyForPrecondition` took the server's remedy beside the
   * code and, with no topology to reason from, printed it through
   * `sanitizeServerCopy` — which is a denylist. On an unrecorded topology that is
   * EVERY condition, so the denylist was the only thing between server prose and
   * the copyable report, and a marker-built remedy with no address shape was
   * measured going through it intact. This branch now prints this build's own
   * copy for the condition, still marked `generic` because it is not derived from
   * this deployment.
   */
  it('prints this build’s own copy for the condition and marks it generic, never the server’s', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', undefined)

    expect(remedy.basis).toBe('generic')
    expect(remedy.summary).not.toBe(STOCK_GRPC_REMEDY)
    expect(remedy.summary).toContain('SERVICE_PROXY_TYPE')
    expect(remedy.because.join(' ')).toContain('may not apply here')
    // And it says WHY the server's sentence is not beside it.
    expect(remedy.because.join(' ')).toContain('prose the server chose')
  })

  it('treats an unrecorded topology exactly like an absent one, rather than as a set of falses', () => {
    const remedy = remedyForPrecondition('REDIS_UNBOUND', {
      recorded: false,
      mode: 'home-server',
    })

    expect(remedy.basis).toBe('generic')
  })

  /**
   * *** THE TYPE IS THE GUARANTEE. ***
   *
   * `code` is a closed union of literals this build compiled in, so a code off
   * the payload cannot be passed at all. If this line ever starts compiling, the
   * `@ts-expect-error` becomes the failure — which is the point: the parameter
   * widening back to `string` is exactly how the leak would come back.
   */
  it('does not compile when handed a code off the wire', () => {
    const fromTheWire: string = 'SOME_FUTURE_CONDITION'

    // @ts-expect-error a server-supplied string is not a KnownPreconditionCode
    const remedy = remedyForPrecondition(fromTheWire, topology())

    // The allowlist runs at RUNTIME as well, because a type is erased and one
    // `as` at a future call site would otherwise reopen the hole invisibly.
    expect(remedy.summary).not.toContain('SOME_FUTURE_CONDITION')
    expect(remedy.effort).toBe('client-update')
    expect(remedy.summary).toContain('1 unmet condition')
  })

  it('does not compile when handed a live refusal reason off the wire either', () => {
    const fromTheWire: string = 'some-future-reason'

    // @ts-expect-error a server-supplied string is not a KnownLiveRefusalReason
    expect(remedyForLiveReason(fromTheWire, topology())).toBeUndefined()
  })
})

/**
 * *** COUNTED, NEVER NAMED. *** The conditions this build cannot explain.
 *
 * The old behaviour was to pass the unrecognised code and the server's advice
 * for it straight through "instead of dropping it", on the argument that
 * silently dropping a newer server's diagnosis turns it into a blank space. The
 * blank space was the right worry and the wrong fix: both strings are chosen by
 * the server, and the count plus the list of what this build DOES know says
 * which side of the wire the gap is on, which an echo of a code the reader has
 * never seen does not.
 */
describe('remedyForUnrecognisedPreconditions', () => {
  it('counts the conditions, names the ones this build knows, and echoes neither code nor server prose', () => {
    const remedy = remedyForUnrecognisedPreconditions(3)

    expect(remedy.summary).toContain('3 unmet conditions')
    expect(remedy.effort).toBe('client-update')
    expect(remedy.basis).toBe('verified')
    expect(remedy.because.join(' ')).toContain('WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING')
    expect(remedy.because.join(' ')).toContain('SYNCING_SERVER_GRPC_UNBOUND')
  })

  it('agrees singular and plural, so one condition does not read as a template', () => {
    expect(remedyForUnrecognisedPreconditions(1).summary).toContain('1 unmet condition outside')
    expect(remedyForUnrecognisedPreconditions(2).summary).toContain('2 unmet conditions outside')
  })

  /**
   * The narrow claim, stated. A client update restores the EXPLANATION; it does
   * not clear the condition. A remedy an operator could read the other way would
   * be the confidently-wrong kind this module exists to prevent.
   */
  it('does not claim that updating the client clears the condition', () => {
    const remedy = remedyForUnrecognisedPreconditions(1)

    expect(remedy.summary).toContain('does not itself clear the condition')
    expect(remedy.steps.join(' ')).toContain('boot log')
  })

  it('refuses a count that is not a positive integer rather than printing it', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(remedyForUnrecognisedPreconditions(count).summary).toContain('1 unmet condition')
    }
  })
})

describe('remedyForPrecondition — SYNCING_SERVER_GRPC_UNBOUND', () => {
  it('refuses to recommend the variable in home-server mode, where nothing can bind the proxy', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      topology({ mode: 'home-server', boundServiceProxy: 'direct-call', grpcProxyBindableInThisMode: false }),
    )

    expect(remedy.effort).toBe('none')
    expect(remedy.basis).toBe('verified')
    expect(remedy.steps).toHaveLength(0)
    expect(remedy.summary).toContain('Do not set SYNCING_SERVER_GRPC_URL')
    expect(remedy.because.join(' ')).toContain('in-process')
  })

  it('says plainly that the already-set URL is being ignored, rather than telling the operator to set it again', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      topology({ mode: 'self-hosted', presence: { SYNCING_SERVER_GRPC_URL: true } }),
    )

    expect(remedy.effort).toBe('restart')
    expect(remedy.summary).toContain('SERVICE_PROXY_TYPE')
    expect(remedy.steps[0]).toContain('SERVICE_PROXY_TYPE=grpc')
    expect(remedy.steps[1]).toContain('already set')
    expect(remedy.because.join(' ')).toContain('would have led nowhere')
  })

  it('warns that turning on the gRPC branch without AUTH_SERVER_GRPC_URL stops the gateway starting', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      topology({ mode: 'self-hosted', presence: { AUTH_SERVER_GRPC_URL: false } }),
    )

    expect(remedy.steps.join(' ')).toContain('fail to start')
  })

  it('names the 32-byte floor on the internal auth secret, which silently closes the lane', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology())

    expect(remedy.steps.join(' ')).toContain('32 bytes')
  })

  /**
   * N33. `MODE=self-hosted` is the bundled MULTI-container `server` image — its
   * entrypoint exports that value, so it is what the shipped compose stack
   * reports. The step used to open "On the bundled single-container image",
   * which sent every compose operator looking for a container they do not run;
   * the single container reports `home-server` and is the case where gRPC is
   * not applicable at all.
   */
  it('gives the compose stack the .env switch, and never calls it a single container', () => {
    const composeStack = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ mode: 'self-hosted' }))
    const distributed = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ mode: 'unset' }))

    const steps = composeStack.steps.join(' ')
    expect(steps).toContain('SERVICE_PROXY_TYPE=grpc in your .env')
    // D2: the compose passthrough is what makes the .env value arrive.
    expect(steps).toContain('API_GATEWAY_SERVICE_PROXY_TYPE')
    expect(steps).toContain('does not have to be rebuilt')
    expect(steps).not.toContain('single-container')
    expect(distributed.steps.join(' ')).not.toContain('API_GATEWAY_SERVICE_PROXY_TYPE')
  })

  it('tells the single container the condition is not applicable rather than naming a variable', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      topology({ mode: 'home-server', boundServiceProxy: 'direct-call', grpcProxyBindableInThisMode: false }),
    )

    expect(remedy.summary).toContain('Not applicable')
    expect(remedy.summary).toContain('single-container')
    expect(remedy.effort).toBe('none')
  })

  /**
   * t108. The server used to report both `http` and `auto` as
   * `other (unrecognised)`, so this branch could only say "not set to grpc".
   * Now that the two arrive distinctly, the reasoning says which one it is —
   * and in the `auto` case it warns off the obvious override, because the
   * container's resolver chose HTTP deliberately and `grpc` has no HTTP
   * fallback.
   */
  it.each([
    ['http', 'a deliberate pin', 'deliberate pin to the HTTP proxies'],
    ['auto', 'the resolver’s own decision', 'decided for itself'],
  ] as const)('tells an explicit %s setting apart from an unset one (%s)', (setting, _label, expected) => {
    const explicit = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ serviceProxySetting: setting }))
    const unset = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology())

    // Both still get the same FIX — the branch only runs when the setting is
    // not "grpc" — and the reasoning is what differs.
    expect(explicit.effort).toBe('restart')
    expect(explicit.steps).toEqual(unset.steps)
    expect(explicit.because.join(' ')).toContain(expected)
    expect(explicit.because.join(' ')).not.toBe(unset.because.join(' '))
    expect(unset.because.join(' ')).toContain('is not set to "grpc"')
  })

  it('warns an auto deployment that forcing grpc removes the fallback its resolver was protecting', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ serviceProxySetting: 'auto' }))

    expect(remedy.because.join(' ')).toContain('removes the HTTP fallback')
  })

  it('does not invent a fix when the branch is selected but the proxy is still unbound', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ serviceProxySetting: 'grpc' }))

    expect(remedy.effort).toBe('wait')
    expect(remedy.steps).toHaveLength(0)
    expect(remedy.summary).toContain('Do not change configuration')
  })
})

describe('remedyForPrecondition — REDIS_UNBOUND', () => {
  it('names CACHE_TYPE, not REDIS_URL, when the memory cache is what suppresses the binding', () => {
    const remedy = remedyForPrecondition(
      'REDIS_UNBOUND',
      topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }),
    )

    expect(remedy.summary).toContain('CACHE_TYPE')
    expect(remedy.steps[0]).toContain('CACHE_TYPE')
    expect(remedy.steps[1]).toContain('already set')
  })

  it('sends a home-server deployment to REDIS_HOST and warns off CACHE_TYPE', () => {
    const remedy = remedyForPrecondition('REDIS_UNBOUND', topology({ mode: 'home-server' }))

    expect(remedy.summary).toContain('REDIS_HOST')
    expect(remedy.because.join(' ')).toContain('forces CACHE_TYPE=memory')
  })

  it('catches the REDIS_HOST-set-but-REDIS_URL-missing trap in a distributed deployment', () => {
    const remedy = remedyForPrecondition(
      'REDIS_UNBOUND',
      topology({ presence: { REDIS_HOST: true, REDIS_URL: false } }),
    )

    expect(remedy.steps.join(' ')).toContain('REDIS_URL only')
    expect(remedy.because.join(' ')).toContain('without realising it')
  })
})

describe('remedyForPrecondition — the remaining conditions', () => {
  it('explains a kill switch as deliberate rather than as a fault', () => {
    const remedy = remedyForPrecondition(
      'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
      topology({ syncSwitchSetting: 'false' }),
    )

    expect(remedy.because.join(' ')).toContain('deliberate kill switch')
    expect(remedy.effort).toBe('restart')
  })

  it('tells a multi-replica deployment the connection token must match across replicas', () => {
    const remedy = remedyForPrecondition('WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING', topology())

    expect(remedy.steps.join(' ')).toContain('SAME value on every gateway replica')
  })

  it('notices when the token secret is present now but was absent at boot', () => {
    const remedy = remedyForPrecondition(
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      topology({ presence: { WEB_SOCKET_CONNECTION_TOKEN_SECRET: true } }),
    )

    expect(remedy.because.join(' ')).toContain('arrived after boot')
  })

  /**
   * The host's own condition, and the one with no other symptom: the gate's four
   * conditions all pass, the host then refuses to attach rather than publish on
   * a sibling stack's un-namespaced channels, and every other reading on the
   * screen looks configured.
   */
  it('explains why an invalid Redis namespace attaches nothing at all', () => {
    const remedy = remedyForPrecondition('WEBSOCKET_REDIS_NAMESPACE_INVALID', topology())

    expect(remedy.basis).toBe('verified')
    expect(remedy.effort).toBe('restart')
    // The server's own frozen sentence (SYNC_HOST_REMEDIES) used to be carried
    // through here rather than reproduced, so the two could not drift apart
    // unnoticed. That argument was about DRIFT and this is a trust boundary: the
    // string arrives over the wire, it is a frozen constant only "in a correct
    // server", and this was one of the paths that carried it into the copyable
    // report. The drift risk is now accepted and stated in the source instead.
    expect(remedy.because.join(' ')).not.toContain('The server states')
    expect(remedy.steps.join(' ')).toContain('unset it entirely')
    expect(remedy.steps.join(' ')).toContain('SAME value on every process')
    expect(remedy.because.join(' ')).toContain('declined afterwards')
  })
})

describe('remedyForLiveReason', () => {
  it('does not treat an unreachable Redis as a missing setting', () => {
    const remedy = remedyForLiveReason('ticket-store-unavailable', topology())

    expect(remedy?.effort).toBe('wait')
    expect(remedy?.summary).toContain('infrastructure fault')
  })

  it('points sync-not-configured back at the gate instead of restating it as its own problem', () => {
    const remedy = remedyForLiveReason('sync-not-configured', topology())

    expect(remedy?.effort).toBe('none')
  })

  it('distinguishes an unset origin list from one that resolved to nothing', () => {
    const set = remedyForLiveReason(
      'no-allowed-origins',
      topology({ presence: { WEBSOCKET_SYNC_ALLOWED_ORIGINS: true } }),
    )
    const unset = remedyForLiveReason('no-allowed-origins', topology())

    expect(set?.because.join(' ')).toContain('resolved to nothing usable')
    expect(unset?.because.join(' ')).toContain('is not set')
  })

  /**
   * N39. Both of these had panel COPY and no remedy block, so the one screen
   * built to answer "what do I do" printed "this client build has no guidance
   * for it" — for the condition with the shortest fix on it.
   */
  it('names the single variable behind an unready authorization adapter', () => {
    const remedy = remedyForLiveReason('authorization-adapter-unavailable', topology())

    expect(remedy).toBeDefined()
    expect(remedy?.summary).toContain('AUTH_JWT_SECRET')
    expect(remedy?.effort).toBe('restart')
    expect(remedy?.steps.join(' ')).toContain('SAME value the auth server uses')
    expect(remedy?.because.join(' ')).toContain('not set on this deployment')
  })

  it('notices an authorization secret that is present now but did not reach the process', () => {
    const remedy = remedyForLiveReason(
      'authorization-adapter-unavailable',
      topology({ presence: { AUTH_JWT_SECRET: true } }),
    )

    expect(remedy?.because.join(' ')).toContain('confirm the value reached this process')
  })

  it('tells the operator NOT to restart for an invite store that no longer gates the lane', () => {
    const remedy = remedyForLiveReason('invite-event-store-unavailable', topology())

    expect(remedy).toBeDefined()
    expect(remedy?.effort).toBe('wait')
    expect(remedy?.summary).toContain('INVITE_EVENTS only')
    expect(remedy?.steps.join(' ')).toContain('Do not restart on this alone')
  })

  /**
   * It used to take `reason: string` and this case passed one straight in. The
   * function never printed what it was handed — it matched and returned
   * `undefined` — but every CALLER then had a wire string in hand beside the
   * remedy, and two of them printed it. The closed union moves the admission to
   * the call site, where it can be counted; the runtime check stays because a
   * type is erased. The compile-time half is pinned above.
   */
  it('returns nothing for a reason outside its closed set, so the UI can say so', () => {
    expect(remedyForLiveReason('some-future-reason' as KnownLiveRefusalReason, topology())).toBeUndefined()
  })
})

describe('the remedies that are not config changes', () => {
  it('states that an unstamped build cannot be stamped at runtime', () => {
    const remedy = remedyForUnstampedDeployment()

    expect(remedy.effort).toBe('rebuild')
    expect(remedy.steps.join(' ')).toContain('does NOT stamp it')
  })

  /**
   * t108. The step used to say `--build-arg SRN_DEPLOY_REVISION=$(git rev-parse
   * HEAD)`, which is sufficient at BUILD time and was measured insufficient end
   * to end: that build followed by a bare `docker compose up -d` publishes
   * `{revision: null, version: null}` — indistinguishable from the unstamped
   * image the operator just rebuilt to fix. The identity is only published when
   * the RUNTIME value equals the baked marker, and compose feeds the same shell
   * variable to `build.args` AND to the service environment, so one assignment
   * in front of the whole command satisfies both and a `--build-arg` satisfies
   * only the first.
   */
  it('gives an instruction that actually publishes the identity, not one that only bakes the marker', () => {
    const steps = remedyForUnstampedDeployment().steps.join(' ')

    // The command as a whole, so a reader can paste it.
    expect(steps).toContain('SRN_DEPLOY_REVISION=$(git rev-parse HEAD) docker compose up -d --build')
    // And it must not be reduced to the build argument, which is the half that
    // was measured not to work on its own.
    expect(steps).not.toContain('--build-arg SRN_DEPLOY_REVISION')
    expect(steps).toContain('not as a --build-arg')
    expect(steps).toContain('needed in both')
    expect(remedyForUnstampedDeployment().because.join(' ')).toContain('AGREEMENT of the baked marker')
  })

  it('states that a client gap has no server-side fix', () => {
    const remedy = remedyForClientGap(['FILES_V1'])

    expect(remedy.effort).toBe('client-update')
    expect(remedy.summary).toContain('FILES_V1')
  })

  /**
   * *** THE REDACTOR IS NOT THE MECHANISM HERE, AND MUST NOT BECOME ONE AGAIN. ***
   *
   * The operation names are the one thing this module interpolates from the wire.
   * They were joined raw, then joined through `sanitizeServerCopy`, and a live
   * probe measured what the second was worth: an address-shaped operation name
   * was withheld and the opaque value `hunter2` printed intact — on the Overview,
   * in the WebSocket capability block and in the copyable report.
   *
   * So the test asserts the ABSENCE of the redactor's own output on this path.
   * Reinstating `sanitizeServerCopy` as the defence here fails it, which is the
   * point: a denylist cannot catch a secret with no structure, and no amount of
   * extra patterns changes that.
   */
  it('counts an operation it cannot name, and does not reach for the redactor to do it', () => {
    const remedy = remedyForClientGap([UNRECOGNISED_OPERATION, UNRECOGNISED_OPERATION])

    expect(remedy.summary).toContain('2 operations this build does not recognise')
    expect(remedy.summary).not.toContain('[address withheld]')
    expect(remedy.effort).toBe('client-update')
  })

  it('counts one as one, and still names alongside the count where it has a name to use', () => {
    expect(remedyForClientGap([UNRECOGNISED_OPERATION]).summary).toContain('1 operation this build does not recognise')
    expect(remedyForClientGap(['FILES_V1', UNRECOGNISED_OPERATION]).summary).toContain(
      'FILES_V1 and 1 operation this build does not recognise',
    )
  })

  /**
   * The count is only actionable beside the list it is a complement of, so the
   * remedy carries that list — which costs nothing, because every name in it is
   * already compiled into the bundle the reader is running.
   */
  it('names the operations this build does declare, so the count says which side the gap is on', () => {
    const because = remedyForClientGap([UNRECOGNISED_OPERATION]).because.join(' ')

    for (const operation of CLIENT_KNOWN_OPERATIONS) {
      expect(because).toContain(operation)
    }
  })

  /**
   * *** THE CONTRACT, ASSERTED BY THE COMPILER. ***
   *
   * `ClientGapSubject` is a closed union of literals this build owns, so the
   * `@ts-expect-error` below IS the assertion: handing this function
   * `protocol.serverOperations` is a type error, and the test fails if it ever
   * stops being one. The runtime check behind it is defence in depth for an `as`
   * at some future call site — a type is erased, and that cast would be
   * invisible — so a value that gets past the compiler is counted, not printed.
   */
  it('cannot be handed a wire string, and prints nothing if one is forced through', () => {
    // @ts-expect-error a server-supplied operation name is not a ClientGapSubject
    const remedy = remedyForClientGap([PLANTED_OPAQUE_OPERATION])
    const everything = JSON.stringify(remedy)

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(everything).not.toContain(fragment)
    }
    expect(remedy.summary).toContain('1 operation this build does not recognise')
  })
})

/**
 * The effort vocabulary. Three members were added in one evening — `device`,
 * `peer-service` and now `account-setting` — which is why these pin the thing
 * that actually goes wrong with a vocabulary like this: a new member that reuses
 * an existing LABEL, so two different kinds of fix render identically and the
 * chip stops carrying information.
 */
describe('RemedyEffort', () => {
  const EVERY_EFFORT = [
    'account-setting',
    'restart',
    'rebuild',
    'peer-service',
    'device',
    'client-update',
    'none',
    'wait',
  ] as const satisfies readonly RemedyEffort[]

  it('labels and tones every member, with no two members sharing a label', () => {
    // `satisfies` above makes a MISSING member a compile error; this makes an
    // EXTRA one a test failure, so the list cannot fall behind the union in
    // either direction without something going red.
    expect(Object.keys(EFFORT_LABEL).sort()).toEqual([...EVERY_EFFORT].sort())
    expect(Object.keys(EFFORT_TONE).sort()).toEqual([...EVERY_EFFORT].sort())

    const labels = EVERY_EFFORT.map((effort) => EFFORT_LABEL[effort])
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0)
    }
  })

  /**
   * t108. `ACCOUNT_LIVE_SYNC_DISABLED` — the per-user "Live sync" toggle in
   * Admin → Users — shipped with NO remedy block because neither candidate
   * member described it: `restart` renders "Config + restart", wrong for a
   * setting that applies immediately, and `none` renders "Not fixable here",
   * wrong for something fixable in two clicks on this screen.
   */
  it('gives an in-app account setting a label that is neither a restart nor a dead end', () => {
    expect(EFFORT_LABEL['account-setting']).toBe('Admin setting')
    expect(EFFORT_LABEL['account-setting']).not.toBe(EFFORT_LABEL.restart)
    expect(EFFORT_LABEL['account-setting']).not.toBe(EFFORT_LABEL.none)
    // It is the most reachable fix on the screen, so it takes the same tone as
    // the other two the reader can act on without leaving the app.
    expect(EFFORT_TONE['account-setting']).toBe('good')
    expect(EFFORT_TONE['account-setting']).not.toBe(EFFORT_TONE.none)
  })
})

describe('secrecy', () => {
  it('never emits a value, because it is never given one', () => {
    // The topology type carries booleans and closed enums only. This asserts the
    // consequence end-to-end: feed every presence flag as true and every enum at
    // its most "configured" setting, and the output is still only names.
    const everything = topology({
      mode: 'self-hosted',
      serviceProxySetting: 'unset',
      presence: Object.fromEntries(
        [
          'SYNCING_SERVER_GRPC_URL',
          'AUTH_SERVER_GRPC_URL',
          'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET',
          'REDIS_URL',
          'REDIS_HOST',
          'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
          'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
          'PUBLIC_URL',
        ].map((key) => [key, true]),
      ),
    })

    const text = [
      ...(['SYNCING_SERVER_GRPC_UNBOUND', 'REDIS_UNBOUND', 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'] as const).map(
        (code) => remedyForPrecondition(code, everything),
      ),
      remedyForLiveReason('no-allowed-origins', everything),
      remedyForUnstampedDeployment(),
    ]
      .map((remedy) => JSON.stringify(remedy))
      .join(' ')

    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/redis:\/\//)
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
  })

  /**
   * The test above asserts the consequence of the TYPE: feed the topology its
   * most "configured" legal values and only names come out. That passes against
   * a module with no boundary discipline at all, because the fixture is legal.
   *
   * This one plants ILLEGAL values in the closed-enum fields. The topology is
   * JSON cast at the boundary, so the union is a compile-time claim about a
   * value this build never constructed, and two `because` lines interpolated
   * those fields straight into prose — making a field believed to be an enum a
   * channel for arbitrary text on a screen designed to be pasted into an issue.
   */
  it('will not echo a string a server put in a field this build believes is an enum', () => {
    const hostile = {
      ...topology({ serviceProxySetting: 'unset', syncSwitchSetting: 'nonsense' as 'other' }),
      boundServiceProxy: 'syncing.internal.example:50051' as 'http',
    }

    const text = [
      remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', hostile),
      remedyForPrecondition('WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION', hostile),
    ]
      .map((remedy) => JSON.stringify(remedy))
      .join(' ')

    expect(text).not.toContain('syncing.internal.example')
    expect(text).not.toContain('nonsense')
    // Collapsed to a constant this build owns, rather than dropped — the row
    // still says that something unexpected was reported.
    expect(text).toContain('unrecognised')
  })

  /**
   * The case above plants an ADDRESS-shaped value, which `sanitizeServerCopy`
   * would also have caught — so on its own it does not distinguish the member
   * check from the redactor. This one plants a value with no structure at all, in
   * both closed-enum fields, and asserts head, middle and tail.
   */
  it('withholds an OPAQUE value from an enum field, which no redactor could have caught', () => {
    const hostile = {
      ...topology({ syncSwitchSetting: PLANTED_OPAQUE_OPERATION as 'other' }),
      boundServiceProxy: PLANTED_OPAQUE_OPERATION as 'http',
    }

    const text = [
      remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', hostile),
      remedyForPrecondition('WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION', hostile),
    ]
      .map((remedy) => JSON.stringify(remedy))
      .join(' ')

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(text).not.toContain(fragment)
    }
    expect(text).toContain('unrecognised')
  })

  it('still prints a legal enum member, so the guard is not just a blanket redaction', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', topology({ boundServiceProxy: 'direct-call' }))

    expect(remedy.because.join(' ')).toContain('"direct-call"')
    expect(remedy.because.join(' ')).not.toContain('unrecognised')
  })
})
