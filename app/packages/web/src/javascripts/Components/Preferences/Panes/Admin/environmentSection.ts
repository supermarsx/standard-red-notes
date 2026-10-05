import {
  buildEnvironmentPresence,
  type EnvironmentGroup,
  type EnvironmentPresence,
  type EnvironmentRelevance,
  type EnvironmentRow,
  type KnownEnvKey,
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
  NOT_PUBLISHED,
  outcomesForSection,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safeEnvName,
  safePresence,
  safeState,
  safeToken,
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
import { describeDeployment, type DeploymentIdentityView, type TransportFallbackView } from './syncDiagnostics'

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
 * `buildEnvironmentPresence` is called, its groups become blocks, its keys become
 * labels, its relevance becomes part of each value and its notes are printed
 * verbatim. Nothing in it is reimplemented here, and this module makes no
 * per-variable relevance judgement of its own.
 *
 * Its `unrecognised` count becomes a row of its own, for the same reason the
 * Capabilities count exists: a key in the presence map is chosen by the SERVER,
 * so it is server-controlled text, and this section used to label a row with one
 * — admitted by SHAPE, which let an upper-snake-case key off the wire through
 * while refusing the rest. Only a `KnownEnvKey` reaches a label now, and the
 * ones this build has no name for are counted. Nothing is dropped silently.
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
 * and the documentation, and every one printed here is a literal of this build —
 * `KnownEnvKey` — with `safeEnvName` left under it as a shape floor. Nothing else
 * from the configuration reaches a row. In particular the internal gRPC auth
 * secret is reported as one of four closed states and never as a length: a
 * length is a fact about a secret, and the report this feeds is written to be
 * pasted in public. The threshold wording ("at least 32 bytes", "shorter than 32
 * bytes") is a constant of this build, derived from two closed enums. The same
 * secret's ORIGIN is a second row and the same discipline: a closed state token
 * saying whether it was supplied, persisted, minted or never prepared — never a
 * value, never a length, and never the path it was persisted to.
 *
 * The deployment REVISION is the one server-supplied value this section prints,
 * and it is printed through `safeToken` against `DEPLOY_REVISION` — the same
 * anchored shape `app/Dockerfile` validates and the same one `admitToken` already
 * admitted it with in both copyable reports. It used to be absent from this
 * section entirely, which was a limit of the contract rather than a secrecy
 * decision: a 40-character git revision is none of the other permitted
 * categories, so printing it would have taken the banned cast, and the row
 * reported the identity's STATE while its note sent the reader to the report for
 * the revision itself. One rule now serves both. A revision that does not match
 * the shape is WITHHELD and never echoed, so a marker served by whatever fronts
 * the web bundle cannot put arbitrary bytes on this screen. The VERSION stays
 * report-only: `VERSION_TOKEN` admits a far broader shape, and it answers no
 * question this section carries a verdict about.
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

/**
 * The vocabulary the DECISION ROW renders through, which is the seven outcomes
 * above plus the server's two sentinels.
 *
 * `PROXY_DECISIONS` is the set of decisions the resolver can REACH, and that is
 * what the secret-threshold derivation and the unreachable-listener finding read.
 * The server's `ServiceProxyDecision` union is wider by exactly two members, and
 * both have to be renderable or they would collapse to "other (unrecognised)" —
 * the defect `SERVICE_PROXY_SETTINGS` already had once, where `auto` (the value
 * the setup script WRITES by default) was reported to its operator as a typo.
 *
 * `unset` means NO LAUNCHER RECORDED A DECISION: an image older than the export
 * that made the variable visible to a child process, or a gateway started outside
 * `supervisor-server.sh` — a bare `yarn start`, the standalone harness. That is
 * not the same fact as "the reason could not be determined", and the row must not
 * render it as one.
 *
 * `other` is the SERVER's own collapse of a token it did not recognise either. It
 * is rendered as itself rather than as this build's collapse constant, because
 * the two say different things: one is a client that is behind, the other is a
 * launcher that recorded something its own gateway could not name.
 */
export const SERVICE_PROXY_DECISIONS = [
  'operator',
  'grpc-default',
  'not-colocated',
  'no-grpc-urls',
  'no-secret',
  'auth-grpc-unreachable',
  'syncing-grpc-unreachable',
  'unset',
  'other',
] as const

/**
 * How the durable-command secret the socket SYNC_ITEMS lane needs CAME TO BE, as
 * the server's `InternalGrpcSecretState` — a state token, never the secret and
 * never its length.
 *
 * This is a different question from the 32-byte threshold below and answers
 * something the threshold cannot. `minted-ephemeral` and `mint-failed` are
 * silently fatal to the lane and look exactly like a working deployment from
 * outside; `persisted` versus `supplied` is the difference between a value living
 * on a volume and one the operator can rotate in their own `.env`.
 *
 * Both sentinels mean what they mean above: `unset` is no launcher, `other` is a
 * token the launcher recorded and the gateway could not name.
 */
export const INTERNAL_GRPC_SECRET_STATES = [
  'supplied',
  'persisted',
  'minted-persisted',
  'minted-ephemeral',
  'not-colocated',
  'mint-failed',
  'unset',
  'other',
] as const

export type InternalGrpcSecretOrigin = (typeof INTERNAL_GRPC_SECRET_STATES)[number]

/**
 * Every resolver outcome is renderable by the row's own vocabulary.
 *
 * `Uncovered` is `never` when `SERVICE_PROXY_DECISIONS` still covers
 * `PROXY_DECISIONS`, so a decision added to the logic half and forgotten in the
 * rendering half is a type error here rather than a row that reads
 * "unrecognised" on a deployment whose launcher is working perfectly.
 */
export type EveryProxyDecisionIsNamed = AssertNever<Exclude<ProxyDecision, (typeof SERVICE_PROXY_DECISIONS)[number]>>

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
 * The runtime fallback ledger, re-exported from the module that owns the wire
 * shape.
 *
 * It was declared HERE while `SyncDiagnosticsPayload` had no field for it: the
 * server has been sending `transportFallback` since the per-lane counters landed,
 * this build's payload type did not say so, and every row below therefore read
 * "not reported" on a deployment that was reporting. The declaration now lives
 * beside the rest of the payload in `syncDiagnostics.ts`, mirrored from the
 * server's `GrpcTransportFallbackReport`, so the type this section reads and the
 * type the fetch is cast to are the same type and cannot drift apart. The names
 * stay exported from here because this section is their only consumer.
 */
export type { TransportFallbackLaneView, TransportFallbackView } from './syncDiagnostics'

/**
 * The facts this section needs that the topology block cannot carry.
 *
 * All optional, all closed-category, and all absent on a server that does not
 * report them yet.
 *
 * *** THE LANE DECISION USED TO LIVE HERE, AND IT HAS A PRODUCER NOW. ***
 * `serviceProxyDecision` was declared on this view while nothing emitted it. It
 * is emitted today, on the DEPLOYMENT block — `SRN_SERVICE_PROXY_TYPE_DECISION`
 * was being recorded by the launcher and never exported, so no child process
 * including the gateway could see it; both halves are fixed and
 * `DeploymentDiagnostics` reads it into a closed union. So it is read off
 * `DeploymentTopology` with the rest of the topology rather than from here. Two
 * places to read one fact from is how a row comes to disagree with itself, and
 * the honest spelling of "this arrives with the topology" is to read it there.
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

/**
 * The five topology vocabularies, as tuples `safeEnum` can admit — and, below,
 * as a compile-time claim that each tuple still COVERS the field it is read on.
 *
 * A list here is not a judgement about which settings are *correct*; it is the
 * set of readings this build can name. A value the server can emit and the
 * tuple omits renders as "other (unrecognised)", and on an informational row
 * that is the panel telling an operator their deliberate setting is a typo.
 * `SERVICE_PROXY_TYPE` did exactly that: it admitted only `grpc`, so `http` (an
 * explicit pin to the HTTP proxies) and `auto` (the value `scripts/setup.sh`
 * and `.env.example` WRITE by default, so the most common reading in the fleet)
 * both read as unrecognised — the same defect this section exists to end, one
 * layer up, with no verdict wrong and only the label.
 *
 * Merely widening a list is a fix that lasts until the next token, so each list
 * is tied to where its tokens are defined instead, in two places:
 *
 *   - at COMPILE time, by the `…IsNamed` assertions below, against the unions
 *     on `DeploymentTopology`. A token added there and not here is a type error
 *     in this file rather than a row that quietly reads "unrecognised".
 *   - at TEST time, by `environmentSection.spec.ts`, which parses the unions
 *     back out of the server's own
 *     `api-gateway/src/Service/Diagnostics/DeploymentDiagnostics.ts` and
 *     compares them with these tuples. That second check exists because
 *     `DeploymentTopology` is a hand-written MIRROR of that file — this package
 *     does not depend on the server one — and nothing else in either tree
 *     notices when the mirror falls behind.
 *
 * They are exported for that second check, and for nothing else.
 */
export const DEPLOYMENT_MODES = ['home-server', 'self-hosted', 'unset', 'other'] as const

type DeploymentModeToken = (typeof DEPLOYMENT_MODES)[number]

/**
 * Three documented tokens plus the two sentinels. Only the exact string `grpc`
 * selects the gRPC branch — an exact `===` with no trim and no case folding —
 * which is a statement about the BRANCH, not about which settings are
 * deliberate. `http` and `auto` are both deliberate and both reported here as
 * themselves; `GRPC`, `grpc ` and anything genuinely outside the set still
 * collapse to `other`, and no value is ever echoed either way.
 */
export const SERVICE_PROXY_SETTINGS = ['grpc', 'http', 'auto', 'unset', 'other'] as const

export const BOUND_SERVICE_PROXIES = ['direct-call', 'grpc', 'http'] as const

export const CACHE_SETTINGS = ['memory', 'redis', 'unset', 'other'] as const

export const SYNC_SWITCH_SETTINGS = ['true', 'false', 'unset', 'other'] as const

/**
 * Each tuple above, asserted to cover every member of the `DeploymentTopology`
 * field it is used on.
 *
 * `Uncovered` is `never` when the tuple is complete and `AssertNever` then
 * compiles; a token the mirror gains and a tuple does not makes this file a
 * type error. Note the direction: this catches a tuple that is too NARROW,
 * which is the one that mislabels a real setting. A tuple carrying a token the
 * server cannot emit is harmless to the operator but still wrong, and the
 * spec's set-equality check against the server source is what catches that.
 */
type Uncovered<Field extends keyof DeploymentTopology, Tokens extends readonly string[]> = Exclude<
  NonNullable<DeploymentTopology[Field]>,
  Tokens[number]
>

export type EveryModeIsNamed = AssertNever<Uncovered<'mode', typeof DEPLOYMENT_MODES>>
export type EveryProxySettingIsNamed = AssertNever<Uncovered<'serviceProxySetting', typeof SERVICE_PROXY_SETTINGS>>
export type EveryBoundProxyIsNamed = AssertNever<Uncovered<'boundServiceProxy', typeof BOUND_SERVICE_PROXIES>>
export type EveryCacheSettingIsNamed = AssertNever<Uncovered<'cacheSetting', typeof CACHE_SETTINGS>>
export type EverySyncSwitchIsNamed = AssertNever<Uncovered<'syncSwitchSetting', typeof SYNC_SWITCH_SETTINGS>>

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
 * variable nobody reported. `buildEnvironmentPresence` already gets this right by
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
 */
const CONFIG_AND_RESTART: RemedyEffort = 'restart'

/**
 * The two findings whose fix is on a different service in this deployment. See
 * `remedyForUnreachableGrpcListener` for what this member replaced and why.
 */
const REPAIR_ANOTHER_SERVICE: RemedyEffort = 'peer-service'

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
 * The secret the launcher could not make DURABLE, which is a different fault from
 * the secret that is too short and has a different fix.
 *
 * `mint-failed` is conclusive: the launcher had no secret supplied, none persisted,
 * and could not mint one, so there is nothing for the durable adapter to
 * authenticate with and it never reports ready. `minted-ephemeral` is the one that
 * looks like a working deployment — a secret exists for the life of THIS process
 * and was never written down, so it is correct until one half of the deployment
 * restarts without the other, at which point the two hold different valid secrets
 * and fail exactly like one short secret: the connection succeeds and readiness
 * never arrives. Nothing logs the divergence.
 */
function remedyForUndurableInternalSecret(ephemeral: boolean): Remedy {
  return {
    code: 'GRPC_SECRET_NOT_DURABLE',
    summary: ephemeral
      ? 'The durable-command secret was minted for this process only and never written down, so it changes on the next start. Supply it explicitly, or make its persistence path writable. Restart only — no rebuild.'
      : 'The launcher could not obtain or mint a durable-command secret at all, so the durable command port never reports ready. Supply one explicitly. Restart only — no rebuild.',
    steps: [
      'Set SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET to a strong random value of at least 32 bytes, in the place this deployment actually reads — on the bundled compose stack that is the .env compose forwards, not the container environment directly.',
      'Set the SAME value on the syncing server. A supplied secret is the one state that does not depend on anything surviving a restart.',
      ephemeral
        ? 'If you would rather the container keep minting it, give the data volume the launcher persists it to a writable mount. An ephemeral mint is not a safe steady state: it is correct until one half restarts without the other, and then both sides hold valid secrets that disagree.'
        : 'If you would rather the container mint it, give the data volume the launcher persists it to a writable mount. Nothing was minted here, so a read-only or absent mount is the first thing to check.',
      'Restart both containers, then re-read this pane.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      ephemeral
        ? 'The launcher recorded that it minted the secret and could not persist it. That is reported as a state and never as a value, and this pane never receives the secret itself.'
        : 'The launcher recorded that minting the secret failed. That is reported as a state and never as a value, and this pane never receives the secret itself.',
      'This is the failure that presents as healthy from outside: the socket stays up and carries everything except note syncing, which is withheld rather than refused.',
    ],
  }
}

/**
 * The findings in this section whose fix is not on this container.
 *
 * These two took `wait` until `peer-service` existed. `wait` was not a lie — the
 * per-call fallback retries gRPC on every call, so the condition genuinely clears
 * with no change here the moment the listener answers — but its chip read
 * "Transient", which understates a permanently dead listener to the point of
 * advising the operator to do nothing. "Another service" says where the action is
 * in the one place an operator reads before the prose.
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
    effort: REPAIR_ANOTHER_SERVICE,
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
    effort: REPAIR_ANOTHER_SERVICE,
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

/**
 * Both remedies below take `readonly KnownEnvKey[]`, not `readonly string[]`.
 *
 * They JOIN the names they are handed into a summary that reaches the screen and
 * both copyable reports, so being unable to be given a server string is worth
 * more than remembering to scrub one — the discipline `remedyForClientGap`
 * arrived at. Nothing reachable passes them a wire key today (only `required`
 * and `inert` rows get here, and a row's key is already a literal of this build),
 * and that is precisely the kind of fact that stops being true quietly.
 */
function remedyForAbsentRequiredConfig(keys: readonly KnownEnvKey[]): Remedy {
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

function remedyForInertConfig(keys: readonly KnownEnvKey[]): Remedy {
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
      note: 'Only the exact string "grpc" selects the gRPC branch. The other two documented values are deliberate rather than mistakes and are reported as themselves: "http" is an explicit pin to the HTTP proxies, and "auto" is the self-configuring default the setup script writes. Read any of them together with the decision row in the next block: since the lane became self-configuring, neither "auto" nor "unset" here means nobody decided — it means the resolver decided, and recorded why.',
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
      value: runtime.processUptimeSeconds === undefined ? NOT_PUBLISHED : safeDuration(runtime.processUptimeSeconds),
      ...absentOr(runtime.processUptimeSeconds, 'informational'),
      note: 'The answer to "I changed the setting and restarted — did it take?", which is the most-asked question in this area and is still unanswerable from this pane. A duration rather than a start instant: the question is whether the restart happened after the edit, and a duration answers it without putting a clock into a public report. NOTHING PUBLISHES IT TODAY, and that was verified rather than assumed: neither `/v1/admin/sync-diagnostics` nor `/v1/admin/server-status` carries a process start or uptime in any field, and the readiness probes they relay carry only a status and a per-check boolean. One `process.uptime()` on either response would fill this row.',
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

/**
 * The three states the internal gRPC auth secret is reported as, plus TWO kinds of
 * honesty that are not the same kind.
 *
 * `unmeasured` — a lane decision WAS reported, and it is one the resolver reaches
 * before its length test, so the threshold was genuinely not measured on this
 * deployment.
 *
 * `unreported` — no lane decision this row can read was reported, so the threshold
 * check did not run here. Split out because collapsing it onto `unmeasured` made
 * the row print "the boot-time lane resolver returned before it reached the length
 * test on this deployment" over a deployment whose resolver was never read — a
 * confident statement about an observation that was never made, which is the one
 * thing this pane's contract forbids outright.
 *
 * It was the state EVERY deployment was in while the decision had no producer, and
 * it is now the state of two narrower ones: a server older than the field, and a
 * server reporting the `unset` sentinel — a gateway started outside the shipped
 * supervisor, which never runs the resolver at all. Both of those genuinely did
 * not measure the secret, and neither of them returned early from a check.
 */
export const GRPC_SECRET_STATES = ['sufficient', 'too-short', 'absent', 'unmeasured', 'unreported'] as const

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
 *
 * NO DECISION AT ALL IS A DIFFERENT ANSWER AND IS NOW REPORTED AS ONE. It used to
 * collapse onto `unmeasured`, whose copy asserts that the resolver ran and
 * returned early — so a deployment that never reported a decision was told why its
 * resolver stopped. Two states that produce the same verdict and different
 * sentences, which is the point: one says the check ran and could not measure, the
 * other says the check did not run.
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
  if (present === undefined) {
    return undefined
  }
  return decision === undefined ? 'unreported' : 'unmeasured'
}

const SECRET_LABEL = safeConstant('Internal gRPC auth secret')

const SECRET_SUFFICIENT = safeConstant('at least 32 bytes')

const SECRET_TOO_SHORT = safeConstant('set, shorter than 32 bytes')

const SECRET_ABSENT = safeConstant('not set')

const SECRET_UNMEASURED = safeConstant('(length not established)')

const SECRET_THRESHOLD_UNREPORTED = safeConstant('(threshold not established: no lane decision reported)')

const SECRET_UNREPORTED_NOTE =
  ' The threshold check did not run here, and this row says so rather than leaving a blank where its answer belongs. What measures this secret against the minimum is the boot-time lane resolver, and the only way its answer reaches this pane is the lane DECISION — a closed enum, one of whose members is the resolver declining because the secret fell short. This deployment reported no decision this row can read, which is one of two things: a server older than the field, or a server reporting that no launcher recorded one at all — a gateway started outside the shipped supervisor, where the resolver never runs. The decision row above says which. The missing fact is an enum member, not a measurement: this pane never reads the secret, never receives it, and could not measure it if it did. Until a decision arrives, presence is all that is observed, and it is reported as the proxy it is.'

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

  if (state === 'unreported') {
    return diagnosticRow({
      label: SECRET_LABEL,
      value: safeTokens(safePresence(present), SECRET_THRESHOLD_UNREPORTED),
      verdict: present === true ? 'healthy' : 'broken',
      evidence: presenceProxy('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET'),
      note: `${SECRET_NOTE}${SECRET_UNREPORTED_NOTE}`,
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

/* -------------------------------------------------------------------------- */
/* The same secret, asked a different question: how did it come to be          */
/* -------------------------------------------------------------------------- */

const SECRET_ORIGIN_LABEL = safeConstant('Internal gRPC secret origin')

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each origin state means, and what
 * it costs. A state nobody wrote a sentence for fails compilation rather than
 * inheriting another state's.
 *
 * The two that matter are the two that look like success. A secret minted and not
 * persisted, and a mint that failed, are both invisible from outside the
 * container: the socket stays up, carries collaboration, API RPC, invites and
 * files, and withholds note syncing only.
 */
const SECRET_ORIGIN_NOTE: Record<InternalGrpcSecretOrigin, string> = {
  supplied:
    'The operator supplied the secret, so it is a value they hold and can rotate in their own configuration rather than one living on a volume. This is the state that survives every restart and every volume reset. It still says nothing about whether the syncing server holds the SAME value, which is the row above.',
  persisted:
    'The secret was read back from the launcher\'s persistence path, so it survives a restart. Worth telling apart from "supplied": rotating it means replacing a file on a volume, not editing a variable, and a volume reset will mint a new one.',
  'minted-persisted':
    'The launcher minted the secret and wrote it down, so it survives a restart. This is the ordinary state of a deployment nobody configured by hand, and it is a correct one.',
  'minted-ephemeral':
    'THE STATE THAT LOOKS LIKE SUCCESS. The launcher minted a secret and could not persist it, so it exists for the life of this process and nowhere else. It is correct right now and stops being correct the moment one half of the deployment restarts without the other: both halves then hold valid secrets that disagree, which fails exactly like one short secret — the connection succeeds and readiness never arrives — and nothing logs the divergence.',
  'not-colocated':
    'There is no co-located syncing server to share a durable-command secret with, so the launcher prepared none. Correct rather than missing: this is the same deployment shape that makes HTTP the right transport, and no value set here would change it.',
  'mint-failed':
    'The launcher had no secret supplied, none persisted, and could not mint one. There is nothing for the durable adapter to authenticate with, so the durable command port never reports ready and note syncing is withheld while the socket carries everything else.',
  unset:
    "No launcher recorded a state. That is an image older than the fix that made the launcher EXPORT its decisions — until then the value was set in the launcher's own shell and no child process, the gateway included, could see it — or a gateway started outside the shipped supervisor, where the launcher does not run at all. It is not a statement that no secret was prepared.",
  other:
    'The LAUNCHER recorded a state its own gateway could not name, which is what this token is: the server collapsed it rather than passing the value on. Nothing is known about the secret beyond the row above.',
}

/**
 * The note for a token outside the set entirely — this build being behind the
 * server, which is a different fact from the server's own `other` sentinel above
 * and must not borrow its sentence. One says the launcher said something its
 * gateway could not name; this one says the gateway named it and this client
 * cannot.
 */
const SECRET_ORIGIN_UNRECOGNISED_NOTE =
  "The server reported an origin state this build has no name for, and the value itself is refused rather than printed. The gap is on the CLIENT: a newer server knows a state this one does not, so a client update is what explains it, and the server's own boot log names it in the meantime."

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The verdict each origin carries.
 *
 * The three durable origins are `informational` and deliberately NOT `healthy`: a
 * stable secret is still only one half of the condition — both sides must hold the
 * same one — and that claim is made, and capped, on the row above. Claiming health
 * twice for one secret is how a green chip came to sit over a withheld operation.
 */
const SECRET_ORIGIN_VERDICT: Record<InternalGrpcSecretOrigin, Verdict> = {
  supplied: 'informational',
  persisted: 'informational',
  'minted-persisted': 'informational',
  'minted-ephemeral': 'degraded',
  'not-colocated': 'informational',
  'mint-failed': 'broken',
  unset: 'informational',
  other: 'informational',
}

/**
 * The origin row. A STATE and never the secret, never a length, and never a path:
 * the words "persisted" and "ephemeral" are constants of this build, and the token
 * itself is admitted only if it is one this build compiled in.
 */
function secretOriginRow(reported: string | undefined): DiagnosticRow {
  const state = INTERNAL_GRPC_SECRET_STATES.find((candidate) => candidate === reported)

  return diagnosticRow({
    label: SECRET_ORIGIN_LABEL,
    value: safeEnum(reported, INTERNAL_GRPC_SECRET_STATES),
    ...absentOr(reported, state === undefined ? 'informational' : SECRET_ORIGIN_VERDICT[state]),
    note:
      state === undefined
        ? reported === undefined
          ? 'How the durable-command secret the socket SYNC_ITEMS lane needs came to be — supplied, read back from a persistence path, minted, or not prepared at all. A state, never the secret and never its length. This server did not report one: either it predates the field, or it predates the fix that made the launcher export its decisions to the gateway process at all.'
          : SECRET_ORIGIN_UNRECOGNISED_NOTE
        : SECRET_ORIGIN_NOTE[state],
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

/**
 * What the decision row says, in five branches that are five different facts.
 *
 * The blank this row used to carry was traced to the launcher assigning
 * `SRN_SERVICE_PROXY_TYPE_DECISION` in eight branches and never EXPORTING it: the
 * echo on the next line was always right, because it ran in the same shell, and
 * the line after it `exec`s the gateway, where a child inherits only exported
 * variables. Both halves are fixed — the export, and a closed union on the
 * deployment report — so the row reads a reported decision now.
 *
 * The four non-reasons are kept apart because the sentences are not
 * interchangeable. `unset` is a launcher that recorded nothing, ABSENT is a server
 * too old to carry the field, `other` is the launcher recording a token its own
 * gateway could not name, and a token outside the set is this client being behind.
 * Collapsing any pair of those produces a confident statement about an observation
 * that was not made, which is the one thing this pane's contract forbids outright.
 */
function decisionNote(reported: string | undefined, decision: ProxyDecision | undefined): string {
  const base =
    'The self-configuring lane records WHICH condition declined gRPC, and that reason is the difference between a deployment where HTTP is correct ("not-colocated": there is no co-located syncing server to speak gRPC to) and one where something is wrong ("syncing-grpc-unreachable": a dial target was configured and the port did not answer). It is also the only thing on the wire that carries the resolver\'s measurement of the internal secret: "no-secret" is the resolver declining because that secret fell short, which is what the threshold row below reads.'

  if (reported === undefined) {
    return `${base} Nothing was reported for it here. The field is on the deployment block, so this is a server older than it rather than a fact nobody publishes — and the reason is undetermined, which is not the same as the variable having been unset.`
  }
  if (reported === 'unset') {
    return `${base} This deployment reports that NO LAUNCHER RECORDED A DECISION, which is a different fact from the reason being undetermined. It is an image older than the export fix, or a gateway started outside the shipped supervisor — a bare start, or a harness — where the resolver does not run at all. Nothing is wrong with the transport on the strength of this row.`
  }
  if (reported === 'other') {
    return `${base} The launcher recorded a token its own gateway could not name, so the server collapsed it to this sentinel rather than passing the value on. Its boot log names the raw token.`
  }
  if (decision === undefined) {
    return `${base} The server reported a decision code this build has no name for, and the value itself is refused rather than printed. The gap is on the CLIENT: a client update is what names it, and the server's boot log names it in the meantime.`
  }

  return base
}

function buildTransportBlock(
  topology: DeploymentTopology | undefined,
  fallback: TransportFallbackView | undefined,
): DiagnosticBlock {
  const recorded = topology?.recorded === true
  // Read off the TOPOLOGY, where the server puts it. Gated on `recorded` for the
  // same reason every other topology field is: an unrecorded block is silence,
  // not a set of defaults.
  const reportedDecision = recorded ? topology?.serviceProxyDecision : undefined
  const decision = PROXY_DECISIONS.find((candidate) => candidate === reportedDecision)
  const secretOrigin = recorded ? topology?.internalGrpcSecretState : undefined
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
      value: safeEnum(reportedDecision, SERVICE_PROXY_DECISIONS),
      ...absentOr(reportedDecision, decision === 'no-secret' || unreachable ? 'degraded' : 'informational'),
      note: decisionNote(reportedDecision, decision),
    }),
    secretRow(secret, secretPresent),
    secretOriginRow(secretOrigin),
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

  if (secretOrigin === 'minted-ephemeral' || secretOrigin === 'mint-failed') {
    const ephemeral = secretOrigin === 'minted-ephemeral'
    findings.push(
      diagnosticFinding({
        code: safeConstant('GRPC_SECRET_NOT_DURABLE'),
        title: ephemeral
          ? 'The durable-command secret exists only in this process'
          : 'The launcher could not obtain a durable-command secret',
        detail: ephemeral
          ? 'The launcher minted the secret and could not write it down, so it is correct for exactly as long as this process lives. It stops being correct the moment one half of the deployment restarts without the other: both halves then hold valid secrets that disagree, which fails exactly like one short secret — readiness never arrives — and nothing logs the divergence. This is the state that looks like a working deployment from outside.'
          : 'Nothing was supplied, nothing was persisted and minting failed, so the durable adapter has no credential and never reports ready. Note syncing is withheld while the socket stays up and carries collaboration, API RPC, invites and files, which is why every other panel looks healthy.',
        verdict: ephemeral ? 'degraded' : 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForUndurableInternalSecret(ephemeral),
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

  /**
   * *** THREE EMPTY ROWS OR ONE SENTENCE. ***
   *
   * All three of these are read by the AUTH process and no endpoint this pane can
   * reach reports one of them, so on every deployment they rendered "not reported"
   * in a column — which an operator read as three broken checks rather than as one
   * input nobody sends. Collapsed the way the admission block in
   * `websocketSection.ts` is, and for the same reason.
   *
   * The replacement keeps `undetermined`: each of the three carried that when
   * absent, and the cookie pair in particular is a configuration that silently
   * discards every session, so a block that fell to healthy for want of a reading
   * would be reassuring about the exact thing it cannot see. The rows return,
   * flag by flag, the moment anything reports one — and because they are EFFECTIVE
   * values rather than presence, a reading of them cannot be synthesised here:
   * both default to true when unset, so "unset" and "off" are opposite answers.
   */
  const runtimeFlagsReported =
    runtime.cookieSecure !== undefined || runtime.cookiePartitioned !== undefined || runtime.e2eTesting !== undefined

  const rows: DiagnosticRow[] = runtimeFlagsReported
    ? [
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
    : [
        diagnosticRow({
          label: safeConstant('Effective cookie and session-mode flags'),
          value: NOT_PUBLISHED,
          verdict: 'undetermined',
          evidence: EVIDENCE_ABSENT,
          note: 'Three flags, named here rather than rendered as three empty rows: the effective Secure and Partitioned attributes on the session cookie, and whether E2E_TESTING is forcing legacy header sessions. All three are read by the AUTH process and no endpoint this pane can reach reports any of them. They cannot be observed from the browser either — the session cookie is not script-readable, and its attributes are not exposed to a page in any case. Each appears as its own row the moment a server reports it. Presence of the variables would not substitute: both cookie flags default to ON when unset, so "unset" and "off" are opposite answers and a presence reading would invert the diagnosis.',
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
const REVISION_LABEL = safeConstant('Build revision')

const REVISION_UNSTAMPED = safeConstant('unstamped (stated by the build)')

const REVISION_NONE = safeConstant('none published')

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the revision row prints in each
 * marker state.
 *
 * `published` and `malformed-marker` go through the SAME call, and that is the
 * point of the shape rule rather than a missed branch: a marker that matches
 * `DEPLOY_REVISION` prints its revision, and one that does not becomes the
 * withheld constant. The state is derived from that same pattern, so the two
 * cannot disagree about which marker is publishable.
 *
 * The other two states never reach the pattern at all, because their revision is
 * a SENTINEL rather than a malformed value — running `unstamped` or the blank
 * marker's em dash through the shape check would report "withheld (unrecognised
 * format)" over a build that stated its own unstamped-ness perfectly clearly.
 */
const REVISION_VALUE: Record<IdentityState, (identity: DeploymentIdentityView) => SafeValue> = {
  published: (identity) => safeToken(identity.revision, DEPLOY_REVISION),
  'malformed-marker': (identity) => safeToken(identity.revision, DEPLOY_REVISION),
  'unstamped-marker': () => REVISION_UNSTAMPED,
  'no-identity': () => REVISION_NONE,
}

const REVISION_NOTE =
  'The commit this build was stamped with, admitted by SHAPE: exactly the 40 lowercase hex characters app/Dockerfile itself validates, through the same rule the copyable reports admit it with. Anything else is withheld rather than printed — the marker is served by whatever fronts the web bundle, so it is untrusted input, and it has already leaked a secret-shaped revision once. This row carries no verdict of its own; the row above it is where "can this deployment say which commit it is" is answered.'

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
  const identity = marker === undefined ? undefined : describeDeployment(marker)
  const state = identity === undefined ? undefined : describeIdentityState(marker)
  const revisionVariable = presenceOf(topology, 'SRN_DEPLOY_REVISION')
  const versionVariable = presenceOf(topology, 'SRN_DEPLOY_VERSION')

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Deployment identity'),
      value: state === undefined ? safePresence(undefined) : IDENTITY_VALUE[state],
      ...absentOr(state, state === 'published' ? 'healthy' : 'degraded'),
      note: 'Whether the running build can say which commit it is. "Published" means the runtime values and the marker baked into the image agreed; anything else means "is the running build current?" cannot be answered from here, which is the first question of every incident. The revision itself is the row below; the VERSION is printed in the copyable report under its own Deployment heading, admitted there by shape.',
    }),
    diagnosticRow({
      label: REVISION_LABEL,
      value: state === undefined || identity === undefined ? safePresence(undefined) : REVISION_VALUE[state](identity),
      ...absentOr(state, 'informational'),
      note: REVISION_NOTE,
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
 * The block heading for each group `buildEnvironmentPresence` can produce.
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
 *
 * There is deliberately no `Reported by a newer server` entry any more. That
 * group's rows were the ones whose keys came off the wire, and it is now a count
 * in a block of this file's own making, below.
 */
const GROUP_HEADING: Readonly<Partial<Record<string, SafeValue>>> = {
  'Realtime transport': safeConstant('Realtime transport'),
  'Shared state': safeConstant('Shared state'),
  'Durable backend': safeConstant('Durable backend configuration'),
  'Files lane': safeConstant('Files lane'),
  'Event fan-out': safeConstant('Event fan-out'),
  'Deployment identity': safeConstant('Deployment identity variables'),
}

const GROUP_HEADING_FALLBACK = safeConstant('Other configuration')

/**
 * One row from `buildEnvironmentPresence`, as a contract row.
 *
 * Nothing is re-judged here. The key, the presence boolean, the relevance and
 * the note all come from that module; this function's whole job is to turn a
 * relevance into a verdict and an evidence kind, which is the part the section
 * contract adds and the part `EnvironmentRow.tone` cannot express — a tone
 * cannot say that a positive reading rests on a necessary condition and is
 * therefore not a claim that the thing works.
 *
 * `row.key` is a `KnownEnvKey`, so the label is a literal of this build and
 * `safeEnvName` is a floor under it rather than the admission. It was the
 * admission, and that was the hole: shape is not membership, so a key off the
 * wire in upper snake case was printed as a row label while differently-shaped
 * ones were refused.
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
    /**
     * SET AND INERT IS UNTIDY, NOT IMPAIRED.
     *
     * This arm answered `degraded` for a variable that is set and never read,
     * which dragged this whole section's worst verdict — and the Overview router
     * with it — over two variables that impair nothing. `REDIS_HOST` and
     * `REDIS_PORT` set on a topology that binds Redis from `REDIS_URL` is the
     * live reading that made the point: the deployment is correct, the rows say
     * so in words, and the chip said Degraded.
     *
     * What makes the downgrade safe rather than quieter is that the impairing
     * case has its OWN row and its own finding, and they are not this one. A
     * variable whose being unread MATTERS is a variable the topology needs and
     * does not have — the operator set `REDIS_HOST` where this topology reads
     * `REDIS_URL` — and that is the `required`-and-absent arm above, which
     * answers `broken` and raises `REQUIRED_CONFIG_ABSENT`. Both are computed
     * from the same presence rows in the same pass, so the pair arrives together
     * and the severity comes from the half that has a consequence.
     */
    return diagnosticRow({
      label,
      value,
      verdict: 'informational',
      evidence: EVIDENCE_DIRECT,
      note:
        row.note ||
        'Not read in this topology. Set and inert is the state worth NAMING — the operator believes it is doing something — and it impairs nothing on its own, so it carries no verdict. The variable this topology does read is a row of its own, and it is the one with a verdict.',
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

/**
 * The variables this server reports that this build has no guidance for, as a
 * COUNT.
 *
 * A row rather than nothing, and a count rather than names: the fact an operator
 * needs is that the gap is on the client, which is what a number against "this
 * build does not recognise" says. The names are the half that cannot be printed
 * — a presence key is chosen by the server — and are also the half that tells a
 * reader least, since they are strings this build has never heard of either.
 *
 * Present at zero as well, like the unrecognised-services row in the Database
 * section: "none the rows above could not name" is a reading, and an absent row
 * cannot be told apart from a build that never counted.
 */
function unrecognisedBlock(unrecognised: number): DiagnosticBlock {
  return {
    heading: safeConstant('Reported by a newer server'),
    description:
      'Configuration this server reports that this client build has no guidance for. Counted here, never named.',
    rows: [
      diagnosticRow({
        label: safeConstant('Variables this build does not recognise'),
        value: safeCount(unrecognised),
        verdict: 'informational',
        evidence: EVIDENCE_DIRECT,
        note: 'Variables the server reported that this build has no row for. They are not dropped — an unknown-but-reported variable is still evidence — and they are not named, because the KEYS of a presence map are chosen by the server exactly as its values would be, and this pane feeds a report written to be pasted in public. A non-zero reading here is a statement about the CLIENT: this build is older than the server it is talking to, so it cannot say whether those variables matter in this topology, and a client update is what closes that.',
      }),
    ],
    findings: [],
  }
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
  safeConstant('Build version'),
  safeConstant(
    'reported under the Deployment heading of this report, admitted by shape; the revision is a row in this section, admitted by the same rule',
  ),
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

  const presence: EnvironmentPresence = buildEnvironmentPresence(input.topology)
  const configured = configBlocks(presence.groups)

  const blocks: DiagnosticBlock[] = [
    buildShapeBlock(input.topology, runtime),
    buildTransportBlock(input.topology, input.fallback),
    buildSessionBlock(input.topology, runtime),
    buildIdentityBlock(input.topology, input.deploymentMarker),
  ]

  // Branched on whether a presence block was REPORTED, not on whether any of it
  // could be named: a server that reports only variables this build has no name
  // for has reported something, and saying "nothing was reported" there would be
  // the one claim this section must never make.
  if (!presence.reported) {
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
    blocks.push(...configured, unrecognisedBlock(presence.unrecognised))

    const absentRequired = presence.groups.flatMap((group) =>
      group.rows.filter((row) => row.relevance === 'required' && !row.present).map((row) => row.key),
    )
    const inertAndSet = presence.groups.flatMap((group) =>
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
            'Dead configuration, and worth naming for one reason: it is why a deployment can look correctly configured and behave as if it were not — the switch that decides whether the branch runs at all is a different variable from the one that was set. On its own it impairs NOTHING, which is why it is reported as a notice and not as a degradation. When being unread actually matters, the variable this topology DOES read is unset, and that is reported separately as REQUIRED_CONFIG_ABSENT from the same presence rows — read the two together: this finding alone is untidiness, the pair is a misconfiguration.',
          /**
           * `informational`, not `degraded`. Set-and-unread configuration impairs
           * nothing by itself, and rating it a degradation took this section's
           * worst verdict — and the Overview router — to Degraded over two inert
           * Redis variables on a correctly configured deployment. The impairing
           * case keeps its own `broken` finding directly above, derived from the
           * same rows in the same pass, so nothing that has a consequence is
           * downgraded with it.
           */
          verdict: 'informational',
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
