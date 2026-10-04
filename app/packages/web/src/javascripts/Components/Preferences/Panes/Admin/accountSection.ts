import type { SyncFallbackReason } from '@/Services/SyncTransport/syncTransportProtocol'
import { remedyForClientGap, type Remedy, type RemedyEffort } from './diagnosticRemedies'
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
  safePercentBucket,
  safePresence,
  safeState,
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
import { CLIENT_RECOGNIZED_ONLY_OPERATIONS, CLIENT_SYNC_OPERATIONS } from './syncDiagnostics'

/**
 * Standard Red Notes: the Account, space & requirements section of the admin
 * diagnostics pane.
 *
 * Three questions, in this order: WHO is this session and what is it entitled to,
 * HOW MUCH room does this account have, and WHAT MUST BE TRUE for the app to work
 * for this user. The third is the reason the section exists. Every other section
 * in this pane describes the deployment; this one describes the person in front of
 * it, and "is anything missing for this user, on this machine, right now" is the
 * question a state dump answers worst.
 *
 * -------------------------------------------------------------------------------
 * 1. THE ONE SECTION ABOUT A PERSON. Identifiers are not diagnoses.
 * -------------------------------------------------------------------------------
 *
 * The copyable report is written to be pasted — into an issue, into a chat, into a
 * support thread. Every other section's secrecy budget is about a DEPLOYMENT. This
 * one is about an ACCOUNT, and the rule here is stricter than presence-only:
 *
 *   An e-mail address, a user id, a session id, a device id, an IP address and a
 *   subscription id NEVER appear — not in a row value, not in a report line, not
 *   on the screen through this module at all.
 *
 * That is held the same way `browserSection.ts` holds the user-agent string: by
 * SHAPE rather than by discipline. `AccountObservations` has no member that could
 * carry any of them. There is no `email`, no `userUuid`, no `sessionUuid`, no
 * `deviceId`, no `ipAddress`, no `subscriptionUuid`; a caller cannot hand one in,
 * so no row can print one and no future edit here can start. The handful of wide
 * `string` members that do exist — a role name, a subscription plan — are the
 * SERVER's enums and go through `safeEnum`, which admits a declared literal and
 * collapses everything else to a constant without echoing a byte of it. An
 * identifier arriving through one of those is counted, never printed.
 *
 * `Session.ipAddress` is stored in plaintext server-side and WHETHER TO SURFACE IT
 * AT ALL IS AN OPEN DECISION NOBODY HAS MADE. So it is not surfaced here, in any
 * form, not even as a presence boolean: "an IP address is recorded for this
 * session" is itself a statement about the account's location, and a row that
 * cannot be added later costs nothing while a row that cannot be unsent costs
 * everything. Nothing in this module reads it and nothing in this module asks for
 * it.
 *
 * Byte totals and quota percentages are a different category: they are about
 * CAPACITY, not identity, and they are reported — reduced to buckets and whole
 * megabytes, because the precision adds nothing to the diagnosis and does
 * disclose the size of one person's vault.
 *
 * -------------------------------------------------------------------------------
 * 2. A 403 AND A 401 ARE NOT THE SAME ANSWER. The section is built around it.
 * -------------------------------------------------------------------------------
 *
 * This pane's own endpoint is admin-gated. `AdminController.getSyncDiagnostics`
 * answers **403** with "Admin role required." when the requestor is not an admin;
 * a **401** comes from the cross-service-token middleware declared on the same
 * route, which runs BEFORE the role check ever happens.
 *
 * So the two statuses carry opposite information, and each is conclusive about a
 * DIFFERENT requirement:
 *
 *   - **403** — the session WAS authenticated and was then refused on
 *     authorization. Conclusive that the role is missing. Conclusive that the
 *     session is otherwise fine.
 *   - **401** — the request was never authenticated. Conclusive that the session
 *     is not accepted. Establishes NOTHING about the role, because the role check
 *     did not run. Sending that operator to audit their roles is a guaranteed
 *     dead end.
 *
 * `ROLE_READING` and `SESSION_READING` are two exhaustive `Record`s over the same
 * closed reading of that one request, and they disagree on purpose: on a 403 the
 * role row reads `broken` and the session row reads `healthy`. A single
 * "diagnostics could not be read" state cannot express that, which is why the
 * reading is closed and mapped twice rather than branched on with an `if`.
 *
 * -------------------------------------------------------------------------------
 * 3. What this section does NOT own.
 * -------------------------------------------------------------------------------
 *
 * One defect stated three ways loses the operator, so each of these is named here
 * once and left to its owner:
 *
 *   - The socket lane, the negotiated-capability census and the SYNC_ITEMS
 *     verdict are the **WebSocket** section's. This section reads the transport
 *     for exactly one account-scoped fact — a `live-sync-disabled` refusal — and
 *     carries the one-line cross-reference that a session renewed since the
 *     socket connected can be refused on the socket lane while plain HTTP still
 *     succeeds.
 *   - Origin storage, eviction and the browser's own quota are
 *     **`browserSection.ts`**'s. The storage angle HERE is the account's
 *     server-side allowance, which is a different number with a different failure.
 *   - Deployment configuration and identity are **Environment & setup**'s.
 *   - The database and internal transport are **Database & internal comms**'.
 *
 * -------------------------------------------------------------------------------
 * 4. Two fields this build asks for and no server sends.
 * -------------------------------------------------------------------------------
 *
 * The per-account feature flags — `LIVE_SYNC_ENABLED` and
 * `COLLABORATION_ENABLED` — are written by the admin Users tab and read by the
 * server. There is NO endpoint through which a client can read its OWN effective
 * flags, so the only client-side evidence that live sync is off for this account
 * is the transport's `live-sync-disabled` refusal code, and there is no evidence
 * at all for collaboration.
 *
 * Both are declared here as optional inputs anyway, following the
 * `TransportFallbackView` precedent: the row exists, reads "not reported", and
 * states what it is waiting for. A row that is absent is a question nobody asks
 * again; a row that says "not reported" is a request. No row is fabricated and no
 * server file is edited to fill one.
 */

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The role taxonomy this build knows, mirroring `CANONICAL_ROLE_LABELS` in
 * `adminRolesUi.ts` and the server's `CanonicalRoles`.
 *
 * Declared as a tuple so a role name can be ADMITTED rather than printed. A role
 * name is a closed enum only while it is one of these; anything else could be any
 * string at all — including, on a misbehaving or newer server, something that is
 * not a role name — so it is counted and never echoed.
 */
export const ACCOUNT_ROLES = ['ADMIN_USER', 'PRO_USER', 'CORE_USER', 'VAULTS_USER'] as const

export type AccountRole = (typeof ACCOUNT_ROLES)[number]

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The label each role row carries. */
const ROLE_LABEL: Record<AccountRole, SafeValue> = {
  ADMIN_USER: safeConstant('Role: Admin user'),
  PRO_USER: safeConstant('Role: Full user'),
  CORE_USER: safeConstant('Role: Core user'),
  VAULTS_USER: safeConstant('Role: Vaults user'),
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What each role grants, in one clause. */
const ROLE_NOTE: Record<AccountRole, string> = {
  ADMIN_USER:
    'The role every endpoint behind this pane is gated on. Without it the admin endpoints answer 403 and most of this pane has nothing to show; it changes nothing about whether notes sync.',
  PRO_USER: 'Every end-user feature at the highest tier. On this fork the features are entitled regardless.',
  CORE_USER: 'A standard account. The ordinary role for a user who was never given another.',
  VAULTS_USER:
    'Shared vaults and collaboration. Whether collaboration actually works for this account additionally needs the per-account switch below, which no server reports to a client yet.',
}

/**
 * The subscription plans the first-party server issues. Admitted against this
 * tuple so a plan name — the one subscription string that reaches this section —
 * cannot put arbitrary bytes on the screen, and so a subscription IDENTIFIER
 * arriving in the wrong field collapses to a constant instead of being printed.
 */
export const SUBSCRIPTION_PLANS = ['CORE_PLAN', 'PLUS_PLAN', 'PRO_PLAN'] as const

/**
 * A subscription as a STATE, never an identifier and never a date.
 *
 * `none` is first-class and is NOT a fault: this fork is single-tier and entitles
 * every feature, so no subscription at all is the ordinary state of a self-hosted
 * account. A section that painted it amber would send every self-hoster after a
 * purchase they do not need.
 */
export const SUBSCRIPTION_STATES = ['active', 'cancelled-until-end', 'expired', 'offline-only', 'none'] as const

export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What each subscription state prints. */
const SUBSCRIPTION_VALUE: Record<SubscriptionState, SafeValue> = {
  active: safeConstant('active'),
  'cancelled-until-end': safeConstant('cancelled, active until it ends'),
  expired: safeConstant('ended'),
  'offline-only': safeConstant('offline subscription only'),
  none: safeConstant('none'),
}

/**
 * The account's server-side file allowance, as a closed state.
 *
 * `-1` is the ONLY value the files server treats as unlimited, and `0` is not a
 * missing limit — it is an allowance of nothing, which refuses every upload. Those
 * two are opposite answers and a single "no usable limit" state would merge them.
 */
export const FILE_QUOTA_STATES = ['unlimited', 'room-available', 'nearly-full', 'exhausted', 'no-allowance'] as const

export type FileQuotaState = (typeof FILE_QUOTA_STATES)[number]

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What the headroom row prints. */
const FILE_QUOTA_VALUE: Record<FileQuotaState, SafeValue> = {
  unlimited: safeConstant('no limit set'),
  'room-available': safeConstant('room available'),
  'nearly-full': safeConstant('nearly full'),
  exhausted: safeConstant('at or over the limit'),
  'no-allowance': safeConstant('no allowance granted'),
}

/** The share of a file allowance at which this build reports it as nearly full. */
export const FILE_QUOTA_NEAR_FRACTION = 0.9

/** Binary megabyte, matching the units the admin Users tab reads and writes. */
const BYTES_PER_MB = 1_048_576

/* -------------------------------------------------------------------------- */
/* The one admin-endpoint reading, mapped twice                               */
/* -------------------------------------------------------------------------- */

/**
 * What happened to the admin-gated diagnostics read, as a closed set.
 *
 * `not-attempted` is distinct from `never-completed`: the first is a pane that has
 * not asked yet, the second is a request that went out and came back with nothing.
 * Both are "no verdict", and they are different facts.
 */
export const ADMIN_READINGS = [
  'payload-read',
  'refused-403',
  'unauthenticated-401',
  'endpoint-missing-404',
  'answered-other',
  'never-completed',
  'not-attempted',
] as const

export type AdminReading = (typeof ADMIN_READINGS)[number]

/**
 * What the pane observed of its own admin request.
 *
 * Supplied by the caller, which already holds both halves: the payload it read,
 * and the `DiagnosticsReadFailure` status when it could not. Absent means no
 * request has been attempted, which is a legitimate first-render state.
 */
export type AdminAccessReading = {
  /** True when the admin-gated endpoint answered with a payload. */
  payloadRead?: boolean
  /** The status a failed read answered with. Absent when the request never completed. */
  status?: number
}

/**
 * Reduce the request to one closed reading.
 *
 * `payloadRead` wins over a status on purpose: a caller holding both is holding a
 * stale failure beside a fresh success, and the success is the later fact.
 */
export function describeAdminReading(access: AdminAccessReading | undefined): AdminReading {
  if (access === undefined) {
    return 'not-attempted'
  }
  if (access.payloadRead === true) {
    return 'payload-read'
  }
  if (access.status === 403) {
    return 'refused-403'
  }
  if (access.status === 401) {
    return 'unauthenticated-401'
  }
  if (access.status === 404) {
    return 'endpoint-missing-404'
  }
  if (access.status !== undefined) {
    return 'answered-other'
  }
  return 'never-completed'
}

/** One reading of one request, as it bears on one requirement. */
type ReadingVerdict = {
  value: SafeValue
  verdict: Verdict
  /** True when this status is conclusive about THIS requirement. */
  direct: boolean
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the reading says about the ADMIN
 * ROLE.
 *
 * A 403 is the server answering the role question directly. A 401 answers a
 * different question entirely and is therefore ABSENT evidence here — the one
 * mapping in this file that an `if`-chain has historically got wrong, because
 * "the request failed" feels like it should count against the role.
 */
const ROLE_READING: Record<AdminReading, ReadingVerdict> = {
  'payload-read': { value: safeConstant('confirmed by the server'), verdict: 'healthy', direct: true },
  'refused-403': { value: safeConstant('refused by the server (403)'), verdict: 'broken', direct: true },
  'unauthenticated-401': {
    value: safeConstant('not established: the request was not authenticated (401)'),
    verdict: 'undetermined',
    direct: false,
  },
  'endpoint-missing-404': {
    value: safeConstant('not established: this build has no admin endpoint (404)'),
    verdict: 'undetermined',
    direct: false,
  },
  'answered-other': { value: safeConstant('not established: the read failed'), verdict: 'undetermined', direct: false },
  'never-completed': {
    value: safeConstant('not established: the request never completed'),
    verdict: 'undetermined',
    direct: false,
  },
  'not-attempted': { value: safePresence(undefined), verdict: 'undetermined', direct: false },
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the same reading says about whether
 * the SERVER ACCEPTS THIS SESSION — which is not what `isSignedIn()` answers.
 *
 * This is the row that makes the 401/403 split pay twice. A 403 proves the session
 * authenticated FINE and was refused on authorization, so it is `healthy` here and
 * `broken` above. A 401 is the opposite pair. No single state could carry both.
 */
const SESSION_READING: Record<AdminReading, ReadingVerdict> = {
  'payload-read': { value: safeConstant('accepted'), verdict: 'healthy', direct: true },
  'refused-403': {
    value: safeConstant('accepted (refused on the role, not on authentication)'),
    verdict: 'healthy',
    direct: true,
  },
  'unauthenticated-401': { value: safeConstant('rejected (401)'), verdict: 'broken', direct: true },
  'endpoint-missing-404': {
    value: safeConstant('not established: the route does not exist on this build'),
    verdict: 'undetermined',
    direct: false,
  },
  'answered-other': { value: safeConstant('not established: the read failed'), verdict: 'undetermined', direct: false },
  'never-completed': {
    value: safeConstant('not established: the request never completed'),
    verdict: 'undetermined',
    direct: false,
  },
  'not-attempted': { value: safePresence(undefined), verdict: 'undetermined', direct: false },
}

/* -------------------------------------------------------------------------- */
/* What a collection run may say about an account                             */
/* -------------------------------------------------------------------------- */

/**
 * Booleans, closed unions, bounded counts and byte totals — and nothing else fits
 * in this shape, which is the point of writing it out rather than passing the
 * application in.
 *
 * There is no member here that could carry an e-mail address, a user id, a session
 * id, a device id, an IP address or a subscription id. The report path cannot be
 * handed one from this module because the caller has nowhere to put one.
 *
 * The two wide `string` members are destined for `safeEnum` against the tuples
 * above, which admits a declared literal and never echoes anything else.
 */
/**
 * Why the server-side space figures are absent, as a closed set.
 *
 * `not-attempted` — nothing in this build reads them. The emptiness is a gap in the
 * PANEL and says nothing about the deployment.
 * `read-and-failed` — they were asked for and the read did not produce them. The
 * emptiness is then a SYMPTOM, and the thing it is a symptom of is the subject.
 *
 * Two values rather than a boolean because a third is already foreseeable — a read
 * that succeeded and returned nothing — and because a boolean named `failed` reads
 * as `false` for "never tried", which is the conflation this set exists to end.
 */
export const SPACE_FIGURE_SOURCES = ['not-attempted', 'read-and-failed'] as const

export type SpaceFigureSource = (typeof SPACE_FIGURE_SOURCES)[number]

export type AccountObservations = {
  /** A local session object exists. A LOCAL fact: it says nothing about the server accepting it. */
  signedIn?: boolean
  /** Signed into a first-party server, which is what makes the quota rows readable at all. */
  firstPartyServer?: boolean
  /** `featuresController.isAdminUser()` — this client's own cached role claim. */
  clientBelievesAdmin?: boolean
  /** Role NAMES. Admitted against `ACCOUNT_ROLES`; anything else is counted, never printed. */
  roles?: readonly string[]
  /** `isEntitledToSharedVaults()` — the gate THIS CLIENT applies before offering collaboration. */
  entitledToSharedVaults?: boolean
  /** Whether an online subscription exists at all. */
  subscriptionPresent?: boolean
  /** The server's plan name. Admitted against `SUBSCRIPTION_PLANS`. */
  subscriptionPlan?: string
  subscriptionCancelled?: boolean
  /**
   * Seconds until the subscription ends; negative once it has. A DURATION, never
   * the instant: an expiry date pins an account to a purchase, and the diagnostic
   * question is only "how long is left".
   */
  subscriptionEndsInSeconds?: number
  /** A first-party OFFLINE subscription, which entitles features with no online record. */
  offlineSubscription?: boolean
  /** `FileUploadBytesUsed`, the subscription setting. A capacity fact. */
  fileUploadBytesUsed?: number
  /** `FileUploadBytesLimit`. `-1` is the only unlimited sentinel; `0` refuses every upload. */
  fileUploadBytesLimit?: number
  /** Local origin bytes in use, read ONLY to compare against the user's own cap below. */
  localUsageBytes?: number
  /** `PrefKey.StorageMaxUsageBytes`. `0` means the user set no cap. ADVISORY: never blocks a write. */
  localSoftCapBytes?: number
  /**
   * WHY the server space figures are absent, when they are — which is a different
   * fact from their being absent and must never render the same way.
   *
   * An all-"not reported" Space block was read here as cosmetic noise and then
   * measured as the only trace in a whole report of a completely broken files
   * subsystem: the operator's attachments were failing and their usage read zero,
   * and this block's silence was the symptom rather than a gap in the panel. Those
   * two are the same defect class as a collection answering `[]` for both "none"
   * and "not read yet", and this field is what keeps them apart.
   *
   * Absent means not even this is known.
   */
  spaceFigureSource?: SpaceFigureSource
  /** `payload.protocol.version`, for context beside the consumability row. */
  protocolVersion?: number
  /** `payload.protocol.serverOperations`. Compared against this build's own two lists. */
  serverOperations?: readonly string[]
  /**
   * The transport's current fallback reason, typed as the protocol's own union.
   * Read for exactly ONE account-scoped fact — `live-sync-disabled` — and never
   * rendered: what the transport is doing belongs to the WebSocket section.
   */
  fallbackReason?: SyncFallbackReason
  /**
   * OPTIONAL PLUMBING, ASKED FOR AND NOT YET SENT. The effective per-account
   * `LIVE_SYNC_ENABLED`. No endpoint lets a client read its own flags, so this is
   * absent on every server today and the row reads "not reported" and says what it
   * is waiting for.
   */
  liveSyncEnabledForAccount?: boolean
  /** OPTIONAL PLUMBING, ASKED FOR AND NOT YET SENT. The effective `COLLABORATION_ENABLED`. */
  collaborationEnabledForAccount?: boolean
}

export type AccountSectionInput = {
  /** Absent until the caller has gathered anything; every row then reads "not reported". */
  observations?: AccountObservations
  /** This pane's own admin request, which is the only probe of the role it needs. */
  adminAccess?: AdminAccessReading
  outcomes?: readonly SectionTaggedOutcome[]
}

/* -------------------------------------------------------------------------- */
/* Reductions, each exported so each is testable on its own                   */
/* -------------------------------------------------------------------------- */

function wholeBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Whole binary megabytes, rounded DOWN, so `0` honestly means "under one". */
export function wholeMegabytes(bytes: number | undefined): number | undefined {
  const usable = wholeBytes(bytes)
  return usable === undefined ? undefined : Math.floor(usable / BYTES_PER_MB)
}

/**
 * How much of the account's file allowance is in use, as a fraction, or
 * `undefined` where the question does not apply (no limit, no allowance, nothing
 * measured). Never a division by zero and never a fabricated zero.
 */
export function fileQuotaFraction(used: number | undefined, limit: number | undefined): number | undefined {
  const usableLimit = wholeBytes(limit)
  const usableUsed = wholeBytes(used)
  if (usableLimit === undefined || usableLimit <= 0 || usableUsed === undefined) {
    return undefined
  }
  return usableUsed / usableLimit
}

/**
 * The allowance as one of five closed states.
 *
 * ABSENT IS NOT ZERO, in both directions. A limit nobody reported produces no
 * state at all, because a missing limit read as `0` would claim every upload is
 * refused, and read as unlimited would claim the opposite — and a USED figure
 * nobody reported cannot be turned into "room available" either, which is the
 * flattering direction and therefore the dangerous one.
 */
export function describeFileQuota(used: number | undefined, limit: number | undefined): FileQuotaState | undefined {
  if (limit === -1) {
    return 'unlimited'
  }
  if (limit === 0) {
    return 'no-allowance'
  }

  const fraction = fileQuotaFraction(used, limit)
  if (fraction === undefined) {
    return undefined
  }
  if (fraction >= 1) {
    return 'exhausted'
  }
  return fraction >= FILE_QUOTA_NEAR_FRACTION ? 'nearly-full' : 'room-available'
}

/**
 * The subscription as one of five closed states.
 *
 * An offline subscription is reported where there is no online one rather than
 * being merged into `active`: they entitle the same features and are completely
 * different things to go looking for.
 */
export function describeSubscription(observed: AccountObservations): SubscriptionState | undefined {
  if (observed.subscriptionPresent === true) {
    const endsIn = observed.subscriptionEndsInSeconds
    if (typeof endsIn === 'number' && Number.isFinite(endsIn) && endsIn <= 0) {
      return 'expired'
    }
    return observed.subscriptionCancelled === true ? 'cancelled-until-end' : 'active'
  }

  if (observed.offlineSubscription === true) {
    return 'offline-only'
  }

  return observed.subscriptionPresent === false ? 'none' : undefined
}

/** Everything this client build will accept in a handshake: consumed plus recognised. */
const CONSUMABLE_OPERATIONS: ReadonlySet<string> = new Set<string>([
  ...CLIENT_SYNC_OPERATIONS,
  ...CLIENT_RECOGNIZED_ONLY_OPERATIONS,
])

/**
 * How many advertised operations this client build has no handler for.
 *
 * COUNTED, NEVER NAMED. An operation this build does not recognise is by
 * definition outside every closed set it owns, so its name is a server-supplied
 * string of unknown content — exactly the case `safeEnum` refuses rather than
 * repairs. The count answers the diagnostic question; the name would only add
 * bytes this module is not allowed to vouch for.
 */
/**
 * How many reported roles this build has no name for.
 *
 * COUNTED, NEVER ECHOED, for the same reason as an unconsumable operation: a role
 * name is a closed enum only while it is one of the four this build declares, and
 * anything else is a server-supplied string of unknown content. This section is
 * the one place in the pane where such a string could be an identifier, so the
 * count is the whole of what is reported.
 */
export function unrecognisedRoleCount(roles: readonly string[] | undefined): number | undefined {
  return roles === undefined
    ? undefined
    : roles.filter(
        (candidate) => typeof candidate !== 'string' || !(ACCOUNT_ROLES as readonly string[]).includes(candidate),
      ).length
}

export function unconsumableOperationCount(operations: readonly string[] | undefined): number | undefined {
  if (operations === undefined) {
    return undefined
  }
  return operations.filter((operation) => typeof operation === 'string' && !CONSUMABLE_OPERATIONS.has(operation)).length
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Absent is not false, held structurally rather than remembered.
 *
 * Every directly-observed row in this file routes through here, so a row cannot
 * claim direct evidence for something nobody measured. The failure it prevents is
 * a row reading "not reported" with a confident tone behind it, which is the panel
 * asserting it looked when it did not.
 */
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

/** A row driven by one of the two readings of this pane's own admin request. */
function readingRow(input: { label: SafeValue; reading: ReadingVerdict; note: string }): DiagnosticRow {
  return diagnosticRow({
    label: input.label,
    value: input.reading.value,
    verdict: input.reading.verdict,
    evidence: input.reading.direct ? EVIDENCE_DIRECT : EVIDENCE_ABSENT,
    note: input.note,
  })
}

/* -------------------------------------------------------------------------- */
/* Remedies, owned by this module                                             */
/* -------------------------------------------------------------------------- */

/**
 * Two of this section's three remedies are an action by the person at the
 * keyboard — sign in, sign out and back in, delete some attachments — which is
 * what `device` means and what the "On this device" chip says before a word of the
 * steps has been read.
 *
 * TWO FINDINGS HERE DELIBERATELY CARRY NO REMEDY, and that is a judgement rather
 * than an omission. `ACCOUNT_LIVE_SYNC_DISABLED` is fixed by flipping a PER-ACCOUNT
 * switch in Admin → Users, and none of the seven efforts describes that: `restart`
 * would tell an operator to bounce a container for a setting that applies at once,
 * and `none` ("Not fixable here") would be flatly false for something fixable two
 * clicks away. The chip can only carry one fact and a wrong one is worse than
 * none, so the location goes in the finding's own prose instead. The same reasoning
 * covers the collaboration switch. An `account-setting` effort would fix both, and
 * `diagnosticRemedies.ts` is not this module's to edit.
 */
const ON_THIS_DEVICE: RemedyEffort = 'device'

function remedyForSignedOut(): Remedy {
  return {
    code: 'ACCOUNT_SIGNED_OUT',
    summary:
      'There is no account session in this client, so nothing can sync and nothing on this screen that comes from the server can be filled in. Sign in.',
    steps: [
      'Sign in. Until then every note stays in this browser only, and every server-sourced section of this pane is empty because the request was never made rather than because anything is broken.',
      'If sign-in appears to succeed and this row stays signed out, read the Browser section: blocked cookies make a session impossible to hold, and that failure is silent on both sides.',
    ],
    effort: ON_THIS_DEVICE,
    basis: 'verified',
    because: [
      'This client holds no session for an account, which is a local fact and the one precondition everything else in this pane rests on.',
    ],
  }
}

function remedyForRefusedAdminRole(): Remedy {
  return {
    code: 'ADMIN_ROLE_NOT_ON_SESSION',
    summary:
      'The server authenticated this session and then refused it on the admin role. Grant the role to the account, then sign out and back in — an existing session keeps the roles it was issued with.',
    steps: [
      'Sign out and back in. If the role was granted after this session was issued, that is the whole fix: role claims are stamped into a session when it is created and are not re-read afterwards.',
      'If that does not clear it, the account genuinely does not hold the admin role. Grant it from another admin account, then sign out and back in on this one.',
      'Do not go looking for a configuration problem. The request reached the server, authenticated, and was refused on authorization — which is a fact about this account, not about the deployment.',
    ],
    effort: ON_THIS_DEVICE,
    basis: 'verified',
    because: [
      'The admin-gated endpoint answered 403, which it does only after the request has authenticated and only when the requestor does not hold the admin role.',
      'A 401 would have meant the opposite and is reported separately, because the role check never runs on one.',
    ],
  }
}

function remedyForFileQuota(exhausted: boolean): Remedy {
  return {
    code: 'ACCOUNT_FILE_QUOTA_NEARLY_FULL',
    summary: exhausted
      ? 'This account is at or over its server file allowance, so the files server refuses new uploads. Note syncing is unaffected, which is why this presents as attachments failing and nothing else.'
      : 'This account is close to its server file allowance. Uploads start being refused at the ceiling, and nothing else changes when they do.',
    steps: [
      'Delete attachments this account no longer needs, or move them off the server. Usage is measured against uploaded file bytes, not against note content.',
      'Raise the allowance from Admin → Users for this account. It is a per-account subscription setting, so it applies immediately with no restart; -1 is the only value the files server treats as unlimited.',
      exhausted
        ? 'Expect uploads to fail outright until usage drops below the allowance. Existing files stay readable, and nothing already uploaded is at risk.'
        : 'There is still room, so nothing is failing yet. This is the row that gives a warning before the first refused upload rather than after it.',
    ],
    effort: ON_THIS_DEVICE,
    basis: 'verified',
    because: [
      exhausted
        ? 'The reported used bytes are at or above the reported limit for this account.'
        : `The reported used bytes are at or above ${Math.round(FILE_QUOTA_NEAR_FRACTION * 100)}% of the reported limit for this account.`,
      'Both figures are reported as a bucket and whole megabytes: the diagnosis needs the magnitude, and the exact size of one person’s files is not this report’s to disclose.',
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 1: who this session is, and what it may do                          */
/* -------------------------------------------------------------------------- */

const ADMIN_ROLE_NOTE =
  'The server’s own answer, taken from this pane’s own request rather than from a probe invented for the row. A 403 is conclusive: the request authenticated and was then refused on the role. A 401 is NOT evidence about the role at all — the cross-service-token middleware runs before the role check, so the check never happened — and this row reports that as undetermined rather than as a refusal. Confusing the two is the single most common dead end in this area.'

function buildAccessBlock(observed: AccountObservations, reading: AdminReading): DiagnosticBlock {
  const roles = observed.roles
  const held = (role: AccountRole): boolean | undefined => {
    return roles === undefined ? undefined : roles.some((candidate) => candidate === role)
  }
  const unrecognisedRoles = unrecognisedRoleCount(roles)

  const subscription = describeSubscription(observed)
  const endsIn = observed.subscriptionEndsInSeconds

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Signed in'),
      value: safeState(observed.signedIn, 'signed in', 'signed out'),
      ...absentOr(observed.signedIn, observed.signedIn === true ? 'healthy' : 'broken'),
      note: 'A LOCAL fact: this client holds a session object. It is deliberately not the same row as "a session the server accepts" in the requirements block below, because a session can be held locally and rejected on every request — which is exactly what a 401 means and what this row cannot see.',
    }),
    observedRow({
      label: safeConstant('First-party server'),
      observed: observed.firstPartyServer,
      value: safeYesNo(observed.firstPartyServer),
      verdict: 'informational',
      note: 'Whether this account is signed into a first-party Standard Notes server. Context rather than a verdict: on anything else the subscription and file-allowance rows below cannot be read at all, so "no" here EXPLAINS blank quota rows instead of being a fault in its own right.',
    }),
    diagnosticRow({
      label: safeConstant('Admin role, as this client sees it'),
      value: safeState(observed.clientBelievesAdmin, 'believed held', 'not believed held'),
      verdict:
        observed.clientBelievesAdmin === true
          ? 'healthy'
          : observed.clientBelievesAdmin === false
            ? 'broken'
            : 'undetermined',
      evidence:
        observed.clientBelievesAdmin === undefined
          ? EVIDENCE_ABSENT
          : evidenceProxy({
              observed: "this client's own cached role list",
              cannotConfirm: 'the roles the session carries on the server',
              necessaryCondition: false,
            }),
      note: 'Capped in BOTH directions on purpose, and the clearest example in this section of why. The client’s list and the session’s server-side claims can disagree each way — a role granted after this session was issued is absent from the session, and a role cached here can have been revoked — so neither reading establishes the other. The row below is the one that actually asks the server.',
    }),
    readingRow({
      label: safeConstant('Admin role, as the server answered'),
      reading: ROLE_READING[reading],
      note: ADMIN_ROLE_NOTE,
    }),
  ]

  for (const role of ACCOUNT_ROLES) {
    rows.push(
      observedRow({
        label: ROLE_LABEL[role],
        observed: held(role),
        value: safeState(held(role), 'held', 'not held'),
        verdict: 'informational',
        note: ROLE_NOTE[role],
      }),
    )
  }

  rows.push(
    diagnosticRow({
      label: safeConstant('Roles outside this build’s taxonomy'),
      value: safeCount(unrecognisedRoles),
      ...absentOr(unrecognisedRoles, 'informational'),
      note: 'Counted, never printed. A role name is a closed enum only while it is one of the four above; anything else is a server-supplied string of unknown content, and this section is the one place in the pane where such a string could be an identifier. A newer server’s legitimate new role therefore shows up here as a number rather than disappearing.',
    }),
    diagnosticRow({
      label: safeConstant('Subscription'),
      value: subscription === undefined ? safePresence(undefined) : SUBSCRIPTION_VALUE[subscription],
      ...absentOr(subscription, subscription === 'expired' ? 'degraded' : 'informational'),
      note: 'A STATE, never an identifier. "none" is not a fault: this fork is single-tier and entitles every feature, so no subscription is the ordinary state of a self-hosted account and the only thing it changes is the file allowance. "ended" is reported as degraded because it is the state in which a previously granted allowance can have gone away under this account’s feet.',
    }),
    observedRow({
      label: safeConstant('Subscription plan'),
      observed: observed.subscriptionPlan,
      value: safeEnum(observed.subscriptionPlan, SUBSCRIPTION_PLANS),
      verdict: 'informational',
      note: 'Admitted against the three plans this build knows and collapsed to a constant otherwise, so a plan field carrying anything else — including an identifier — is refused rather than printed. The subscription’s own id is never collected by this section at all.',
    }),
    diagnosticRow({
      label: safeConstant('Time until the subscription ends'),
      value:
        typeof endsIn === 'number' && Number.isFinite(endsIn) && endsIn <= 0
          ? safeConstant('already ended')
          : safeDuration(endsIn),
      ...absentOr(endsIn, 'informational'),
      note: 'How long is left, not when it ends. A duration answers the question; an expiry instant would additionally pin this account to a purchase date in a report written to be pasted in public.',
    }),
  )

  const findings: DiagnosticFinding[] = []

  if (reading === 'refused-403') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ADMIN_ROLE_NOT_ON_SESSION'),
        title: 'This session does not carry the admin role',
        detail:
          'The admin-gated endpoint answered 403, which happens only after the request has authenticated. So the session is fine and the ROLE is missing from it — most often because the role was granted after this session was issued, and a session keeps the role claims it was created with. This is also why most of this pane is empty: the facts it reports were never returned.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForRefusedAdminRole(),
      }),
    )
  }

  return {
    heading: safeConstant('Account and access'),
    description:
      'Who this session is and what it is entitled to. No e-mail address, account id, session id, device id or IP address is collected here or anywhere else in this section — an identifier is not a diagnosis, and this is the one section of the pane where the subject is a person.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 2: space, measured                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Measurements only, and no verdict anywhere in this block.
 *
 * The headroom VERDICT and its finding live in the requirements block, where the
 * consequence can be stated once. Splitting it this way is deliberate: a section
 * that reports the same quota twice — once as a measurement with a tone and once as
 * a requirement with a tone — reads as two problems, which is how a panel loses a
 * reader who is counting findings.
 */
function buildSpaceBlock(observed: AccountObservations): DiagnosticBlock {
  const fraction = fileQuotaFraction(observed.fileUploadBytesUsed, observed.fileUploadBytesLimit)
  const state = describeFileQuota(observed.fileUploadBytesUsed, observed.fileUploadBytesLimit)
  const usedMb = wholeMegabytes(observed.fileUploadBytesUsed)
  const limitMb = wholeMegabytes(observed.fileUploadBytesLimit)

  const cap = observed.localSoftCapBytes
  const capSet = cap === undefined ? undefined : cap > 0
  const overCap =
    cap === undefined || cap <= 0 || observed.localUsageBytes === undefined ? undefined : observed.localUsageBytes > cap

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Server file allowance used'),
      value:
        state === 'unlimited'
          ? FILE_QUOTA_VALUE.unlimited
          : state === 'no-allowance'
            ? FILE_QUOTA_VALUE['no-allowance']
            : safePercentBucket(fraction),
      ...absentOr(state, 'informational'),
      note: 'The share of this account’s uploaded-file allowance in use, as a bucket. A bucket rather than a figure because the bucket answers the question — is an upload about to be refused — and the exact size of one person’s files is not something a pasted report should carry.',
    }),
    diagnosticRow({
      label: safeConstant('Server file allowance, whole MB'),
      value: observed.fileUploadBytesLimit === -1 ? FILE_QUOTA_VALUE.unlimited : safeCount(limitMb),
      ...absentOr(observed.fileUploadBytesLimit, 'informational'),
      note: 'Rounded down, so 0 means under one megabyte rather than unset. -1 is the ONLY value the files server treats as unlimited and is printed as such; 0 is an allowance of nothing and refuses every upload, which is a different answer from no limit and is never merged with it.',
    }),
    diagnosticRow({
      label: safeConstant('Server file bytes used, whole MB'),
      value: safeCount(usedMb),
      ...absentOr(observed.fileUploadBytesUsed, 'informational'),
      note: 'Uploaded file bytes for this account, rounded down to whole megabytes. Note content is not counted here, which is why a large vault with no attachments reads 0.',
    }),
    diagnosticRow({
      label: safeConstant('Local usage soft cap'),
      value: safeState(capSet, 'set', 'no cap'),
      ...absentOr(capSet, 'informational'),
      note: 'The user’s OWN advisory cap on local storage (Preferences → Storage), where 0 means unlimited. It is not a quota and the browser does not know about it. The origin’s real quota and the eviction risk that comes with it are the Browser section’s, and are not restated here.',
    }),
    diagnosticRow({
      label: safeConstant('Local usage against the soft cap'),
      value: safeState(overCap, 'over the cap', 'within the cap'),
      ...absentOr(overCap, 'informational'),
      note: 'ADVISORY, and informational even when it reads over: this cap NEVER blocks a save or a sync. It exists so a user who set a budget hears about it, and a row that gave it a tone would read as a fault and send someone looking for a failure that cannot happen.',
    }),
  ]

  /**
   * *** AN EMPTY SPACE BLOCK IS A FACT, AND THERE ARE TWO OF THEM. ***
   *
   * Every row here read "not reported" on every deployment, and the cause was a
   * WIRING GAP: the tab supplied no space fields at all. That is now fixed, so the
   * emptiness has become informative rather than constant — which is the only
   * condition under which distinguishing its two kinds is worth anything.
   *
   * A CORRECTION IS RECORDED HERE RATHER THAN QUIETLY DROPPED, because it is the
   * kind of attribution that gets re-derived from memory by the next reader. This
   * emptiness was briefly believed to be the visible trace of a broken files
   * subsystem — an operator whose listing aborted, whose downloads hung and whose
   * usage read 0 B. It was not. Their 0 B came from an unrelated defect in the
   * account's own quota pane, where an unread server reading fell through to a
   * `useState(0)` initial value; this block was empty on every deployment, working
   * or not, and so could not have been evidence about any of them. The DISTINCTION
   * below still earns its place — a read that failed and a read nobody attempted
   * must not render alike, for the same reason a collection must not answer `[]` to
   * both "none" and "not read yet" — but it is not a files-lane signal and must not
   * be read as one.
   *
   * Emitted only when no server figure arrived at all. One figure present means the
   * read worked and the rows above carry it.
   */
  const serverFiguresAbsent = observed.fileUploadBytesUsed === undefined && observed.fileUploadBytesLimit === undefined

  const findings: DiagnosticFinding[] = []

  if (serverFiguresAbsent && observed.spaceFigureSource === 'read-and-failed') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SPACE_READ_FAILED'),
        title: 'This account’s space figures were asked for and did not arrive',
        detail:
          'The rows above are empty because the read FAILED, not because this build does not look. These two numbers are per-account SETTINGS served by the auth service, so a read that will not produce them points at the session or at auth — not at the files service, which neither stores nor serves them. Do not read this as evidence about attachments: a deployment whose file transfers are completely broken reports these figures perfectly, and a deployment that cannot report them may transfer files without trouble. If attachments are the symptom, the files rows in the Database & internal comms section are the place, together with the finding there saying that nothing on that screen establishes an authorized transfer.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  // `not-attempted` EXPLICITLY, never an absent field. Absent means the caller did
  // not say which kind of empty this is, and inventing "nobody asked" from silence
  // would be this block making the same absent-is-false mistake it exists to flag —
  // on a model where nothing at all was observed, which is the one case that must
  // claim nothing.
  if (serverFiguresAbsent && observed.spaceFigureSource === 'not-attempted') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SPACE_NOT_READ'),
        title: 'This caller did not ask for this account’s own space figures',
        detail:
          'The rows above are empty because nothing asked, and that is said here rather than left to look like a quiet deployment with nothing stored. It is a gap in the CALLER, not in the deployment, and it is no longer the state the diagnostics tab is in: it reads both figures from the requesting session’s own subscription settings, which carry no account identifier in either direction. A model built without them — a test, or a future caller — reports this instead of a figure it never looked for. Treat the Space rows as unread, never as zero.',
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
      }),
    )
  }

  return {
    heading: safeConstant('Space'),
    description:
      'What room this ACCOUNT has, which is a different number with a different failure from the browser’s own quota: this one refuses uploads at the server, that one evicts the local database. Every row here is a measurement; the verdict about whether an upload will succeed is one row, in the requirements block below.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 3: what must be true for this user, right now                       */
/* -------------------------------------------------------------------------- */

const LIVE_SYNC_NOTE =
  'The per-account Live sync switch (LIVE_SYNC_ENABLED), which an administrator can turn off for ONE account on a deployment that is otherwise perfect. No endpoint lets a client read its own flags, so this build asks for the effective value and, until a server sends one, the only evidence available is the transport being refused with the LIVE_SYNC_DISABLED code — which is conclusive when it happens and silent when it does not. What breaks while it is off: note syncing for this account stays on HTTP. Invites, API RPC, collaboration and files are unaffected, which is what makes it so easy to misread as a broken deployment.'

function buildRequirementsBlock(observed: AccountObservations, reading: AdminReading): DiagnosticBlock {
  const state = describeFileQuota(observed.fileUploadBytesUsed, observed.fileUploadBytesLimit)
  const exhausted = state === 'exhausted' || state === 'no-allowance'
  const quotaPressure = exhausted || state === 'nearly-full'

  const liveSyncFlag = observed.liveSyncEnabledForAccount
  const liveSyncRefused = observed.fallbackReason === 'live-sync-disabled'
  const unconsumable = unconsumableOperationCount(observed.serverOperations)

  const rows: DiagnosticRow[] = [
    readingRow({
      label: safeConstant('A session the server accepts'),
      reading: SESSION_READING[reading],
      note: 'Not the same row as "Signed in" above, and the difference is the whole point: that one says this client HOLDS a session, this one says the server took it. A 401 proves it did not, and proves nothing about the role. A 403 proves it DID — the request authenticated and was then refused on authorization — so this row reads healthy on the same status the role row reads broken on. What breaks when this fails: every request, including every other section of this pane. One mechanism worth knowing here: an admin request can travel over the websocket API_RPC lane, whose session credential is captured once when the socket ticket is minted and never refreshed, so a session renewed since the socket connected can be refused there while plain HTTP still succeeds. The lane itself is the WebSocket section’s subject.',
    }),
    diagnosticRow({
      label: safeConstant('Room for a file upload'),
      value: state === undefined ? safePresence(undefined) : FILE_QUOTA_VALUE[state],
      ...absentOr(state, exhausted ? 'broken' : state === 'nearly-full' ? 'degraded' : 'healthy'),
      note: 'The one verdict about the figures in the Space block above. What breaks when this fails: the files server refuses new uploads for this account, with existing files still readable and note syncing entirely unaffected — so the symptom is attachments failing and nothing else, which is why it is so often chased on the transport first. An allowance of nothing ("no allowance granted") refuses every upload and is reported as broken rather than as an absent limit.',
    }),
    diagnosticRow({
      label: safeConstant('Live sync for this account'),
      value:
        liveSyncFlag !== undefined
          ? safeState(liveSyncFlag, 'enabled', 'disabled')
          : liveSyncRefused
            ? safeConstant('disabled (refused on the sync lane)')
            : safePresence(undefined),
      verdict:
        liveSyncFlag === true ? 'healthy' : liveSyncFlag === false || liveSyncRefused ? 'broken' : 'undetermined',
      evidence: liveSyncFlag !== undefined || liveSyncRefused ? EVIDENCE_DIRECT : EVIDENCE_ABSENT,
      note: LIVE_SYNC_NOTE,
    }),
    diagnosticRow({
      label: safeConstant('Collaboration permitted for this account'),
      value: safeState(observed.collaborationEnabledForAccount, 'enabled', 'disabled'),
      ...absentOr(
        observed.collaborationEnabledForAccount,
        observed.collaborationEnabledForAccount === true ? 'healthy' : 'broken',
      ),
      note: 'The per-account COLLABORATION_ENABLED switch, asked for and not yet sent by any server, so this reads "not reported" rather than being left out. What breaks while it is off: shared vaults and collaborative editing are refused for this account alone. It is a DIFFERENT fact from the client-side entitlement row below — one is the server permitting it, the other is this client offering it — and either alone is enough to make collaboration not work.',
    }),
    diagnosticRow({
      label: safeConstant('Shared vaults offered by this client'),
      value: safeState(observed.entitledToSharedVaults, 'entitled', 'not entitled'),
      ...absentOr(observed.entitledToSharedVaults, 'informational'),
      note: 'The gate THIS CLIENT applies before it offers shared vaults at all, read directly. Informational on purpose: on this single-tier fork a great many perfectly healthy accounts are not entitled, and a tone here would raise an alarm for all of them. What it costs when it reads "not entitled": the shared-vault and collaboration surfaces are not offered in this client, whatever the deployment permits.',
    }),
    diagnosticRow({
      label: safeConstant('Operations this client cannot consume'),
      value: safeCount(unconsumable),
      ...absentOr(unconsumable, unconsumable !== undefined && unconsumable > 0 ? 'degraded' : 'healthy'),
      note: 'Advertised operations this client build has no handler for, counted and never named — an operation this build does not recognise is outside every closed set it owns, so its name is a string of unknown content. What breaks when this is non-zero: nothing on the server can help, and historically it was worse than one missing feature — an unrecognised operation in a handshake used to drop sync, collaboration, RPC and invites to HTTP together. Which operations were in fact NEGOTIATED is the WebSocket section’s table and is not restated here.',
    }),
    diagnosticRow({
      label: safeConstant('Server sync protocol version'),
      value: safeCount(observed.protocolVersion),
      ...absentOr(observed.protocolVersion, 'informational'),
      note: 'Context for the row above, and nothing more. A version this client does not expect does not by itself break anything; the count of operations it cannot consume is the fact with a consequence.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (observed.signedIn === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SIGNED_OUT'),
        title: 'There is no account session in this client',
        detail:
          'Nothing syncs, no file can be reached, and every server-sourced section of this pane is empty because the request was never made. Read the rest of this pane with that in mind: their verdicts describe an absent session, not a broken deployment.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForSignedOut(),
      }),
    )
  }

  if (quotaPressure) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_FILE_QUOTA_NEARLY_FULL'),
        title: exhausted
          ? 'This account has no room left for file uploads'
          : 'This account is close to its file allowance',
        detail: exhausted
          ? 'Uploads are refused at the server for this account. Nothing already uploaded is at risk and note syncing is untouched, so the only symptom is that attachments fail — which is routinely diagnosed as a transport fault because every other row on every other screen reads healthy.'
          : 'There is still room, so nothing is failing yet. This finding exists to arrive BEFORE the first refused upload rather than after it, which is the only time the fix is cheap.',
        verdict: exhausted ? 'broken' : 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForFileQuota(exhausted),
      }),
    )
  }

  if (liveSyncFlag === false || liveSyncRefused) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_LIVE_SYNC_DISABLED'),
        title: 'Live sync is turned off for this account',
        detail:
          'This is not a misconfiguration and not a fault: an administrator turned this account’s Live sync switch off, so note syncing for this ONE account stays on HTTP while invites, API RPC, collaboration and files keep using the socket. Turn it back on from Admin → Users → Live sync (LIVE_SYNC_ENABLED) for this account; it is a per-account setting and applies immediately, with no restart. No remedy chip is attached on purpose — none of the available efforts describes a per-account switch, and a chip reading "Config + restart" or "Not fixable here" would both be wrong.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
      }),
    )
  }

  if (unconsumable !== undefined && unconsumable > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('CLIENT_GAP'),
        title: 'The server advertises operations this client build cannot consume',
        detail:
          'The two lists disagree in the direction only a client release can close. The operations themselves are counted rather than named: this build has no handler for them, which means it has no closed set they belong to and no way to vouch for what their names contain.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForClientGap(['the operations counted in the row above']),
      }),
    )
  }

  return {
    heading: safeConstant('General requirements to be working'),
    description:
      'What must be true for THIS user, on THIS machine, right now — and for each row, what breaks when it is false. A row that cannot name a consequence does not belong here, which is why the deployment’s own preconditions are not repeated: those are the Environment and WebSocket sections’, and an operator cannot act on them from an account screen.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The withholdings, stated in the report itself.
 *
 * A reader of a pasted report cannot otherwise tell "not collected" from "not
 * disclosed", and the difference matters here more than anywhere else in the pane:
 * someone deciding whether this report is safe to paste needs to know that the
 * identifiers were never gathered rather than merely omitted from a line.
 */
const REPORT_NO_IDENTIFIERS = reportLine(
  safeConstant('Account identifiers'),
  safeConstant(
    'never collected by this section: e-mail address, account id, session id, device id, client IP address and subscription id',
  ),
)

const REPORT_BYTES_REDUCED = reportLine(
  safeConstant('Byte figures'),
  safeConstant('reduced to closed buckets and whole megabytes before they are reported'),
)

const REPORT_ACCOUNT_FLAGS = reportLine(
  safeConstant('Per-account feature flags'),
  safeConstant('not reported by any server build; only a refusal observed on the sync lane evidences them'),
)

/**
 * Build the Account, space & requirements section.
 *
 * Pure and synchronous. Every input is optional and an absent one produces rows
 * reading "not reported" on absent evidence rather than a negative verdict, which
 * is the contract's third rule holding by construction rather than by remembering
 * to write it. No request is made to fill a row: the two readings this section
 * needs — the admin endpoint's own answer and the transport's refusal code — are
 * things the pane already has.
 */
export function buildAccountSection(input: AccountSectionInput = {}): SectionModel {
  const observed = input.observations ?? {}
  const reading = describeAdminReading(input.adminAccess)
  const outcomes = outcomesForSection(input.outcomes ?? [], 'account')

  const blocks: DiagnosticBlock[] = [
    buildAccessBlock(observed, reading),
    buildSpaceBlock(observed),
    buildRequirementsBlock(observed, reading),
  ]

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
    id: 'account',
    blocks,
    extraReportLines: [REPORT_NO_IDENTIFIERS, REPORT_BYTES_REDUCED, REPORT_ACCOUNT_FLAGS],
  })
}
