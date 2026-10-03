import {
  buildEnvironmentGroups,
  type EnvironmentGroup,
  type EnvironmentRelevance,
  type EnvironmentRow,
} from './diagnosticEnvironment'
import {
  remedyForLiveReason,
  remedyForUnstampedDeployment,
  type DeploymentTopology,
  type Remedy,
  type RemedyEffort,
} from './diagnosticRemedies'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  outcomesForSection,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safeEnvName,
  safePresence,
  safeState,
  safeTokens,
  safeYesNo,
  type DiagnosticBlock,
  type DiagnosticFinding,
  type DiagnosticRow,
  type Evidence,
  type SafeValue,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import { DEPLOY_REVISION } from './reportAllowlist'
import { describeDeployment } from './syncDiagnostics'

/**
 * Standard Red Notes: the Environment & setup section of the admin diagnostics
 * pane — the rename-and-extend of what used to be the *Configuration* tab, now
 * also holding the deployment-identity block that sat on Overview.
 *
 * This is the section that answers "what kind of deployment is this, and which
 * of the knobs I turned does it actually read". Every other section describes a
 * symptom; this one describes the thing an operator can change.
 *
 * -------------------------------------------------------------------------------
 * What this module REUSES, and the one thing it deliberately supersedes.
 * -------------------------------------------------------------------------------
 *
 * `diagnosticEnvironment.ts` predates the section contract and contains the
 * expensive half of this subject: `classify()`, the per-variable judgement about
 * whether a key is read in the OBSERVED topology, which is the logic behind
 * "SYNCING_SERVER_GRPC_URL is set AND ignored". That is reused WHOLE —
 * `buildEnvironmentGroups` is called, its groups become blocks, its keys become
 * labels, its relevance becomes part of each value and its notes are printed
 * verbatim. Nothing in it is reimplemented here, and this module makes no
 * per-variable relevance judgement of its own.
 *
 * `describeTopology` from the same file is NOT reused, and the reason is
 * structural rather than stylistic. It returns `{ label, value, note }` as plain
 * strings, with `topology.mode ?? 'unknown'` already flattened into the value —
 * so it has (a) no way to cross the `SafeValue` boundary except by an `as`-cast
 * onto that brand, which `diagnosticsSections.spec.ts` greps every section
 * module for (as a plain substring, which is why that spelling does not appear
 * anywhere in this file), and (b) no way to distinguish "not reported" from a
 * reported value, which is rule 3 of the contract. Reusing it would mean
 * importing exactly the defect the contract exists to prevent, one cast at a
 * time. So the topology rows below read the same typed fields off
 * `DeploymentTopology` through `safeEnum`, and `describeTopology` stays
 * untouched for `diagnosticsReport.ts`, which still consumes it.
 *
 * `describeDeployment` IS reused, for the marker's sentinel handling, and
 * `remedyForUnstampedDeployment` and `remedyForLiveReason` are reused as-is. No
 * remedy that already exists is rewritten here.
 *
 * -------------------------------------------------------------------------------
 * Presence is not correctness, and this section is where that bites hardest.
 * -------------------------------------------------------------------------------
 *
 * Every configuration row in this section rests on a BOOLEAN that says a
 * variable is set to something non-empty. That is a necessary condition of the
 * variable being right and establishes nothing else: the live defect behind this
 * whole task was a short internal gRPC secret, present on both sides, over a
 * socket that withheld note syncing while the pane painted a green chip.
 *
 * So the positive arm of every presence row is
 * `evidenceProxy(…, necessaryCondition: true)`, which caps a `healthy` claim to
 * `undetermined` and prints why, while the negative arm of the same proxy
 * survives as `broken` because a necessary condition FAILING is conclusive.
 * Several rows on a perfectly healthy deployment therefore read `Unknown`. That
 * is the intended output: the panel is saying "this is set, which is not the same
 * as this working", and it is the honest reading of a presence map.
 *
 * -------------------------------------------------------------------------------
 * No value, ever — and no length either.
 * -------------------------------------------------------------------------------
 *
 * Variable NAMES are public: they are in the compose files, the `.env.sample`s
 * and the documentation, and `safeEnvName` admits them by shape. Nothing else
 * from the configuration reaches a row. In particular the internal gRPC auth
 * secret is reported as one of four closed states and never as a length: a
 * length is a fact about a secret, and the report this feeds is written to be
 * pasted in public. The threshold wording ("at least 32 bytes", "shorter than 32
 * bytes") is a constant of this build, derived from two closed enums.
 *
 * The deployment REVISION is not printed here at all, and that is a limit of the
 * contract rather than a secrecy decision: a 40-character git revision is not
 * one of `SafeValue`'s permitted categories, so it cannot be minted without the
 * banned cast. The literal revision and version are already admitted by shape in
 * `diagnosticsReport.ts` under its own Deployment heading; this section reports
 * the identity's STATE, which is the part that carries a verdict.
 */

/* -------------------------------------------------------------------------- */
/* The decision the deployment made about its own transport                   */
/* -------------------------------------------------------------------------- */

/**
 * `SRN_SERVICE_PROXY_TYPE_DECISION`, as computed by
 * `server/docker/internal-grpc-lane-env.sh`.
 *
 * The supervisor wrapper now defaults `SERVICE_PROXY_TYPE` to `grpc` by itself,
 * and only when every one of five conditions holds: both halves co-located, both
 * dial targets set, an internal secret of at least 32 bytes, and both gRPC ports
 * actually answering. Otherwise it leaves HTTP selected and records WHICH
 * condition declined.
 *
 * That changes what "http" means in this pane. It used to be the absence of a
 * setting — nothing to report beyond "unset". It is now a DECISION with a named
 * reason, and the reason is the most useful single field in this section: it is
 * the difference between "this deployment has no co-located syncing server, so
 * HTTP is correct" and "a dial target was configured and the port did not
 * answer".
 */
export const PROXY_DECISIONS = [
  /** An explicit `SERVICE_PROXY_TYPE` was supplied and left untouched. */
  'operator',
  /** Defaulted to gRPC: every condition held. */
  'grpc-default',
  /** No co-located syncing server to speak gRPC to. */
  'not-colocated',
  /** A gRPC dial target is missing. */
  'no-grpc-urls',
  /** No usable durable-command secret, so gRPC would only remove the fallback. */
  'no-secret',
  /** The auth gRPC listener did not answer; HTTP was kept. */
  'auth-grpc-unreachable',
  /** The syncing gRPC listener did not answer; HTTP was kept. */
  'syncing-grpc-unreachable',
] as const

export type ProxyDecision = (typeof PROXY_DECISIONS)[number]

/** The lanes the per-call gRPC fallback is counted on. Closed, server-side. */
export const GRPC_FALLBACK_LANES = ['session-validation', 'items-sync'] as const

export type GrpcFallbackLane = (typeof GRPC_FALLBACK_LANES)[number]

/** How a gRPC attempt failed, in the terms the fallback decision is made in. */
export const GRPC_FAILURE_CLASSES = [
  'channel-unavailable',
  'deadline-exceeded',
  'method-unimplemented',
  'transport-internal',
  'message-limit',
  'cancelled',
  'server-fault',
  'never-dispatched',
  'application',
] as const

/**
 * One lane's runtime fallback counters, as the admin payload reports them.
 *
 * Every member is a count, a closed code or a duration — the same shape the
 * server-side recorder is constrained to. Declared here, produced elsewhere, so
 * this section can be built and tested before this build's payload type catches
 * up with the server's; a field that does not arrive reads "not reported" and
 * claims nothing.
 */
export type TransportFallbackLaneView = {
  degradedCalls?: number
  refusedCalls?: number
  lastFailureClass?: string | null
  lastFailureAgeMs?: number | null
}

export type TransportFallbackView = {
  /** False when nothing has ever been recorded — including on an idle gateway. */
  observed?: boolean
  everDegraded?: boolean
  lanes?: Partial<Record<string, TransportFallbackLaneView>>
}

/**
 * The facts this section needs that the topology block cannot carry.
 *
 * All optional, all closed-category, and all absent on a server that does not
 * report them yet. `serviceProxyDecision` is typed as a WIDE string on purpose,
 * exactly as `gate.syncItems.state` is: it is the SERVER's enum, this build
 * cannot be recompiled against a newer server, and parsing it against this
 * build's own `PROXY_DECISIONS` through `safeEnum` is what makes an unrecognised
 * code degrade to "other (unrecognised)" instead of being rendered as one of the
 * members this build does know.
 *
 * The two cookie flags are EFFECTIVE VALUES rather than presence, and that is a
 * deliberate departure from the rest of this section: both default to `true`
 * when unset (`auth/Bootstrap/Container.ts`), so "not set" and "off" are
 * opposite answers and a presence boolean would invert the diagnosis. A boolean
 * switch's value is a permitted category; a secret's is not, which is why only
 * the switches are read this way. They are also read by the AUTH process rather
 * than the gateway, so they are supplied separately instead of being expected in
 * the gateway's `presence` map.
 */
export type EnvironmentRuntimeView = {
  serviceProxyDecision?: string
  /** Effective `COOKIE_SECURE`. Defaults to true when the variable is unset. */
  cookieSecure?: boolean
  /** Effective `COOKIE_PARTITIONED`. Defaults to true when the variable is unset. */
  cookiePartitioned?: boolean
  /** `E2E_TESTING === 'true'`, which forces legacy header sessions. */
  e2eTesting?: boolean
  /** How long this process has been up. A duration, never a start instant. */
  processUptimeSeconds?: number
}

export type EnvironmentSectionInput = {
  /** `payload.deployment`. Absent, or `recorded !== true`, means no topology claim. */
  topology?: DeploymentTopology
  /** Raw `/.well-known/srn-deployment.json` body. Untrusted; handled by `describeDeployment`. */
  deploymentMarker?: unknown
  /** `payload.transportFallback`. Absent on a server older than the per-call fallback. */
  fallback?: TransportFallbackView
  runtime?: EnvironmentRuntimeView
  outcomes?: readonly SectionTaggedOutcome[]
}

/* -------------------------------------------------------------------------- */
/* Closed vocabularies for the topology fields                                */
/* -------------------------------------------------------------------------- */

const DEPLOYMENT_MODES = ['home-server', 'self-hosted', 'unset', 'other'] as const

type DeploymentModeToken = (typeof DEPLOYMENT_MODES)[number]

const SERVICE_PROXY_SETTINGS = ['grpc', 'unset', 'other'] as const

const BOUND_SERVICE_PROXIES = ['direct-call', 'grpc', 'http'] as const

const CACHE_SETTINGS = ['memory', 'redis', 'unset', 'other'] as const

const SYNC_SWITCH_SETTINGS = ['true', 'false', 'unset', 'other'] as const

/**
 * The relevance vocabulary, as a tuple so `safeEnum` can admit it, with a
 * compile-time assertion that it still covers every member of
 * `EnvironmentRelevance`. A fifth relevance added over there would otherwise
 * arrive here as `other (unrecognised)` on every row at once — silent, and wrong
 * in a way a reader cannot see.
 */
export const ENVIRONMENT_RELEVANCES = ['required', 'optional', 'inert', 'unknown'] as const

type UnclassifiedRelevance = Exclude<EnvironmentRelevance, (typeof ENVIRONMENT_RELEVANCES)[number]>
type AssertNever<T extends never> = T
export type EveryRelevanceIsClassified = AssertNever<UnclassifiedRelevance>

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each relevance adds to a presence
 * value, so a report line reads `- REDIS_URL: set (never read here)` rather than
 * leaving the operator to pair a row with a legend.
 */
const RELEVANCE_SUFFIX: Record<EnvironmentRelevance, SafeValue> = {
  required: safeConstant('(required here)'),
  optional: safeConstant('(optional)'),
  inert: safeConstant('(never read here)'),
  unknown: safeConstant('(relevance not established)'),
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The deployment SHAPE each `MODE`
 * implies, in the words an operator uses for their own deployment.
 *
 * `self-hosted` is the bundled MULTI-container `server` image — its entrypoint
 * exports it, so it is what the shipped compose stack reports. It is emphatically
 * not the single container, which reports `home-server`. This panel has already
 * called that branch "the bundled single-container image" once and sent compose
 * operators looking for a container they do not run.
 */
const MODE_SHAPE: Record<DeploymentModeToken, SafeValue> = {
  'home-server': safeConstant('single container (home server)'),
  'self-hosted': safeConstant('bundled compose stack'),
  unset: safeConstant('started outside the shipped entrypoints'),
  other: safeConstant('unrecognised MODE, behaves as unset'),
}

const MODE_NOTE: Record<DeploymentModeToken, string> = {
  'home-server':
    'One process holds everything. The durable command port is bound in-process and unconditionally, so no gRPC variable is read in this shape at all and this pane will not recommend one. Redis is not needed for realtime here either: the ticket, lease and socket-budget state a fleet would share has nowhere else it needs to be.',
  'self-hosted':
    'The shipped multi-container compose stack. The gRPC branch IS reachable here, but only when SERVICE_PROXY_TYPE resolves to exactly "grpc" — which the supervisor wrapper now decides for itself, with a reason, reported in the next block.',
  unset:
    'No MODE at all, which is a process started outside the shipped entrypoints — a bare yarn start, or a test harness — rather than an ordinary deployment. Topology-conditional advice is still derived from the other fields, but this is the one shape whose remedies were never exercised on a real deployment.',
  other:
    'MODE is set to something this build does not recognise. The container behaves as if it were unset, and the value itself is refused rather than printed.',
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Absent is not false, held structurally rather than remembered.
 *
 * Every directly-observed row in this file routes through here, so a row cannot
 * claim direct evidence for a field the server never sent. The failure this
 * prevents is a row reading "not reported" with a confident tone behind it,
 * which is the panel asserting it looked when it did not.
 */
/**
 * One variable's presence, THREE-VALUED.
 *
 * `presence[key] === true` is the wrong read and was the first defect this
 * module's own spec caught: a key MISSING from the map is a server that said
 * nothing about that variable, and collapsing it to `false` turns silence into
 * "not set" — a confident negative verdict and a finding with a remedy, over a
 * variable nobody reported. `buildEnvironmentGroups` already gets this right by
 * filtering on `key in presence`; this is the same rule for the four keys this
 * module reads directly.
 *
 * `undefined` therefore means one of two honest things — the topology was not
 * recorded, or this key was not among the ones reported — and both produce "not
 * reported" on absent evidence.
 */
function presenceOf(topology: DeploymentTopology | undefined, key: string): boolean | undefined {
  if (topology?.recorded !== true) {
    return undefined
  }

  const presence = topology.presence
  if (presence === undefined || !(key in presence)) {
    return undefined
  }

  return presence[key] === true
}

function absentOr(observed: unknown, verdict: Verdict): { verdict: Verdict; evidence: Evidence } {
  return observed === undefined || observed === null
    ? { verdict: 'undetermined', evidence: EVIDENCE_ABSENT }
    : { verdict, evidence: EVIDENCE_DIRECT }
}

function observedRow(input: {
  label: SafeValue
  observed: unknown
  value: SafeValue
  verdict: Verdict
  note: string
}): DiagnosticRow {
  return diagnosticRow({
    label: input.label,
    value: input.value,
    ...absentOr(input.observed, input.verdict),
    note: input.note,
  })
}

/**
 * Configuration presence, as the proxy it is.
 *
 * The asymmetry is the whole point, and it is the same one `browserSection.ts`
 * uses for a feature detect: a variable being set is a NECESSARY condition of
 * the requirement being satisfied, so a positive arm's `healthy` claim caps to
 * `undetermined` with the caveat printed, while a negative arm's `broken` claim
 * survives, because a necessary condition failing is conclusive.
 *
 * Written this way rather than as a boolean with a tone precisely so that "set"
 * can never render as "working" — the state that produced a green chip over a
 * socket withholding note syncing.
 */
function presenceProxy(key: string): Evidence {
  return evidenceProxy({
    observed: `that ${key} is set to a non-empty value`,
    cannotConfirm: 'that its value is one this deployment accepts',
    necessaryCondition: true,
  })
}

/* -------------------------------------------------------------------------- */
/* Remedies owned by this module                                              */
/* -------------------------------------------------------------------------- */

/**
 * `restart` is the honest effort for almost everything in this section: these
 * are environment variables, and the container re-reads them on start.
 *
 * Two findings do not fit any member and take the closest one. See
 * `remedyForUnreachableGrpcListener`.
 */
const CONFIG_AND_RESTART: RemedyEffort = 'restart'

function remedyForShortInternalSecret(present: boolean): Remedy {
  return {
    code: 'GRPC_SECRET_TOO_SHORT',
    summary:
      'The internal gRPC auth secret is not usable, so the durable command port never reports ready. Set it to at least 32 bytes, identically on both sides. Restart only — no rebuild.',
    steps: [
      'Set SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET to a strong random value of at least 32 bytes.',
      'Set the SAME value on the syncing server. Two valid secrets that disagree fail exactly like one short secret: the connection succeeds and readiness never arrives.',
      'Below 32 bytes the adapter counts the secret as unconfigured. There is no partial credit, and no log line that names the length.',
      'Restart both containers, then re-read this pane.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      present
        ? 'The variable IS set, and the boot-time lane resolver measured it below the 32-byte minimum. This is the state the stock advice to "configure the secret" reads as already done.'
        : 'The variable is not set, and the boot-time lane resolver recorded that as the reason it declined the gRPC lane.',
      'No length is reported on this screen or in the copyable report, deliberately: the threshold is the diagnostic fact, the length is a fact about a secret.',
    ],
  }
}

/**
 * The findings in this section whose fix is not on this container.
 *
 * `RemedyEffort` has no member for "repair a different service in this
 * deployment". `wait` is the closest and is not a lie — the per-call fallback
 * retries gRPC on every call, so this genuinely clears with no change here the
 * moment the listener answers — but its chip reads "Transient", which understates
 * a listener that is permanently down. The summary says where the action is, so
 * the chip is not the only thing an operator reads.
 */
function remedyForUnreachableGrpcListener(decision: ProxyDecision): Remedy {
  return {
    code: 'GRPC_LISTENER_UNREACHABLE',
    summary:
      'A gRPC listener this gateway dials did not answer, so the lane resolver kept HTTP. Nothing on THIS container fixes it — the action is on the service that should be listening, and it clears by itself once that answers.',
    steps: [
      decision === 'auth-grpc-unreachable'
        ? 'Check that the auth server is up and that its gRPC listener is reachable from the gateway container.'
        : 'Check that the syncing server is up and that its gRPC listener is reachable from the gateway container.',
      'Do not set SERVICE_PROXY_TYPE=grpc by hand to force it. The resolver declined gRPC precisely because the listener did not answer, and forcing it removes the HTTP fallback that is currently carrying every call.',
      'Re-read this pane once the listener answers. The resolver runs again on the next container start, and the per-call fallback recovers without one.',
    ],
    effort: 'wait',
    basis: 'verified',
    because: [
      `The boot-time lane resolver recorded "${decision}", which it sets only after a dial target was configured and the port did not answer.`,
      'HTTP is carrying the calls in the meantime, which is why this presents as latency and a withheld operation rather than as an error.',
    ],
  }
}

function remedyForGrpcServingHttp(): Remedy {
  return {
    code: 'GRPC_BOUND_SERVING_HTTP',
    summary:
      'This gateway bound the gRPC proxy and is serving calls over HTTP anyway. The boot-time topology cannot show this — it was recorded before the listener went away — so these counters are the only place it appears.',
    steps: [
      'Check the gRPC listener on the service named in the lane row: a listener that died after this container started leaves the bound-proxy row reading "grpc" forever.',
      'Read the refused-calls row beside this one. A degraded call was re-delivered over HTTP and then succeeded or failed on its own merits; a REFUSED call failed outright, because a second delivery would have risked duplicating a write.',
      'Nothing here needs a configuration change. If the listener is healthy and the count is historical, restart the gateway to clear the counters and confirm.',
    ],
    effort: 'wait',
    basis: 'verified',
    because: [
      'The topology reports a bound gRPC service proxy and the runtime ledger reports at least one call served over HTTP instead.',
      'Those two facts together are the state that used to be invisible: "HTTP by configuration" and "gRPC healthy" were already distinguishable, and "gRPC bound, HTTP serving" was not.',
    ],
  }
}

function remedyForPartitionedWithoutSecure(): Remedy {
  return {
    code: 'COOKIE_PARTITIONED_WITHOUT_SECURE',
    summary:
      'The session cookie asks for CHIPS partitioning without Secure, which no browser will store. Set COOKIE_SECURE=true, or turn partitioning off. Restart only — no rebuild.',
    steps: [
      'Set COOKIE_SECURE=true and serve the app over HTTPS. This is the right fix on anything that is not a local trial.',
      'For a plain-HTTP trial, set COOKIE_PARTITIONED=false instead. Partitioning is only needed where the app is embedded cross-site.',
      'Do not leave both as they are. The Partitioned attribute REQUIRES Secure, and a browser that sees one without the other drops the whole cookie rather than the one attribute — so sign-in appears to succeed and the session is gone on the next request.',
      'Restart the auth service, then sign in again.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'COOKIE_PARTITIONED resolves to true and COOKIE_SECURE resolves to false on this deployment. Both default to TRUE when unset, so an explicit COOKIE_SECURE=false is what produces this pair.',
      'This exact combination broke the quickstart once: nothing logs an error, because the browser discards the cookie silently and the server only ever sees a request without one.',
    ],
  }
}

function remedyForE2eTestMode(): Remedy {
  return {
    code: 'E2E_TEST_MODE_ENABLED',
    summary:
      'E2E_TESTING is enabled, which forces legacy header sessions for every user on this deployment. Unset it. Restart only — no rebuild.',
    steps: [
      'Unset E2E_TESTING, or set it to anything other than the exact string "true".',
      'Restart the auth service, then sign in again — sessions issued in the legacy mode keep behaving that way until they are reissued.',
      'Read the rest of this pane with that in mind. While this flag is on, the deployment is in a mode where cookie-session faults cannot occur, so a clean bill of health here does not transfer to a deployment without it.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'E2E_TESTING reads "true", which binds FORCE_LEGACY_SESSIONS in the auth container.',
      'This is a test-harness switch. On a real deployment it changes the session mechanism for everyone, and it is the reason a whole e2e suite can be green about cookie sessions it never exercises.',
    ],
  }
}

function remedyForAbsentRequiredConfig(keys: readonly string[]): Remedy {
  return {
    code: 'REQUIRED_CONFIG_ABSENT',
    summary: `${keys.length === 1 ? 'A variable this topology reads is' : `${keys.length} variables this topology reads are`} not set: ${keys.join(', ')}. Restart only — no rebuild.`,
    steps: [
      'Set each variable listed above. Every row in the configuration blocks carries its own note saying which branch of the bootstrap reads it in THIS topology.',
      'Set them where this deployment actually reads them. On the bundled compose stack that is the .env compose forwards, not the container environment directly.',
      'Restart the container, then re-read this pane. A value that arrives after boot is not read: several conditions on this screen distinguish "set now" from "set when the container was configured".',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'The deployment reported its topology, and each of these keys is read on the branch this topology takes.',
      'Presence is all that is known. A variable that IS set may still be wrong, which is why the rows above cap a positive reading rather than calling it healthy.',
    ],
  }
}

function remedyForInertConfig(keys: readonly string[]): Remedy {
  return {
    code: 'CONFIG_SET_BUT_NEVER_READ',
    summary: `${keys.length === 1 ? 'A variable is' : `${keys.length} variables are`} set and never read in this topology: ${keys.join(', ')}. Nothing is broken by it, and it is why a correct-looking configuration can have no effect.`,
    steps: [
      'Read each row above. The note says which switch decides whether that branch runs at all, and that switch is what to change if the variable was meant to be doing something.',
      'Do not set these variables again, or more carefully. They are read by a branch this deployment does not take, so a different value changes nothing.',
      'Remove them, or leave them. They are inert either way; the only cost is that they look configured.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'This is the most expensive failure in this area: a variable that is set, visible in every compose file and printenv, and read by nobody. It is how SYNCING_SERVER_GRPC_URL sat configured on a deployment whose realtime lane was off for days.',
      'The judgement is made against the topology this server reported, not against an assumed one. Without a reported topology no row is marked inert at all.',
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 1: what shape of deployment is this                                  */
/* -------------------------------------------------------------------------- */

function buildShapeBlock(topology: DeploymentTopology | undefined, runtime: EnvironmentRuntimeView): DiagnosticBlock {
  const recorded = topology?.recorded === true
  const mode: DeploymentModeToken | undefined = recorded ? (topology?.mode ?? 'unset') : undefined
  const bindable = recorded ? topology?.grpcProxyBindableInThisMode : undefined
  const switchSetting = recorded ? topology?.syncSwitchSetting : undefined

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Deployment shape'),
      value: mode === undefined ? safeConstant('not reported') : MODE_SHAPE[mode],
      ...absentOr(mode, 'informational'),
      note:
        mode === undefined
          ? 'This server build does not report its topology, so every remedy in this section falls back to generic advice. That is stated rather than hidden: advice chosen against an assumed topology is the confidently wrong answer this pane exists to end.'
          : MODE_NOTE[mode],
    }),
    observedRow({
      label: safeConstant('MODE'),
      observed: mode,
      value: safeEnum(mode, DEPLOYMENT_MODES),
      verdict: 'informational',
      note: 'The raw setting behind the row above, printed because it is what an operator greps their compose file for. An unrecognised value collapses to "other" and is never echoed.',
    }),
    diagnosticRow({
      label: safeConstant('gRPC variables apply here'),
      value: safeYesNo(bindable),
      ...absentOr(bindable, 'informational'),
      note: 'The single field that stops this pane recommending a variable this deployment never reads. On a single container the gRPC construction block is the other branch of the home-server check, so no environment variable reaches it — and the durable command port is bound in-process regardless, which is why nothing is lost by that.',
    }),
    observedRow({
      label: safeConstant('SERVICE_PROXY_TYPE'),
      observed: recorded ? topology?.serviceProxySetting : undefined,
      value: safeEnum(recorded ? topology?.serviceProxySetting : undefined, SERVICE_PROXY_SETTINGS),
      verdict: 'informational',
      note: 'Only the exact string "grpc" selects the gRPC branch. Read it together with the decision row in the next block: since the lane became self-configuring, "unset" here does not mean nobody decided — it means the resolver decided against gRPC and recorded why.',
    }),
    observedRow({
      label: safeConstant('Service proxy in use'),
      observed: recorded ? topology?.boundServiceProxy : undefined,
      value: safeEnum(recorded ? topology?.boundServiceProxy : undefined, BOUND_SERVICE_PROXIES),
      verdict: 'informational',
      note: 'The branch that actually ran when the container was configured, not a re-derivation of the conditions. It is a BOOT-TIME fact and cannot change afterwards, which is exactly why the runtime counters in the next block exist.',
    }),
    observedRow({
      label: safeConstant('CACHE_TYPE'),
      observed: recorded ? topology?.cacheSetting : undefined,
      value: safeEnum(recorded ? topology?.cacheSetting : undefined, CACHE_SETTINGS),
      verdict: 'informational',
      note: '"memory" suppresses the Redis binding entirely, so REDIS_URL is not read while it is set that way. On a single container this is forced to memory on purpose and is not a misconfiguration.',
    }),
    diagnosticRow({
      label: safeConstant('Redis client bound'),
      value: safeYesNo(recorded ? topology?.redisBound : undefined),
      ...absentOr(recorded ? topology?.redisBound : undefined, 'informational'),
      note: 'Whether a Redis client exists in this container. Deliberately informational: "no" is expected and correct on a single container, where the realtime shared state lives in the one process holding the sockets, and it only means something on a multi-replica deployment.',
    }),
    observedRow({
      label: safeConstant('Realtime sync switch'),
      observed: switchSetting,
      value: safeEnum(switchSetting, SYNC_SWITCH_SETTINGS),
      verdict: switchSetting === 'false' ? 'degraded' : 'informational',
      note: 'WEBSOCKET_SYNC_ENABLED. Only the exact string "false" is the kill switch, and it is a deliberate one — someone turned the lane off. Any other non-empty value makes the gateway refuse to start, so it cannot be the cause of a running-but-broken lane. What the socket is actually doing is the WebSocket section\'s to report; this row is the setting only.',
    }),
    diagnosticRow({
      label: safeConstant('Time since this process started'),
      value: safeDuration(runtime.processUptimeSeconds),
      ...absentOr(runtime.processUptimeSeconds, 'informational'),
      note: 'The answer to "I changed the setting and restarted — did it take?", which is the most-asked question in this area and was previously unanswerable from this pane. A duration rather than a start instant: the question is whether the restart happened after the edit, and a duration answers it without putting a clock into a public report.',
    }),
  ]

  return {
    heading: safeConstant('Deployment shape'),
    description:
      'What kind of deployment this is, which decides which remedies even apply. Nothing here is a verdict about whether the deployment works — these rows are the context every other row in this section is read against.',
    rows,
    findings: [],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 2: the durable backend transport, and what it is really doing        */
/* -------------------------------------------------------------------------- */

/** The three states the internal gRPC auth secret is reported as, plus honesty. */
export const GRPC_SECRET_STATES = ['sufficient', 'too-short', 'absent', 'unmeasured'] as const

export type GrpcSecretState = (typeof GRPC_SECRET_STATES)[number]

/**
 * The decisions the lane resolver can only have reached AFTER its length test
 * passed. It probes a listener last, so either `*-grpc-unreachable` code — and
 * `grpc-default` itself — establishes a secret at or above the minimum.
 */
const DECISIONS_PAST_SECRET_CHECK: readonly ProxyDecision[] = [
  'grpc-default',
  'auth-grpc-unreachable',
  'syncing-grpc-unreachable',
]

/**
 * The secret as three states plus an honest fourth — from two closed enums, and
 * never a length.
 *
 * The boot-time lane resolver measures the secret against the 32-byte minimum
 * and records `no-secret` when it falls short. Read together with the presence
 * boolean, that separates two causes which used to share one symptom:
 *
 *   decision `no-secret` + present      -> set, and SHORTER than 32 bytes
 *   decision `no-secret` + not present  -> not set at all
 *   any decision past the length test   -> at least 32 bytes
 *
 * `operator`, `not-colocated` and `no-grpc-urls` all return BEFORE the length
 * test, so on those the length was never measured and `unmeasured` is the only
 * honest answer: presence is then all there is, and it is reported as the proxy
 * it is.
 */
export function describeInternalGrpcSecret(
  decision: ProxyDecision | undefined,
  present: boolean | undefined,
): GrpcSecretState | undefined {
  if (decision === 'no-secret') {
    return present === true ? 'too-short' : 'absent'
  }
  if (decision !== undefined && DECISIONS_PAST_SECRET_CHECK.includes(decision)) {
    return 'sufficient'
  }
  return present === undefined ? undefined : 'unmeasured'
}

const SECRET_LABEL = safeConstant('Internal gRPC auth secret')

const SECRET_SUFFICIENT = safeConstant('at least 32 bytes')

const SECRET_TOO_SHORT = safeConstant('set, shorter than 32 bytes')

const SECRET_ABSENT = safeConstant('not set')

const SECRET_UNMEASURED = safeConstant('(length not established)')

const SECRET_NOTE =
  'Three states, never a length and never the value. A secret below 32 bytes counts as UNCONFIGURED to the durable adapter, which then never reports ready — so a short secret and an absent one have the same consequence and completely different fixes. "At least 32 bytes" is reported as undetermined on purpose: the length passing is necessary and not sufficient, because the gateway and the syncing server must also hold the SAME secret, and two valid secrets that disagree fail exactly like one short one.'

function secretRow(state: GrpcSecretState | undefined, present: boolean | undefined): DiagnosticRow {
  if (state === undefined) {
    return diagnosticRow({
      label: SECRET_LABEL,
      value: safePresence(undefined),
      verdict: 'undetermined',
      evidence: EVIDENCE_ABSENT,
      note: SECRET_NOTE,
    })
  }

  if (state === 'sufficient') {
    return diagnosticRow({
      label: SECRET_LABEL,
      value: SECRET_SUFFICIENT,
      verdict: 'healthy',
      evidence: evidenceProxy({
        observed: 'that the boot-time lane resolver measured the secret at or above the 32-byte minimum',
        cannotConfirm: 'that the gateway and the syncing server hold the same secret',
        necessaryCondition: true,
      }),
      note: SECRET_NOTE,
    })
  }

  if (state === 'unmeasured') {
    return diagnosticRow({
      label: SECRET_LABEL,
      value: safeTokens(safePresence(present), SECRET_UNMEASURED),
      verdict: present === true ? 'healthy' : 'broken',
      evidence: presenceProxy('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET'),
      note: `${SECRET_NOTE} The boot-time lane resolver returned before it reached the length test on this deployment, so presence is all that was observed.`,
    })
  }

  return diagnosticRow({
    label: SECRET_LABEL,
    value: state === 'too-short' ? SECRET_TOO_SHORT : SECRET_ABSENT,
    verdict: 'broken',
    evidence: EVIDENCE_DIRECT,
    note: SECRET_NOTE,
  })
}

/** The three states `boundServiceProxy` and the runtime ledger separate together. */
export const GRPC_HEALTH_STATES = [
  'http-by-configuration',
  'in-process-direct-call',
  'grpc-no-fallback-recorded',
  'grpc-serving-http',
] as const

export type GrpcHealthState = (typeof GRPC_HEALTH_STATES)[number]

const GRPC_HEALTH_VALUE: Record<GrpcHealthState, SafeValue> = {
  'http-by-configuration': safeConstant('HTTP by configuration'),
  'in-process-direct-call': safeConstant('in-process, no transport'),
  'grpc-no-fallback-recorded': safeConstant('gRPC, no fallback recorded'),
  'grpc-serving-http': safeConstant('gRPC bound, HTTP serving'),
}

const GRPC_HEALTH_NOTE =
  'The row the boot-time topology could not produce. "Service proxy in use" is recorded once, when the container is configured, so a gRPC listener that dies afterwards leaves it reading "grpc" forever while every call is served over HTTP. Read with the per-call counters below, three states separate where there used to be two — and "no fallback recorded" is reported as undetermined because an idle gateway reads identically to a healthy one.'

type LaneTotals = {
  degraded: number | undefined
  refused: number | undefined
  lastClass: string | undefined
  lastLane: GrpcFallbackLane | undefined
  lastAgeSeconds: number | undefined
}

const NO_TOTALS: LaneTotals = {
  degraded: undefined,
  refused: undefined,
  lastClass: undefined,
  lastLane: undefined,
  lastAgeSeconds: undefined,
}

/**
 * Sum the lanes, and keep the most recent failure's lane and class.
 *
 * "Most recent" is the SMALLEST age: these are durations since the failure, not
 * instants, so the freshest one has the least elapsed time behind it. Getting
 * that comparison the wrong way round would attribute a live outage to whichever
 * lane last failed longest ago.
 *
 * A fallback block with no lane in it at all returns every field undefined
 * rather than zero, because a zero would claim direct evidence of no
 * degradations from a payload that reported nothing.
 */
function laneTotals(fallback: TransportFallbackView | undefined): LaneTotals {
  if (fallback === undefined) {
    return NO_TOTALS
  }

  let seen = false
  let degraded = 0
  let refused = 0
  let lastClass: string | undefined
  let lastLane: GrpcFallbackLane | undefined
  let lastAgeMs: number | undefined

  for (const lane of GRPC_FALLBACK_LANES) {
    const view = fallback.lanes?.[lane]
    if (view === undefined || view === null) {
      continue
    }
    seen = true
    degraded += typeof view.degradedCalls === 'number' && view.degradedCalls >= 0 ? view.degradedCalls : 0
    refused += typeof view.refusedCalls === 'number' && view.refusedCalls >= 0 ? view.refusedCalls : 0

    const age =
      typeof view.lastFailureAgeMs === 'number' && Number.isFinite(view.lastFailureAgeMs) && view.lastFailureAgeMs >= 0
        ? view.lastFailureAgeMs
        : undefined
    if (age !== undefined && (lastAgeMs === undefined || age < lastAgeMs)) {
      lastAgeMs = age
      lastLane = lane
      lastClass = typeof view.lastFailureClass === 'string' ? view.lastFailureClass : undefined
    }
  }

  if (!seen) {
    return NO_TOTALS
  }

  return {
    degraded,
    refused,
    lastClass,
    lastLane,
    lastAgeSeconds: lastAgeMs === undefined ? undefined : lastAgeMs / 1000,
  }
}

function buildTransportBlock(
  topology: DeploymentTopology | undefined,
  runtime: EnvironmentRuntimeView,
  fallback: TransportFallbackView | undefined,
): DiagnosticBlock {
  const recorded = topology?.recorded === true
  const decision = PROXY_DECISIONS.find((candidate) => candidate === runtime.serviceProxyDecision)
  const bound = recorded ? topology?.boundServiceProxy : undefined
  const secretPresent = presenceOf(topology, 'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
  const secret = describeInternalGrpcSecret(decision, secretPresent)
  const totals = laneTotals(fallback)
  const unreachable = decision === 'auth-grpc-unreachable' || decision === 'syncing-grpc-unreachable'

  const health: GrpcHealthState | undefined =
    bound === 'http'
      ? 'http-by-configuration'
      : bound === 'direct-call'
        ? 'in-process-direct-call'
        : bound === 'grpc' && fallback !== undefined
          ? fallback.everDegraded === true
            ? 'grpc-serving-http'
            : 'grpc-no-fallback-recorded'
          : undefined

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Why this transport was chosen'),
      value: safeEnum(runtime.serviceProxyDecision, PROXY_DECISIONS),
      ...absentOr(runtime.serviceProxyDecision, decision === 'no-secret' || unreachable ? 'degraded' : 'informational'),
      note: 'The self-configuring lane records WHICH condition declined gRPC, and that reason is the difference between a deployment where HTTP is correct ("not-colocated": there is no co-located syncing server to speak gRPC to) and one where something is wrong ("syncing-grpc-unreachable": a dial target was configured and the port did not answer). When this is not reported the honest answer is that the reason is undetermined — not that the variable was simply unset.',
    }),
    secretRow(secret, secretPresent),
    diagnosticRow({
      label: safeConstant('gRPC transport health'),
      value: health === undefined ? safePresence(undefined) : GRPC_HEALTH_VALUE[health],
      verdict:
        health === 'grpc-serving-http'
          ? 'degraded'
          : health === 'grpc-no-fallback-recorded'
            ? 'healthy'
            : 'informational',
      evidence:
        health === undefined
          ? EVIDENCE_ABSENT
          : health === 'grpc-no-fallback-recorded'
            ? evidenceProxy({
                observed: 'that no gRPC call has fallen back to HTTP since this process started',
                cannotConfirm: 'that the gRPC lane is carrying calls at all',
                necessaryCondition: true,
              })
            : EVIDENCE_DIRECT,
      note: GRPC_HEALTH_NOTE,
    }),
    diagnosticRow({
      label: safeConstant('Calls served over HTTP instead of gRPC'),
      value: safeCount(totals.degraded),
      ...absentOr(totals.degraded, totals.degraded !== undefined && totals.degraded > 0 ? 'degraded' : 'informational'),
      note: "A gRPC attempt failed in a replay-safe way and the HTTP transport took the call. The request itself was served; what is lost is the operator's belief that they are on gRPC. A count of zero is informational rather than healthy, because an idle gateway produces the same zero.",
    }),
    diagnosticRow({
      label: safeConstant('Calls refused rather than retried'),
      value: safeCount(totals.refused),
      ...absentOr(totals.refused, totals.refused !== undefined && totals.refused > 0 ? 'degraded' : 'informational'),
      note: 'A gRPC attempt failed and a second delivery over HTTP would not have been safe — a write with nothing to deduplicate it against, on a failure class that cannot prove the write was not already applied. These requests FAILED, and that is the intended outcome: a duplicated write materialises as a conflicted-copy note, which is worse than an error the client retries. The number is here so that a degradation count cannot be read as the gateway having absorbed an outage.',
    }),
    diagnosticRow({
      label: safeConstant('Most recent gRPC failure'),
      value: safeEnum(totals.lastClass, GRPC_FAILURE_CLASSES),
      ...absentOr(totals.lastClass, 'informational'),
      note: '"channel-unavailable" is the listener being gone, and is the usual reading. "method-unimplemented" means the two sides disagree about the protocol, which no restart fixes. "application" means the backend deliberately answered that way, and no transport change helps.',
    }),
    diagnosticRow({
      label: safeConstant('Lane of the most recent gRPC failure'),
      value: safeEnum(totals.lastLane, GRPC_FALLBACK_LANES),
      ...absentOr(totals.lastLane, 'informational'),
      note: 'Which call path failed. "session-validation" degrades every authenticated request on this gateway; "items-sync" degrades note syncing only. They are kept apart because the first is a whole-deployment symptom and the second is not.',
    }),
    diagnosticRow({
      label: safeConstant('Time since the last gRPC failure'),
      value: safeDuration(totals.lastAgeSeconds),
      ...absentOr(totals.lastAgeSeconds, 'informational'),
      note: 'How long ago, not when. A failure ten seconds old is a live outage; one that happened hours ago and has not recurred is history — and the counters beside it do not reset on their own.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (secret === 'too-short' || secret === 'absent') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('GRPC_SECRET_TOO_SHORT'),
        title:
          secret === 'too-short'
            ? 'The internal gRPC auth secret is shorter than the minimum'
            : 'The internal gRPC auth secret is not set',
        detail:
          "The durable command port counts a secret below 32 bytes as unconfigured and never reports ready, so note syncing is withheld while the socket stays up and carries everything else. This is a configuration fact; what the socket is actually advertising is the WebSocket section's to report, and is not restated here.",
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForShortInternalSecret(secret === 'too-short'),
      }),
    )
  }

  if (unreachable && decision !== undefined) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('GRPC_LISTENER_UNREACHABLE'),
        title: 'A gRPC listener this gateway dials did not answer',
        detail:
          'The lane resolver probed the configured dial target at boot, got no answer, and kept HTTP rather than selecting a transport with no fallback. That is the correct behaviour, and it is also the reason the gRPC variables on this deployment look configured and do nothing.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForUnreachableGrpcListener(decision),
      }),
    )
  }

  if (health === 'grpc-serving-http') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('GRPC_BOUND_SERVING_HTTP'),
        title: 'This gateway bound gRPC and is serving over HTTP',
        detail:
          'At least one call has fallen back. The boot-time topology still reports a bound gRPC proxy — correctly, because that is what happened at boot — so this state is invisible everywhere except these counters.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForGrpcServingHttp(),
      }),
    )
  }

  if (totals.refused !== undefined && totals.refused > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('GRPC_CALLS_REFUSED'),
        title: 'Calls failed rather than being retried on HTTP',
        detail:
          'A second delivery of these calls could have duplicated a write, so the gateway surfaced the failure instead of absorbing it. The requests failed and the clients saw errors. This is the intended trade and it must stay visible, because a degradation count on its own reads as an outage that was handled.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForGrpcServingHttp(),
      }),
    )
  }

  return {
    heading: safeConstant('Durable backend transport'),
    description:
      'How this gateway reaches the durable backend, why that transport was chosen, and whether it is actually being used. The boot-time branch and the runtime counters are both here on purpose: either one alone has been read as healthy over a deployment that was not.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 3: how sessions are held                                             */
/* -------------------------------------------------------------------------- */

function buildSessionBlock(topology: DeploymentTopology | undefined, runtime: EnvironmentRuntimeView): DiagnosticBlock {
  const jwtSecret = presenceOf(topology, 'AUTH_JWT_SECRET')
  const partitionedWithoutSecure = runtime.cookiePartitioned === true && runtime.cookieSecure === false

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Cookie Secure flag'),
      value: safeState(runtime.cookieSecure, 'on', 'off'),
      ...absentOr(runtime.cookieSecure, runtime.cookieSecure === false ? 'degraded' : 'informational'),
      note: 'The EFFECTIVE value, not whether the variable is set: COOKIE_SECURE defaults to true when unset, so "not set" and "off" are opposite answers and a presence boolean would invert the diagnosis. Off is legitimate on a plain-HTTP local trial and wrong on anything reachable from elsewhere.',
    }),
    diagnosticRow({
      label: safeConstant('Cookie Partitioned flag'),
      value: safeState(runtime.cookiePartitioned, 'on', 'off'),
      ...absentOr(runtime.cookiePartitioned, partitionedWithoutSecure ? 'broken' : 'informational'),
      note: 'CHIPS partitioning, which also defaults to true when unset. The Partitioned attribute REQUIRES Secure: a browser that sees one without the other drops the whole cookie rather than the one attribute, so the session is silently never stored. Nothing logs an error on either side, which is how this broke the quickstart once.',
    }),
    diagnosticRow({
      label: safeConstant('End-to-end test mode'),
      value: safeYesNo(runtime.e2eTesting),
      ...absentOr(runtime.e2eTesting, runtime.e2eTesting === true ? 'broken' : 'healthy'),
      note: 'E2E_TESTING forces legacy HEADER sessions for every user on this deployment. A real deployment running with it on is in a mode where cookie-session faults cannot occur — which is worth knowing twice over, because it also means a green end-to-end suite proves nothing about cookie sessions.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (partitionedWithoutSecure) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('COOKIE_PARTITIONED_WITHOUT_SECURE'),
        title: 'The session cookie asks for Partitioned without Secure',
        detail:
          'No browser will store this cookie. Sign-in appears to succeed and the very next request arrives without a session, with nothing logged anywhere — the browser discards the cookie, and the server only ever sees a request that does not carry one.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForPartitionedWithoutSecure(),
      }),
    )
  }

  if (runtime.e2eTesting === true) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('E2E_TEST_MODE_ENABLED'),
        title: 'This deployment is running in end-to-end test mode',
        detail:
          'E2E_TESTING binds FORCE_LEGACY_SESSIONS, so every session on this deployment is a legacy header session rather than a cookie one. That is a different authentication mechanism from the one this fork ships, and it is almost certainly not what was intended on a deployment real enough to be reading this pane.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForE2eTestMode(),
      }),
    )
  }

  if (jwtSecret === false) {
    const remedy = remedyForLiveReason('authorization-adapter-unavailable', topology)
    findings.push(
      diagnosticFinding({
        code: safeConstant('SESSION_SIGNING_KEY_ABSENT'),
        title: 'AUTH_JWT_SECRET is not set',
        detail:
          'This is the second configuration cause of a socket that refuses everything, and the one that had no name on this screen until now: every socket command revalidates the original session token before it runs, so an empty AUTH_JWT_SECRET closes the lane outright rather than withholding one operation. It is a different variable from the internal gRPC secret above and from the connection-token secret, with a different consequence and the shortest fix of the three.',
        verdict: 'broken',
        evidence: presenceProxy('AUTH_JWT_SECRET'),
        ...(remedy === undefined ? {} : { remedy }),
      }),
    )
  }

  return {
    heading: safeConstant('Sessions and cookies'),
    description:
      'How a signed-in session is held, which is where a deployment that looks perfect fails at the last step. The two cookie flags are reported as effective values rather than as presence, because both default to ON and a presence reading of them would be backwards.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 4: which build is live                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `UNSTAMPED_DEPLOYMENT_SENTINEL` in the server's `DeploymentIdentity`
 * and the `revision='unstamped'` default in all three Dockerfiles. Declared here
 * rather than imported because this package does not depend on the server one;
 * if the two ever drift, the state below falls back to "no identity", which is
 * the conservative direction — never a false "published".
 */
const UNSTAMPED_SENTINEL = 'unstamped'

export const IDENTITY_STATES = ['published', 'unstamped-marker', 'no-identity', 'malformed-marker'] as const

export type IdentityState = (typeof IDENTITY_STATES)[number]

const IDENTITY_VALUE: Record<IdentityState, SafeValue> = {
  published: safeConstant('published'),
  'unstamped-marker': safeConstant('explicitly unstamped'),
  'no-identity': safeConstant('no identity published'),
  'malformed-marker': safeConstant('marker in an unrecognised format'),
}

/**
 * Which of four states the deployment marker is in.
 *
 * `describeDeployment` is reused for the sentinel and redaction handling, and
 * its `unstamped` boolean is then split further: a revision that survives it but
 * does not match the 40-lowercase-hex shape `app/Dockerfile` itself validates is
 * a MALFORMED marker, not a published identity. That check uses the same
 * `DEPLOY_REVISION` pattern the copyable report admits the literal revision
 * with, so the two cannot disagree about what counts as published.
 */
export function describeIdentityState(marker: unknown): IdentityState {
  const view = describeDeployment(marker)
  if (view.unstamped) {
    return view.revision === UNSTAMPED_SENTINEL ? 'unstamped-marker' : 'no-identity'
  }

  return DEPLOY_REVISION.test(view.revision) ? 'published' : 'malformed-marker'
}

/**
 * *** THE DEFECT THIS BLOCK MUST NOT MISREPRESENT ***
 *
 * "Unstamped" currently wears one label over two different causes:
 *
 *   (a) no revision was passed at build time, so the Dockerfiles baked the
 *       `unstamped` sentinel; and
 *   (b) a revision WAS passed, but `SRN_DEPLOY_VERSION` was empty — the build
 *       derives `src-<first 12 of revision>` into the marker while the runtime
 *       read an absent variable as null, the two disagreed on
 *       `marker.version !== version`, and the whole identity was discarded as
 *       `{ null, null }`.
 *
 * Cause (b) is why this app's own advice has been able to reproduce the symptom:
 * rebuilding with `--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)` and
 * nothing else is exactly the single-argument invocation that lands there.
 *
 * This panel CANNOT tell the two apart. What it reads is the VERIFIED identity,
 * which is `{ null, null }` in both cases, and the presence of
 * `SRN_DEPLOY_REVISION` in the runtime environment does not settle it either —
 * setting that variable on a running container never stamps an image, so a
 * present variable is consistent both with an unstamped image and with a stamped
 * one whose version comparison was rejected. So the finding names both causes,
 * reports which runtime variables were present as the only evidence it has, and
 * claims neither. The cause is a `correlated` proxy and the claim caps to
 * `undetermined` accordingly; the ROW above it keeps its `degraded` verdict on
 * direct evidence, because "no identity is published" is a fact this panel did
 * observe.
 */
function buildIdentityBlock(topology: DeploymentTopology | undefined, marker: unknown): DiagnosticBlock {
  const state = marker === undefined ? undefined : describeIdentityState(marker)
  const revisionVariable = presenceOf(topology, 'SRN_DEPLOY_REVISION')
  const versionVariable = presenceOf(topology, 'SRN_DEPLOY_VERSION')

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Deployment identity'),
      value: state === undefined ? safePresence(undefined) : IDENTITY_VALUE[state],
      ...absentOr(state, state === 'published' ? 'healthy' : 'degraded'),
      note: 'Whether the running build can say which commit it is. "Published" means the runtime values and the marker baked into the image agreed; anything else means "is the running build current?" cannot be answered from here, which is the first question of every incident. The revision and version themselves are printed in the copyable report under its own Deployment heading, admitted there by shape — they are not repeated as rows, because a git revision is not one of the categories a row value may hold.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (state !== undefined && state !== 'published') {
    const revisionEvidence =
      revisionVariable === true
        ? "SRN_DEPLOY_REVISION IS set in this container's environment, which is consistent with both causes: setting it on a running container never stamps an image, so it neither confirms nor rules out the second."
        : revisionVariable === false
          ? "SRN_DEPLOY_REVISION is not set in this container's environment, which again settles nothing — the stamp lives in the image, not in the environment."
          : 'Nothing was reported about the runtime variables, so there is no evidence here either way.'
    const versionEvidence =
      versionVariable === false
        ? ' SRN_DEPLOY_VERSION is not set, which is the state the second cause requires — and also the ordinary state of a correctly built image, because the build derives the version when it is not given one.'
        : ''

    findings.push(
      diagnosticFinding({
        code: safeConstant('DEPLOYMENT_UNSTAMPED'),
        title: 'This deployment publishes no usable build identity',
        detail: `Two different causes produce this and this panel cannot tell them apart: the image may have been built with no revision at all, or a revision may have been supplied while SRN_DEPLOY_VERSION was empty — in which case the build baked a derived version, the runtime computed none, the two disagreed, and the entire identity was discarded. ${revisionEvidence}${versionEvidence} Treat the rebuild instruction below as necessary rather than sufficient: if a revision was already being passed, pass the version too, or confirm the running server derives it.`,
        verdict: 'degraded',
        evidence: evidenceProxy({
          observed: 'that this server publishes no verified deployment identity',
          cannotConfirm: 'which of the two causes of an unstamped identity applies here',
          necessaryCondition: false,
        }),
        remedy: remedyForUnstampedDeployment(),
      }),
    )
  }

  return {
    heading: safeConstant('Deployment identity'),
    description:
      'Which build is actually live. Moved here from the Overview, where it was a header line with no remedy beside it and no room to say that its one piece of advice has a trap in it.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Blocks 5+: configuration presence, from the existing classifier            */
/* -------------------------------------------------------------------------- */

/**
 * The block heading for each group `buildEnvironmentGroups` can produce.
 *
 * A lookup rather than a derivation, because a `SafeValue` heading must be a
 * literal of THIS build and `EnvironmentGroup.title` is a plain `string` — true
 * of every title's value over there, and not of its type, which is exactly the
 * distinction `safeConstant` enforces. The group's own title and description are
 * still printed verbatim in the block description, so a group added over there
 * loses nothing but its heading.
 *
 * `Deployment identity` is renamed here: the block above already owns that
 * heading, and two blocks with one heading is how a report line stops naming
 * which block it came from.
 */
const GROUP_HEADING: Readonly<Partial<Record<string, SafeValue>>> = {
  'Realtime transport': safeConstant('Realtime transport'),
  'Shared state': safeConstant('Shared state'),
  'Durable backend': safeConstant('Durable backend configuration'),
  'Files lane': safeConstant('Files lane'),
  'Event fan-out': safeConstant('Event fan-out'),
  'Deployment identity': safeConstant('Deployment identity variables'),
  'Reported by a newer server': safeConstant('Reported by a newer server'),
}

const GROUP_HEADING_FALLBACK = safeConstant('Other configuration')

/**
 * One row from `buildEnvironmentGroups`, as a contract row.
 *
 * Nothing is re-judged here. The key, the presence boolean, the relevance and
 * the note all come from that module; this function's whole job is to turn a
 * relevance into a verdict and an evidence kind, which is the part the section
 * contract adds and the part `EnvironmentRow.tone` cannot express — a tone
 * cannot say that a positive reading rests on a necessary condition and is
 * therefore not a claim that the thing works.
 */
function configRow(row: EnvironmentRow): DiagnosticRow {
  const label = safeEnvName(row.key)
  const value = safeTokens(safePresence(row.present), RELEVANCE_SUFFIX[row.relevance])

  if (row.relevance === 'required') {
    return diagnosticRow({
      label,
      value,
      verdict: row.present ? 'healthy' : 'broken',
      evidence: presenceProxy(row.key),
      note:
        row.note ||
        'Read on the branch this topology takes. Presence is all that is known, which is why a positive reading is reported as undetermined rather than as healthy.',
    })
  }

  if (row.relevance === 'inert') {
    return diagnosticRow({
      label,
      value,
      verdict: row.present ? 'degraded' : 'informational',
      evidence: EVIDENCE_DIRECT,
      note:
        row.note ||
        'Not read in this topology. Set and inert is the state worth flagging — the operator believes it is doing something. Unset and inert is simply correct.',
    })
  }

  if (row.relevance === 'optional') {
    return diagnosticRow({
      label,
      value,
      verdict: 'informational',
      evidence: EVIDENCE_DIRECT,
      note: row.note || 'Absence is a supported configuration here, so this row carries no verdict either way.',
    })
  }

  return diagnosticRow({
    label,
    value,
    verdict: 'informational',
    evidence: EVIDENCE_DIRECT,
    note:
      row.note ||
      "The variable's presence was reported; whether this topology reads it was not, because the topology itself was not reported. No claim is made about whether it matters.",
  })
}

function configBlocks(groups: readonly EnvironmentGroup[]): DiagnosticBlock[] {
  return groups.map((group) => ({
    heading: GROUP_HEADING[group.title] ?? GROUP_HEADING_FALLBACK,
    description: `${group.title} — ${group.description}`,
    rows: group.rows.map(configRow),
    findings: [],
  }))
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

const REPORT_NO_VALUES = reportLine(
  safeConstant('Configured values'),
  safeConstant('never collected; this section carries names, booleans and closed codes only'),
)

const REPORT_SECRET_LENGTHS = reportLine(
  safeConstant('Secret lengths'),
  safeConstant('never reported; a secret appears as a threshold state only'),
)

const REPORT_REVISION = reportLine(
  safeConstant('Build revision and version'),
  safeConstant('reported under the Deployment heading of this report, admitted by shape'),
)

/**
 * Build the Environment & setup section.
 *
 * Pure and synchronous. Every input is optional, and every absent input produces
 * rows reading "not reported" on absent evidence rather than a negative verdict,
 * which is the contract's third rule holding by construction rather than by
 * remembering to write it.
 */
export function buildEnvironmentSection(input: EnvironmentSectionInput = {}): SectionModel {
  const runtime = input.runtime ?? {}
  const outcomes = outcomesForSection(input.outcomes ?? [], 'environment')

  const groups = buildEnvironmentGroups(input.topology)
  const configured = configBlocks(groups)

  const blocks: DiagnosticBlock[] = [
    buildShapeBlock(input.topology, runtime),
    buildTransportBlock(input.topology, runtime, input.fallback),
    buildSessionBlock(input.topology, runtime),
    buildIdentityBlock(input.topology, input.deploymentMarker),
  ]

  if (configured.length === 0) {
    blocks.push({
      heading: safeConstant('Configuration presence'),
      description:
        'Which variables are set, and which of them this topology actually reads. Nothing was reported for this deployment.',
      rows: [],
      findings: [],
      emptyNote:
        'This server build reports no configuration presence at all, so no variable can be marked required, optional or inert. Upgrade to a build that reports its deployment block; until then the blocks above are all that is knowable.',
    })
  } else {
    blocks.push(...configured)

    const absentRequired = groups.flatMap((group) =>
      group.rows.filter((row) => row.relevance === 'required' && !row.present).map((row) => row.key),
    )
    const inertAndSet = groups.flatMap((group) =>
      group.rows.filter((row) => row.relevance === 'inert' && row.present).map((row) => row.key),
    )

    const verdictFindings: DiagnosticFinding[] = []

    if (absentRequired.length > 0) {
      verdictFindings.push(
        diagnosticFinding({
          code: safeConstant('REQUIRED_CONFIG_ABSENT'),
          title: 'Variables this topology reads are not set',
          detail:
            'Each of these is read on the branch this deployment actually takes, so each is a real gap rather than an unused option. The rows above name them and say what reads them.',
          verdict: 'broken',
          evidence: evidenceProxy({
            observed: 'that these variables are not set to a non-empty value',
            cannotConfirm: 'which subsystem fails first as a result',
            necessaryCondition: true,
          }),
          remedy: remedyForAbsentRequiredConfig(absentRequired),
        }),
      )
    }

    if (inertAndSet.length > 0) {
      verdictFindings.push(
        diagnosticFinding({
          code: safeConstant('CONFIG_SET_BUT_NEVER_READ'),
          title: 'Variables are set that this topology never reads',
          detail:
            'Dead configuration. Nothing is broken by it directly, and it is the reason a deployment can look correctly configured and behave as if it were not: the switch that decides whether the branch runs at all is a different variable from the one that was set.',
          verdict: 'degraded',
          evidence: EVIDENCE_DIRECT,
          remedy: remedyForInertConfig(inertAndSet),
        }),
      )
    }

    if (verdictFindings.length > 0) {
      blocks.push({
        heading: safeConstant('Configuration verdict'),
        description:
          'What the presence rows above add up to, so the two states worth acting on are not left for the reader to spot across six groups.',
        rows: [],
        findings: verdictFindings,
      })
    }
  }

  // Appended last and OUTSIDE the branch above: a probe result tagged for this
  // section must survive a server that reported no configuration presence at
  // all, which is exactly the deployment most likely to have run one.
  if (outcomes.length > 0) {
    blocks.push({
      heading: safeConstant('Operator-triggered checks'),
      description:
        'Results from the last run on the Checks sub-tab. Read-only here: a run is started in exactly one place, so the paragraph explaining what it does to your own account appears exactly once.',
      rows: [],
      findings: [],
      outcomes,
    })
  }

  return buildSectionModel({
    id: 'environment',
    blocks,
    extraReportLines: [REPORT_NO_VALUES, REPORT_SECRET_LENGTHS, REPORT_REVISION],
  })
}
