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
 *     server-side TOTAL — the item payload plus the uploaded files — which is a
 *     different number with a different failure. One local figure does appear in
 *     the Space block, the origin's own usage in whole megabytes, and it is here
 *     rather than there for one reason: it is the only thing the user's advisory
 *     soft cap is about, and that cap is this section's. The origin's QUOTA and
 *     the eviction risk that comes with it stay with the Browser section and are
 *     not restated.
 *   - Deployment configuration and identity are **Environment & setup**'s.
 *   - The database and internal transport are **Database & internal comms**'.
 *
 * -------------------------------------------------------------------------------
 * 4. Two fields this build said no server sends, and one of them was never true.
 * -------------------------------------------------------------------------------
 *
 * *** THE ENDPOINT EXISTED ALL ALONG. *** The per-account feature flags —
 * `LIVE_SYNC_ENABLED` and `COLLABORATION_ENABLED` — are written by the admin
 * Users tab, and this module recorded that "there is NO endpoint through which a
 * client can read its OWN effective flags", so both rows printed the structural
 * constant reserved for a field with no producer at all. There is one:
 * `GET /v1/admin/users/:userUuid/feature-flags` answers both, and the admin Users
 * tab has always read it. The gap was CLIENT WIRING, and a row that says "nothing
 * publishes this" about a surface that does publish it is worse than an empty row:
 * it closes the question.
 *
 * Three things follow from how that endpoint behaves, and each is a state here
 * rather than a branch:
 *
 *   - It is ADMIN-GATED, and answers 403 to everyone else. A non-admin session
 *     cannot read its own flags, and that is not a fault in the deployment, the
 *     account or the pane — so it has its own reading and its own wording, and
 *     claims no verdict.
 *   - An UNSET flag is reported as `null` and the server reads that as ENABLED
 *     (`CreateCrossServiceToken.readGatingFlag`: absent is `true`, only the
 *     literal string `'false'` disables). So the caller resolves the effective
 *     boolean and this module never sees a null; "absent" here means the READ did
 *     not happen or did not land, never "the flag is unset".
 *   - The `live-sync-disabled` refusal on the transport is still read, and is
 *     still the only evidence available to a non-admin session. It is conclusive
 *     when it happens and silent when it does not, so it is a fallback beneath the
 *     flag rather than a substitute for it.
 *
 * NO IDENTIFIER ENTERS THIS MODULE TO MAKE THAT WORK. The endpoint is addressed by
 * user uuid, exactly like the subscription-setting reads the Space block uses, and
 * exactly like those the uuid lives in the CALLER's request path. What crosses this
 * boundary is two booleans and one closed reading.
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

/**
 * WHERE the reported file allowance came from, as a closed set.
 *
 * *** AN ALLOWANCE AND A DECISION ARE NOT THE SAME THING. ***
 *
 * `FILE_UPLOAD_BYTES_LIMIT` legitimately has no row on most accounts, and the
 * absence never meant "no allowance": `CreateValetToken` falls back to the plan
 * default when it mints an upload token, and to unlimited (`-1`) when there is no
 * live subscription at all. The server now answers that EFFECTIVE figure rather
 * than nothing, which is the only reason the headroom row can resolve — and the
 * figure alone would then be unreadable, because "100 GB because somebody chose
 * 100 GB" and "100 GB because that is what the plan happens to default to" are
 * the same number and different facts. One is a decision an operator can audit;
 * the other is a default nobody has looked at.
 *
 * So the value and its provenance are reported as two rows. The provenance is the
 * SERVER's enum and is admitted against this tuple rather than printed, exactly
 * like the role and plan names: an unrecognised origin — or an identifier arriving
 * in the wrong field — collapses to a constant without echoing a byte.
 */
export const FILE_ALLOWANCE_ORIGINS = ['account-setting', 'plan-default', 'no-active-subscription'] as const

export type FileAllowanceOrigin = (typeof FILE_ALLOWANCE_ORIGINS)[number]

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
 * `read-threw` — the request did not complete, or completed as an error this
 * client re-threw. The emptiness is then a SYMPTOM, and the thing it is a symptom
 * of is the subject.
 * `read-carried-no-figure` — the request COMPLETED and the server carried no
 * figure. That is an ordinary answer on this fork and is not, on its own, a fault.
 *
 * *** WHY THE THIRD VALUE EXISTS, AND WHAT IT COST NOT TO HAVE IT. ***
 *
 * This set had two members and the previous comment here said a third was "already
 * foreseeable — a read that succeeded and returned nothing". It was not foreseeable;
 * it was already the commonest reading in the fleet, and folding it into
 * `read-and-failed` made `ACCOUNT_SPACE_READ_FAILED` fire `broken` over it. Three
 * things in this repo produce it, none of them a fault:
 *
 *   - `FILE_UPLOAD_BYTES_USED` is written by the auth worker only on a SUCCESSFUL
 *     upload. An account that has never uploaded a file has no such row, the
 *     subscription-setting read answers 400, and `SettingsGateway` maps 400 to
 *     `undefined` rather than throwing. A brand-new account therefore read `broken`.
 *   - With no subscription row at all, auth's `getSubscriptionSetting` answers
 *     `200 {success: true, setting: undefined}` on purpose — its own comment says
 *     "In the single-tier, fully-free model there is no real subscription row … so
 *     clients treat it as 'no usage data' rather than surfacing a request error".
 *     This pane then rated that deliberate design as a broken deployment.
 *   - An absent LIMIT is not an absent allowance either: `CreateValetToken` falls
 *     back to the plan default when the setting is missing, so nothing is refused.
 *     That one is no longer a reason for an empty row — the server derives the
 *     EFFECTIVE allowance and the rows report it with its provenance — but it is
 *     recorded here because it is why the row must never have been read as "no
 *     allowance", and because a server that predates the derivation still answers
 *     nothing and gets its own finding rather than an alarm.
 *
 * A thrown read is still a real failure and still reads `broken`. What separates
 * them is whether an answer arrived, which is a fact the caller has and this module
 * cannot re-derive — exactly like `not-attempted` and for the same reason.
 */
export const SPACE_FIGURE_SOURCES = ['not-attempted', 'read-threw', 'read-carried-no-figure'] as const

/**
 * What happened to the read of this account's own STORED ITEM BYTES, as a closed
 * set.
 *
 * *** THE ROW THIS FIELD EXISTS FOR IS THE OPERATOR'S ACTUAL COMPLAINT. *** The
 * Space block reported uploaded-FILE bytes and nothing else, so an account whose
 * storage is ten thousand notes and no attachments read "0 MB" — or, more often,
 * nothing at all. Notes are the storage. The server now answers them from
 * `GET /v1/items/storage-usage`, and this set is why an empty row still says
 * something.
 *
 * `not-attempted` — nothing in this build asked. A gap in the CALLER.
 * `endpoint-absent` — the request completed as a 404. That is a SERVER too old to
 * carry the endpoint, which is a real and common state while a fleet is being
 * upgraded and is not a fault in the deployment that is running.
 * `read-threw` — no answer arrived, or one arrived as an error. A symptom.
 * `reported` — the figure is in hand. The rows carry it.
 *
 * `endpoint-absent` is kept apart from `read-threw` for the same reason
 * `read-carried-no-figure` is kept apart from it above: "this build does not have
 * it yet" and "this deployment is failing" send an operator to two completely
 * different places, and merging them sends half of them to the wrong one.
 */
export const ITEM_USAGE_READINGS = ['not-attempted', 'endpoint-absent', 'read-threw', 'reported'] as const

export type ItemUsageReading = (typeof ITEM_USAGE_READINGS)[number]

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What the item-bytes row prints when no
 * figure arrived, and whether that is a claim about anything.
 *
 * Every member reads as an absence, never as a zero: not one of these states
 * establishes that the account stores nothing, and a `0` here would be the single
 * most misleading value this block could print — it is the answer the operator
 * was already given by a pane that was not measuring notes at all.
 */
const ITEM_USAGE_ABSENCE: Record<ItemUsageReading, SafeValue> = {
  'not-attempted': safeConstant('not read by this caller'),
  'endpoint-absent': safeConstant('not answered by this server build'),
  'read-threw': safeConstant('the read did not arrive'),
  reported: safeConstant('not reported'),
}

/**
 * WHICH HALVES of this account's storage the published total actually contains,
 * as a closed set.
 *
 * A total is only worth printing beside a statement of what it covers, because
 * the two halves come from two different services and either can be missing while
 * the other is perfect.
 *
 * `items-and-files` — both measured from a server figure. The complete answer.
 * `items-and-no-files` — the item total is measured and this account holds NO
 *   file, so the file half contributes nothing. It is derived from the census and
 *   from a server that ANSWERED carrying no usage figure, never from a file read
 *   that merely failed: the first establishes that there is nothing to count, the
 *   second establishes nothing at all.
 * `items-only` — the item total is measured and the file total is NOT established.
 *   The figure is a FLOOR and the row says so; it is still published because an
 *   account's note payload is the larger half for most people and withholding it
 *   over a missing attachment figure reports nothing twice.
 *
 * There is deliberately no `files-only`: a total that omits the item half is not
 * a total of anything, and the item rows above already say why it is absent.
 */
export const STORAGE_TOTAL_COVERAGE = ['items-and-files', 'items-and-no-files', 'items-only'] as const

export type StorageTotalCoverage = (typeof STORAGE_TOTAL_COVERAGE)[number]

export type SpaceFigureSource = (typeof SPACE_FIGURE_SOURCES)[number]

/**
 * What happened to the per-account feature-flag read, as a closed set.
 *
 * *** THE SECOND MEMBER IS THE ONE THAT MATTERS. *** The endpoint is admin-gated,
 * so a perfectly healthy non-admin session simply cannot read its own flags. That
 * emptiness is a property of the SURFACE, not of the account or the deployment,
 * and rendering it the same way as a failed read would send an ordinary user
 * looking for a fault that does not exist.
 *
 * `read-carried-no-flags` is kept apart from `read-threw` for the same reason the
 * Space block keeps them apart: an answer that arrived carrying nothing is a
 * server that does not publish the field, and a request that never completed is a
 * symptom. Only the second is a failure.
 */
export const ACCOUNT_FLAG_READINGS = ['not-attempted', 'admin-required', 'read-threw', 'read-carried-no-flags'] as const

export type AccountFlagReading = (typeof ACCOUNT_FLAG_READINGS)[number]

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What a flag row prints when no flag
 * arrived, and whether that is a claim about anything.
 *
 * Every member reads `undetermined` with absent evidence: not one of these states
 * establishes whether the flag is on, and the difference between them is WHY the
 * row is empty — which is what the operator needs in order to know whether to do
 * anything about it.
 */
const ACCOUNT_FLAG_ABSENCE: Record<AccountFlagReading, SafeValue> = {
  'not-attempted': safeConstant('not read by this caller'),
  'admin-required': safeConstant('readable only by an admin session'),
  'read-threw': safeConstant('the read did not arrive'),
  'read-carried-no-flags': safeConstant('not reported'),
}

/**
 * Whether this ACCOUNT has any uploaded file, as a closed set — the signal that
 * turns "no usage figure" from an alarm into a statement of fact.
 *
 * `present` — at least one file item exists, so an upload has succeeded. A server
 * with no usage figure for such an account has lost the bookkeeping.
 * `none` — the local item collection finished loading and holds no file item. There
 * is nothing for the server to have a figure about.
 * `not-loaded` — the local database has not finished loading. An empty collection
 * establishes NOTHING here and must never be read as `none`.
 *
 * *** THE THIRD MEMBER IS THE WHOLE POINT. *** A collection answering `[]` for both
 * "none" and "not read yet" is a trap this repo has already been caught by, and
 * `[]` is what `items` answers for the entire window between launch and the cold
 * load completing. The caller reads `sync.isDatabaseLoaded()` — which flips only
 * after the cold load's own completeness check — and sends `not-loaded` until it
 * is true, so this module never has to guess which `[]` it was handed.
 *
 * A STATE, never a count: the number of files in one person's vault is a fact about
 * that person, the diagnosis needs only "any or none", and a set with three members
 * cannot be made to carry a quantity later by accident.
 */
export const ACCOUNT_FILE_CENSUS = ['present', 'none', 'not-loaded'] as const

export type AccountFileCensus = (typeof ACCOUNT_FILE_CENSUS)[number]

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
  /**
   * The bytes of SYNCED ITEM payload this account holds on the server, from
   * `GET /v1/items/storage-usage`. A capacity fact and the larger half of most
   * accounts' storage.
   *
   * DERIVED SERVER-SIDE from `items.content_size` at read time — not a counter
   * kept beside the items, so there is nothing to drift. Absent means the read did
   * not produce one, and `itemUsageReading` says why; it NEVER means zero. A
   * measured zero arrives as `0` and is a figure.
   */
  itemBytesUsed?: number
  /**
   * Whether `itemBytesUsed` covers EVERY item this account holds.
   *
   * `items.content_size` is nullable — it was added by migration over a table that
   * already had rows — so an account can hold items whose size was never recorded.
   * The server counts those separately and the caller reduces the count to this
   * boolean, because the number of unmeasured items is a fact about the size of
   * one person's vault and the diagnosis needs only "is the figure whole".
   * `false` makes the total a FLOOR, which the block says out loud rather than
   * printing a number that is quietly too small.
   */
  itemBytesComplete?: boolean
  /**
   * WHY `itemBytesUsed` is absent, when it is, as one of `ITEM_USAGE_READINGS`.
   *
   * Typed wide so an unrecognised value collapses through `safeEnum` rather than
   * printing, exactly like the census, plan and allowance-origin fields. Absent
   * means not even this is known.
   */
  itemUsageReading?: string
  /**
   * WHERE `fileUploadBytesLimit` came from, as one of `FILE_ALLOWANCE_ORIGINS`.
   *
   * Typed wide so an unrecognised value collapses through `safeEnum` rather than
   * printing, exactly like the role, plan and census fields. Absent means the
   * server did not say — which every server before the effective-allowance answer
   * does, and which is reported as such rather than guessed at.
   */
  fileAllowanceOrigin?: string
  /**
   * Local origin bytes in use, from `navigator.storage.estimate().usage`.
   *
   * *** THIS FIELD HAD NO PRODUCER AND THE ROW IT FEEDS COULD NEVER FILL. *** It
   * was declared here and supplied by nothing, so "Local usage against the soft
   * cap" read "not reported" on every deployment forever while the row beside it
   * reported the cap perfectly — the exact shape of a gate that is present,
   * passing and incapable of firing. The caller now reads the estimate it was
   * already making for the Browser section's quota rows and hands the usage here.
   *
   * ORIGIN bytes, not account bytes: this is what the BROWSER is storing for this
   * origin on this machine, which is a different number from the server-side
   * total above and is compared only against the user's own advisory cap.
   */
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
  /**
   * Whether this account has any uploaded file, as one of `ACCOUNT_FILE_CENSUS`.
   * Typed wide so an unrecognised value collapses through `safeEnum` rather than
   * printing, exactly like the role and plan fields.
   *
   * Read from SYNCED ITEMS, not from an endpoint: the file list is already in this
   * client's own collection, so the question "has an upload ever succeeded" costs
   * no request and discloses nothing — and the answer is what decides whether a
   * missing usage figure is a defect or simply nothing to report.
   */
  fileCensus?: string
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
   * The EFFECTIVE per-account `LIVE_SYNC_ENABLED`, resolved by the caller from
   * `GET /v1/admin/users/:userUuid/feature-flags`.
   *
   * EFFECTIVE, not raw: the endpoint reports an unset flag as `null` and the
   * server reads that as enabled, so the caller applies the server's own rule
   * (`absent or anything but 'false'` is on) and hands over a boolean. Absent here
   * therefore means the READ did not happen or did not land — never that the flag
   * is unset — and `flagReading` says which.
   */
  liveSyncEnabledForAccount?: boolean
  /** The effective `COLLABORATION_ENABLED`, resolved the same way. */
  collaborationEnabledForAccount?: boolean
  /**
   * WHY the two flags are absent, when they are, as one of `ACCOUNT_FLAG_READINGS`.
   *
   * The admin-gated 403 is the member that earns this field: a non-admin session
   * cannot read its own flags, and that must not render as a failed read. Typed as
   * the closed union rather than a wide string because the CALLER produces it from
   * its own request — there is no server enum here to be lenient about.
   */
  flagReading?: AccountFlagReading
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
 * How the origin's local usage stands against the user's OWN advisory cap, as a
 * closed three-state answer.
 *
 * *** THE THIRD STATE IS WHY THIS IS A FUNCTION. *** The row was a two-way
 * boolean, so `0` — which is this preference's documented default and means "no
 * cap" — produced neither answer and the row read "not reported" on every
 * deployment where nobody had set one. That is the commonest case by far, and
 * "not reported" invites the operator to go looking for a read that failed. There
 * is nothing to look for: a cap of zero IS an answer, and it is established by
 * the cap alone, so it is given whether or not the usage was measured.
 *
 * `undefined` stays reserved for the one honest absence: a cap IS set and the
 * browser's usage was not measured. A missing usage figure must never read
 * "within the cap", which is the flattering direction.
 */
export const SOFT_CAP_COMPARISONS = ['no-cap', 'over', 'within'] as const

export type SoftCapComparison = (typeof SOFT_CAP_COMPARISONS)[number]

const SOFT_CAP_VALUE: Record<SoftCapComparison, SafeValue> = {
  'no-cap': safeConstant('no cap to exceed'),
  over: safeConstant('over the cap'),
  within: safeConstant('within the cap'),
}

export function describeSoftCapComparison(
  usageBytes: number | undefined,
  capBytes: number | undefined,
): SoftCapComparison | undefined {
  if (capBytes === undefined || !Number.isFinite(capBytes)) {
    return undefined
  }
  if (capBytes <= 0) {
    return 'no-cap'
  }

  const usage = wholeBytes(usageBytes)
  if (usage === undefined) {
    return undefined
  }
  return usage > capBytes ? 'over' : 'within'
}

/**
 * This account's TOTAL server storage, and which halves went into it.
 *
 * *** THE FIGURE THE WHOLE PANE WAS MISSING. *** Space reported uploaded-file
 * bytes and nothing else, so the answer to "how much is this account storing" was
 * at best the smaller half of it and at worst nothing at all.
 *
 * THE ITEM HALF IS LOAD-BEARING: with no item figure there is no total, and this
 * returns `undefined` rather than publishing the file half under a name that
 * claims to be everything. A total that is secretly one component is worse than
 * no total, because it reads as an answer.
 *
 * THE FILE HALF IS ZERO IN EXACTLY ONE CASE, and it is a measured one: the server
 * ANSWERED carrying no usage figure AND this account holds no file item. That is
 * the state `ACCOUNT_SPACE_NOTHING_TO_REPORT` already describes — the usage
 * setting comes into existence on the first successful upload and not before — so
 * "no figure" there is not an unknown, it is the server saying there is nothing to
 * have a figure about. Every other absence leaves the file half OUT and says so
 * through `items-only`. A read that merely threw never produces a zero here: that
 * is the flattering direction and therefore the dangerous one.
 *
 * Both inputs are BYTES; the caller reduces the result to whole megabytes.
 */
export function accountStorageTotal(input: {
  itemBytes: number | undefined
  fileBytes: number | undefined
  fileCensus: AccountFileCensus | undefined
  spaceFigureSource: SpaceFigureSource | undefined
}): { bytes: number; coverage: StorageTotalCoverage } | undefined {
  const items = wholeBytes(input.itemBytes)
  if (items === undefined) {
    return undefined
  }

  const files = wholeBytes(input.fileBytes)
  if (files !== undefined) {
    return { bytes: items + files, coverage: 'items-and-files' }
  }

  if (input.fileCensus === 'none' && input.spaceFigureSource === 'read-carried-no-figure') {
    return { bytes: items, coverage: 'items-and-no-files' }
  }

  return { bytes: items, coverage: 'items-only' }
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

/**
 * *** THE TEN REMEDIES THIS SECTION'S FINDINGS SHIPPED WITHOUT. ***
 *
 * Ten of the 17 remedy-less findings in this directory were here, which is not a
 * coincidence: the Space block's whole design is to keep the KINDS of empty apart,
 * and an arm whose only job is to name a kind of empty reads as though there were
 * nothing to say. There is, and the ten sentences differ from each other far more
 * than the findings do — a server too old to answer, a read that never arrived, a
 * caller that never asked and an account that has never uploaded anything need a
 * newer server, a repaired service, a client release and nothing at all
 * respectively.
 *
 * Two of them are the reason `diagnosticRemedies.ts` gained members:
 * `upgrade-server`, because `client-update` sends the operator after a client
 * release that would change nothing, and `no-action`, because `none` renders
 * "Not fixable here" over an account that is working perfectly.
 */
function remedyForFailedSpaceRead(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_READ_FAILED',
    summary:
      'No answer arrived for this account’s file figures. These two numbers are per-account settings served by the AUTH service, so a read that will not produce them points at that service or at this session — not at the files service, which neither stores nor serves them.',
    steps: [
      'Read the Database & internal comms section. An auth service that is not answering, or whose own database is not, reports there and is the same far end this read could not reach.',
      'Check this session. The Account and access block above reports whether it is signed in and whether the server accepted it; a session the server will not accept cannot read its own settings either.',
      'Do not go looking at the files lane on account of this. A deployment whose transfers are completely broken reports these figures perfectly, and one that cannot report them may transfer files without trouble.',
      'Treat the Space rows as unread, never as zero. Re-read this pane after repairing whichever of the two it was.',
    ],
    effort: 'peer-service',
    basis: 'verified',
    because: [
      'The read was attempted and no answer arrived — a request that never completed, or one this client re-threw. A server that answers carrying no figure is a different state and is reported separately.',
    ],
  }
}

function remedyForUnrecordedSpaceUsage(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_USAGE_UNRECORDED',
    summary:
      'The request path is fine and the bookkeeping is missing. FILE_UPLOAD_BYTES_USED is written by the auth worker on a successful upload, so an account holding files with no figure means those writes did not land — most often a worker that is not consuming its queue.',
    steps: [
      'Check the event queue first. The Database & internal comms section reports whether the in-process gateway is consuming the same queue the workers read; where it is, each message goes to one of them and roughly four in five pushes and bookkeeping writes are lost to the wrong consumer.',
      'Confirm the auth worker is running and consuming. A worker that is up but not consuming looks identical from here to one that is down.',
      'Recalculate this account’s usage from Admin → Users once the writes are landing again. The figure is a running total, so a gap in it does not fill itself.',
      'Expect uploads to keep working throughout. A missing figure refuses nothing; what is lost is the quota, which cannot be enforced or warned about from a total nobody is keeping.',
    ],
    effort: 'peer-service',
    basis: 'verified',
    because: [
      'Two facts are measured: this account holds at least one file, and the server answered carrying no usage figure.',
      'WHY it is missing — never written, or written and later lost — is not established by anything on this screen, which is why the steps above start by checking the commonest cause rather than asserting it.',
    ],
  }
}

function remedyForNothingToReport(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_NOTHING_TO_REPORT',
    summary:
      'Nothing to do. This account has never uploaded a file, so there is no usage figure for it to have — FILE_UPLOAD_BYTES_USED comes into existence on the first successful upload and not before.',
    steps: [],
    effort: 'no-action',
    basis: 'verified',
    because: [
      'The read completed, the server carried no figure, and this client’s own item collection reports no file item for this account.',
      'It is reported at all only so the empty rows above are not mistaken for a failed read. It is not a fault in the deployment, the session or the files lane.',
    ],
  }
}

function remedyForUnexplainedSpaceFigure(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_FIGURE_UNEXPLAINED',
    summary:
      'Re-read this pane once the app has finished loading. Whether an absent figure is ordinary depends on whether this account has ever uploaded a file, and this client cannot say yet: its item collection is still loading, so an empty file list means "not read" rather than "none".',
    steps: [
      'Wait for the app to finish its cold load, then press Refresh on this pane. This resolves itself into one of the two answers with no action at all.',
      'Do not change anything on the strength of this row. It is left undetermined rather than guessed because guessing the quiet one is how a real loss of upload bookkeeping would be reported as nothing.',
    ],
    effort: 'wait',
    basis: 'verified',
    because: [
      'The read completed and carried no figure, and the file census reported "not loaded" rather than present or none.',
    ],
  }
}

function remedyForUnreportedAllowance(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_ALLOWANCE_UNREPORTED',
    summary:
      'This server does not derive the EFFECTIVE file allowance, so there is no ceiling to measure the usage total against. A newer server answers it; nothing on this one does, and nothing is refused by it.',
    steps: [
      'Deploy a server build that derives the effective allowance. The per-account FILE_UPLOAD_BYTES_LIMIT row is legitimately absent on most accounts, and a server that reports only the row reports nothing.',
      'Do not set a per-account limit to make this row fill in. That changes the policy for this account rather than fixing the reading, and the upload-token minter is already applying the plan default — or unlimited where there is no live subscription.',
      'Until then, the headroom verdict in the requirements block stays undetermined. Nothing short of attempting an upload establishes it in this state.',
    ],
    effort: 'upgrade-server',
    basis: 'verified',
    because: [
      'The read completed, carried a usage total and carried no allowance, which is a server that does not derive the effective figure rather than an account with no allowance.',
    ],
  }
}

function remedyForUnaskedSpaceRead(): Remedy {
  return {
    code: 'ACCOUNT_SPACE_NOT_READ',
    summary:
      'Nothing asked for these figures. That is a gap in the CALLER, not in the deployment — and not the state the diagnostics tab is in, which reads both from the requesting session’s own subscription settings.',
    steps: [
      'Treat the Space rows as unread, never as zero. Nothing about this deployment is established by them.',
      'If this is the diagnostics tab rather than a test or a future caller, it is a client defect: the tab supplies both figures, so seeing this means the read did not reach the section. Update the client.',
    ],
    effort: 'client-update',
    basis: 'verified',
    because: [
      'The caller stated `not-attempted` explicitly rather than leaving the field absent, so this is a report about the caller and not an inference from silence.',
    ],
  }
}

function remedyForAbsentStorageEndpoint(): Remedy {
  return {
    code: 'ACCOUNT_STORAGE_ENDPOINT_ABSENT',
    summary:
      'This server build has no route for the stored-item total. Upgrading the server fills it with no migration and no configuration — the total is computed from the item table on each request, so the first read after the upgrade is already correct for everything stored before it.',
    steps: [
      'Deploy a newer server build. Nothing is broken on the running one, nothing is refused, and sync, uploads and every other row on this screen are unaffected.',
      'Do not read the empty rows as an empty account. On this build the file rows cover attachments only, so an account whose storage is entirely notes — which is most accounts — reads as holding nothing at all.',
      'There is nothing to configure and nothing to restart for this. The route either exists in the image or it does not.',
    ],
    effort: 'upgrade-server',
    basis: 'verified',
    because: [
      'The item-usage request completed and the server answered that it has no such route, which is a deployment older than the figure rather than a fault in the one running.',
    ],
  }
}

function remedyForFailedStorageRead(): Remedy {
  return {
    code: 'ACCOUNT_STORAGE_READ_FAILED',
    summary:
      'No answer arrived for the stored-item total. The figure is served by the SYNCING server on this session’s own credentials, so a read that will not produce it points at that service or at this session.',
    steps: [
      'Read the Database & internal comms section. A syncing service that is not answering reports there and is the same far end this read could not reach.',
      'Check this session in the Account and access block. A session the server will not accept cannot read its own items either.',
      'Do not read this as evidence about the notes themselves. Syncing can be entirely healthy while this one read fails, and a deployment whose syncing is broken has far louder symptoms than an empty row here.',
      'Treat the total as unread, never as zero.',
    ],
    effort: 'peer-service',
    basis: 'verified',
    because: [
      'No answer arrived at all — a request that never completed, or one this client re-threw. A server that lacks the route answers, and that answer is reported separately.',
    ],
  }
}

function remedyForUnaskedStorageRead(): Remedy {
  return {
    code: 'ACCOUNT_STORAGE_NOT_READ',
    summary:
      'Nothing asked how much this account has stored. That is a gap in the CALLER, not in the deployment: the diagnostics tab reads the figure from the requesting session’s own items, carrying no account identifier in either direction.',
    steps: [
      'Treat the item rows as unread, never as zero. Nothing about this deployment is established by them.',
      'If this is the diagnostics tab rather than a test or a future caller, it is a client defect: the tab supplies the figure, so seeing this means the read did not reach the section. Update the client.',
    ],
    effort: 'client-update',
    basis: 'verified',
    because: [
      'The caller stated `not-attempted` explicitly rather than leaving the field absent, so this is a report about the caller and not an inference from silence.',
    ],
  }
}

function remedyForPartialStorageTotal(): Remedy {
  return {
    code: 'ACCOUNT_STORAGE_TOTAL_PARTIAL',
    summary:
      'Some of this account’s items carry no recorded size, so every figure derived from the sum — the account total included — is a lower bound rather than a measurement. Recalculating this account’s usage re-derives the missing sizes and makes it exact.',
    steps: [
      'Run the quota recalculation for this account from Admin → Users. It re-derives the missing sizes from the items themselves, applies immediately and needs no restart.',
      'Expect the row above to read "every item measured" afterwards, and the total to move. It will move UP: the items the sum could not see are real storage.',
      'Nothing is refused and no data is at risk in the meantime. The only thing that is wrong is the number.',
    ],
    effort: 'account-setting',
    basis: 'verified',
    because: [
      'The read completed and produced a figure, and the server also reported that some of this account’s items have no recorded payload size.',
      'The size column is nullable and was added by a migration over a table that already had rows, so items written before it carry none. That is the ordinary cause and it is not a fault.',
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

/**
 * The role-list row's value when nothing produces the names. Not `NOT_PUBLISHED`:
 * the gap here is a CLIENT surface rather than a server endpoint, and sending an
 * operator to look for a missing server field would be the same wrong errand in a
 * new direction.
 */
const ROLE_NAMES_UNPUBLISHED = safeConstant('not exposed by any client surface')

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

  /**
   * *** ONE SENTENCE RATHER THAN FIVE EMPTY ROWS, exactly as the admission block
   * in `websocketSection.ts` does it. ***
   *
   * `roles` has no producer: no client surface exposes the role NAMES, only
   * `hasRole()` for one name at a time, and a list assembled from four probes of
   * this build's own four names could not report an unrecognised one — which is
   * the only thing the count row is for. So on every deployment these five rows
   * each rendered "not reported", and five of them in a column reads as five
   * failures rather than as one absent input. The information content is
   * identical and the sentence is the half an operator reads.
   *
   * The rows return the moment anything supplies the list, name by name, and the
   * replacement resolves to `undetermined` — the same verdict each of the five it
   * replaces carried while absent, so collapsing them cannot move this section's
   * worst verdict in either direction. (It claims `informational` and the
   * contract caps that to `undetermined` on absent evidence, which is the right
   * answer arrived at by the right rule rather than by this call site.)
   */
  if (roles === undefined) {
    rows.push(
      diagnosticRow({
        label: safeConstant('Roles held by this account'),
        value: ROLE_NAMES_UNPUBLISHED,
        verdict: 'informational',
        evidence: EVIDENCE_ABSENT,
        note: 'Not a failed read: nothing in this client can produce the list. The client exposes only `hasRole()` for one name at a time, so a list built here could hold this build’s own four names and could never report a fifth the server knows about — and reporting an unrecognised role as a count is the one job the list has. Four per-role rows and a count of roles outside this build’s taxonomy appear here the moment a surface supplies the names. The row above — the admin role as the server itself answered — is unaffected and is the one that carries a verdict.',
      }),
    )
  } else {
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
  }

  if (roles !== undefined) {
    rows.push(
      diagnosticRow({
        label: safeConstant('Roles outside this build’s taxonomy'),
        value: safeCount(unrecognisedRoles),
        ...absentOr(unrecognisedRoles, 'informational'),
        note: 'Counted, never printed. A role name is a closed enum only while it is one of the four above; anything else is a server-supplied string of unknown content, and this section is the one place in the pane where such a string could be an identifier. A newer server’s legitimate new role therefore shows up here as a number rather than disappearing.',
      }),
    )
  }

  rows.push(
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

  const census = ACCOUNT_FILE_CENSUS.find((candidate) => candidate === observed.fileCensus)
  const allowanceOrigin = FILE_ALLOWANCE_ORIGINS.find((candidate) => candidate === observed.fileAllowanceOrigin)

  const cap = observed.localSoftCapBytes
  const capSet = cap === undefined ? undefined : cap > 0
  const capComparison = describeSoftCapComparison(observed.localUsageBytes, cap)
  const localUsedMb = wholeMegabytes(observed.localUsageBytes)

  const itemReading = ITEM_USAGE_READINGS.find((candidate) => candidate === observed.itemUsageReading)
  const itemMb = wholeMegabytes(observed.itemBytesUsed)
  const total = accountStorageTotal({
    itemBytes: observed.itemBytesUsed,
    fileBytes: observed.fileUploadBytesUsed,
    fileCensus: census,
    spaceFigureSource: observed.spaceFigureSource,
  })
  const totalMb = total === undefined ? undefined : wholeMegabytes(total.bytes)

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
      note: 'The EFFECTIVE allowance — what the files server would actually enforce on the next upload, which is not the same thing as what is stored. An absent FILE_UPLOAD_BYTES_LIMIT row was never an absent allowance: the token minter falls back to the plan default, and to unlimited where there is no live subscription, so a server that reported nothing here was withholding a figure it was about to apply. Rounded down, so 0 means under one megabyte rather than unset. -1 is the ONLY value the files server treats as unlimited and is printed as such; 0 is an allowance of nothing and refuses every upload, which is a different answer from no limit and is never merged with it. Where the figure came from is the next row, and it matters: the same number can be a decision somebody made or a default nobody has looked at.',
    }),
    diagnosticRow({
      label: safeConstant('Where the file allowance comes from'),
      value: safeEnum(observed.fileAllowanceOrigin, FILE_ALLOWANCE_ORIGINS),
      ...absentOr(allowanceOrigin, 'informational'),
      note: 'Whether the allowance above is a per-account setting, the subscription plan’s default, or the unlimited fallback for an account with no live subscription. A closed server enum, admitted rather than printed. It is reported because the figure alone cannot be audited: "set for this account" is a decision with an author, "the plan default" is a ceiling nobody chose, and only the first can be raised from Admin → Users without changing the plan. "not reported" here means the server does not send provenance — every build before the effective-allowance answer — and not that the allowance is unset.',
    }),
    diagnosticRow({
      label: safeConstant('Server file bytes used, whole MB'),
      value: safeCount(usedMb),
      ...absentOr(observed.fileUploadBytesUsed, 'informational'),
      note: 'Uploaded file bytes for this account, rounded down to whole megabytes. Note content is not counted here, which is why a large vault with no attachments reads 0.',
    }),
    diagnosticRow({
      label: safeConstant('Server item bytes used, whole MB'),
      value:
        observed.itemBytesUsed === undefined
          ? itemReading === undefined
            ? safeCount(undefined)
            : ITEM_USAGE_ABSENCE[itemReading]
          : safeCount(itemMb),
      ...absentOr(observed.itemBytesUsed, 'informational'),
      note: 'The NOTES. Every synced item this account owns — notes, tags, editor state, keys — summed from the stored payload size of each one, rounded down to whole megabytes. For most accounts this is the larger half of their storage and the row above it is the smaller, which is why a pane that reported only uploaded files answered "0 MB" to an operator holding a full vault. Derived on the server from the item table itself rather than from any running total, so there is no counter to drift: a note that is created, edited or deleted changes the figure because the figure is recomputed from the items, and a deleted item is excluded twice over — its recorded size is zeroed on deletion AND deleted items are outside the sum. NOT counted here: revisions (note history lives in a different service with its own pruning) and uploaded files (the row above). 0 means under one megabyte, and an empty row is never a zero — the next row says which kind of empty it was.',
    }),
    diagnosticRow({
      label: safeConstant('Item usage read'),
      value: safeEnum(observed.itemUsageReading, ITEM_USAGE_READINGS),
      ...absentOr(itemReading, 'informational'),
      note: 'What happened when this client asked the server for the figure above, as a closed set. It is the row that keeps an empty item total honest: "not answered by this server build" is a deployment that predates the endpoint and will report the moment it is upgraded, "the read did not arrive" is a symptom worth chasing, and "not read by this caller" is a gap in this panel and not in the deployment. None of them is a zero, and none of them means the account is storing nothing.',
    }),
    diagnosticRow({
      label: safeConstant('Item byte total completeness'),
      value: safeState(observed.itemBytesComplete, 'every item measured', 'some items unmeasured'),
      ...absentOr(observed.itemBytesComplete, 'informational'),
      note: 'Whether the item figure covers every item this account holds. The stored size column is nullable — it was added by a migration over a table that already had rows — so an account can hold items whose size was never recorded, and a sum that silently skipped them would be a FLOOR printed as a total. A BOOLEAN rather than a count of unmeasured items, because how many items one person keeps is a fact about that person and the diagnosis needs only whether the figure is whole. The server heals this itself: there is an admin recalculation that rewrites the missing sizes from the items.',
    }),
    diagnosticRow({
      label: safeConstant('Total account storage, whole MB'),
      value: safeCount(totalMb),
      ...absentOr(total, 'informational'),
      note: 'Everything this ACCOUNT is storing on this server: the item payload plus the uploaded files, rounded down to whole megabytes. This is the one figure the Space block exists to answer and it is composed here rather than on the server, because its two halves are held by two different services and either can be missing while the other is perfect. Absent whenever the ITEM half is — a "total" that quietly contained only attachments would read as an answer and be wrong by most of the account. What it contains is the next row, and that row is not optional reading.',
    }),
    diagnosticRow({
      label: safeConstant('What the total counts'),
      value: safeEnum(total?.coverage, STORAGE_TOTAL_COVERAGE),
      ...absentOr(total?.coverage, 'informational'),
      note: 'Which halves went into the total above, as a closed set. "items and files" is the complete answer. "items and no files" means the account holds no file at all, so the file half contributes nothing and the total is still complete — that is read from the file census and from a server that ANSWERED carrying no usage figure, never from a file read that merely failed. "items only" means the file total is NOT established and the figure is a floor; the file rows above say why, and nothing short of fixing that makes the total whole.',
    }),
    diagnosticRow({
      label: safeConstant('Local usage, whole MB'),
      value: safeCount(localUsedMb),
      ...absentOr(observed.localUsageBytes, 'informational'),
      note: 'What the BROWSER is storing for this origin on this machine, from the same storage estimate the Browser section reports a quota share from. A different number from the server total above and not comparable with it: it is one device’s cache of a vault that may be larger, it includes anything else this origin has written, and the browser rounds it for privacy. It is here because it is the only figure the user’s own soft cap below is about.',
    }),
    diagnosticRow({
      label: safeConstant('Local usage soft cap'),
      value: safeState(capSet, 'set', 'no cap'),
      ...absentOr(capSet, 'informational'),
      note: 'The user’s OWN advisory cap on local storage (Preferences → Storage), where 0 means unlimited. It is not a quota and the browser does not know about it. The origin’s real quota and the eviction risk that comes with it are the Browser section’s, and are not restated here.',
    }),
    diagnosticRow({
      label: safeConstant('Local usage against the soft cap'),
      value:
        capComparison === undefined
          ? safeState(undefined, 'over the cap', 'within the cap')
          : SOFT_CAP_VALUE[capComparison],
      ...absentOr(capComparison, 'informational'),
      note: 'ADVISORY, and informational even when it reads over: this cap NEVER blocks a save or a sync. It exists so a user who set a budget hears about it, and a row that gave it a tone would read as a fault and send someone looking for a failure that cannot happen. THREE answers, not two: a cap of zero is this preference’s default and means there is no cap, which is established by the cap alone and is said rather than left blank — that emptiness was the commonest reading on every deployment and it invited a hunt for a read that had not failed. "not reported" is now reserved for the one honest absence, a cap that IS set beside a local usage this browser would not report.',
    }),
    diagnosticRow({
      label: safeConstant('Uploaded files in this account'),
      value: safeEnum(observed.fileCensus, ACCOUNT_FILE_CENSUS),
      ...absentOr(census, 'informational'),
      note: 'A STATE, never a count, and read from this client’s own synced items rather than from any request. It is here because it is the EVIDENCE for the verdict on an absent usage figure: with no file in the account there is nothing for the server to have a figure about, and with files present a missing figure means the upload bookkeeping was lost. "not loaded" is its own answer on purpose — an item collection answers an empty list both for "none" and for "not read yet", and reading the second as the first is how a pane invents a fact. One known gap: the count is taken over DECRYPTED items, so a file whose key is missing is not counted and such an account reads "none" here.',
    }),
  ]

  /**
   * *** AN EMPTY SPACE BLOCK IS A FACT, AND THERE ARE FOUR OF THEM. ***
   *
   * Every row here read "not reported" on every deployment, and the cause was a
   * WIRING GAP: the tab supplied no space fields at all. That is now fixed, so the
   * emptiness has become informative rather than constant — which is the only
   * condition under which distinguishing its kinds is worth anything.
   *
   * *** AND THE FIRST SPLIT WAS TOO COARSE, WHICH COST A FALSE `broken`. ***
   *
   * It had two kinds — nobody asked, and the read failed — and "the read answered
   * and carried no figure" was deliberately filed under the second. That one
   * decision rated the ORDINARY state of this fork as a broken deployment:
   * `FILE_UPLOAD_BYTES_USED` exists only once an upload has succeeded, so an
   * account that has never uploaded a file has no row, auth answers 400, the client
   * maps 400 to `undefined` without throwing, and the whole section went `broken`.
   * The decisive test is that a brand-new account that had merely never uploaded
   * anything read `broken` — a false alarm of exactly the kind this pane was
   * cleaned up to remove, and one that would fire for every such account forever.
   *
   * So the question an absent figure raises is now answered rather than assumed,
   * and it is answered with a fact this client already holds: does the account have
   * any FILE at all? With files present, a server with no usage figure has lost the
   * bookkeeping, which is a real degradation. With none, there is nothing to report
   * and saying so is the honest answer. With the collection still loading, neither
   * is established and the block says that instead of picking the quiet one.
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
   * *** AND THE SECOND SPLIT WAS KEYED ON THE WRONG FIGURE, WHICH WOULD HAVE MADE
   * THE DEGRADED ARM UNREACHABLE. ***
   *
   * These arms were gated on `fileUploadBytesUsed === undefined && fileUploadBytesLimit
   * === undefined` — BOTH figures missing. That held only while the server answered
   * nothing for either, and it no longer does: an absent limit ROW is not an absent
   * allowance, so the server now answers the EFFECTIVE allowance (plan default, or
   * unlimited with no live subscription) whenever no row exists. Under the old
   * condition that one new figure would have silenced every arm below, including
   * `ACCOUNT_SPACE_USAGE_UNRECORDED` — the arm whose entire subject is a USAGE
   * total nobody is keeping. Publishing one derivable number would have deleted the
   * finding about the other one, permanently and silently, which is the worst shape
   * a gate can take: present, passing, and incapable of firing.
   *
   * So each arm is keyed on the figure it is actually about. The usage arms ask
   * only whether the USAGE total is missing; the thrown-read arm asks whether ANY
   * figure is missing, because a throw anywhere is a failed read. The allowance has
   * an arm of its own for the one case the new answer cannot cover — a server too
   * old to send it.
   *
   * NOTHING IS SYNTHESISED ON THE USAGE SIDE, server or client, and that is what
   * keeps the degraded arm real: the server derives an allowance (a fact about
   * policy) and refuses to derive a total (a fact about bytes). A zero is a figure;
   * unknown is not, and this block must be able to tell an operator which one it
   * was handed.
   */
  const usageFigureAbsent = observed.fileUploadBytesUsed === undefined
  const allowanceFigureAbsent = observed.fileUploadBytesLimit === undefined
  const anyFigureAbsent = usageFigureAbsent || allowanceFigureAbsent

  const findings: DiagnosticFinding[] = []

  // A READ THAT THREW. Still `broken`, and narrowed rather than weakened: this arm
  // now fires only where an answer never arrived, which is what the finding always
  // claimed in its own text and never actually tested.
  if (anyFigureAbsent && observed.spaceFigureSource === 'read-threw') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SPACE_READ_FAILED'),
        title: 'This account’s space figures were asked for and did not arrive',
        detail:
          'The rows above are empty because the read FAILED, not because this build does not look. No answer arrived at all — a request that never completed, or one the client re-threw — which is a different state from a server that answered carrying no figure, and that one is reported separately. These two numbers are per-account SETTINGS served by the auth service, so a read that will not produce them points at the session or at auth — not at the files service, which neither stores nor serves them. Do not read this as evidence about attachments: a deployment whose file transfers are completely broken reports these figures perfectly, and a deployment that cannot report them may transfer files without trouble. If attachments are the symptom, the files rows in the Database & internal comms section are the place, together with the finding there saying that nothing on that screen establishes an authorized transfer.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForFailedSpaceRead(),
      }),
    )
  }

  // AN ANSWER ARRIVED CARRYING NO FIGURE. Three outcomes, decided by whether the
  // account has a file — never merged, because the whole defect being fixed here
  // was one state standing in for three.
  if (usageFigureAbsent && observed.spaceFigureSource === 'read-carried-no-figure') {
    if (census === 'present') {
      findings.push(
        diagnosticFinding({
          code: safeConstant('ACCOUNT_SPACE_USAGE_UNRECORDED'),
          title: 'This account has files and the server reports no usage figure for them',
          detail:
            'The read completed and carried nothing, so the request path is fine; what is missing is the bookkeeping. FILE_UPLOAD_BYTES_USED is written by the auth worker on a successful upload, so an account holding files with no figure means those writes did not land — most often a worker that is not consuming its queue. Two facts are measured here and the third is not: that this account holds at least one file, and that the server answered carrying no figure. WHY it is missing — never written, or written and later lost — is not established by anything on this screen. Degraded rather than down: uploads are not refused by a missing figure, and the files themselves are unaffected. What it costs is the quota itself, which cannot be enforced or warned about from a total nobody is keeping.',
          verdict: 'degraded',
          // DIRECT, and the two facts it is direct about are both measured here:
          // this account holds a file item, and the server's answer carried no
          // usage figure. What is merely inferred — WHY the figure is missing — is
          // capped in the detail rather than by the evidence, because a `degraded`
          // claim on proxy evidence caps to `undetermined` and this finding would
          // then report a measured bookkeeping gap as "could not tell".
          evidence: EVIDENCE_DIRECT,
          remedy: remedyForUnrecordedSpaceUsage(),
        }),
      )
    } else if (census === 'none') {
      findings.push(
        diagnosticFinding({
          code: safeConstant('ACCOUNT_SPACE_NOTHING_TO_REPORT'),
          title: 'There is no file usage to report for this account yet',
          detail:
            'The read completed and the server carried no figure, and this account holds no file — so there is nothing for it to have a figure about. FILE_UPLOAD_BYTES_USED comes into existence on the first successful upload and not before. This is the ordinary state of an account that has never uploaded anything, it is reported here only so the empty rows above are not mistaken for a failed read, and it is not a fault in the deployment, the session or the files lane.',
          verdict: 'informational',
          evidence: EVIDENCE_DIRECT,
          remedy: remedyForNothingToReport(),
        }),
      )
    } else {
      findings.push(
        diagnosticFinding({
          code: safeConstant('ACCOUNT_SPACE_FIGURE_UNEXPLAINED'),
          title: 'The server carried no space figure, and whether that is expected is not established',
          detail:
            'The read completed and carried nothing. Whether that is ordinary depends on whether this account has ever uploaded a file, and this client cannot say: its item collection has not finished loading, so an empty file list means "not read yet" rather than "none". Re-run these diagnostics once the app has finished loading and this resolves itself into one of the two answers. It is left undetermined rather than guessed because guessing the quiet one is how a real loss of upload bookkeeping would be reported as nothing at all.',
          verdict: 'undetermined',
          evidence: EVIDENCE_ABSENT,
          remedy: remedyForUnexplainedSpaceFigure(),
        }),
      )
    }
  }

  /**
   * AN ALLOWANCE THE SERVER DID NOT ANSWER, with a usage total that it did.
   *
   * Mutually exclusive with the usage arms above by construction — it requires the
   * usage figure to be PRESENT — so this block still emits at most one finding and
   * an operator still counts one problem per problem.
   *
   * The state it describes is a SERVER too old to derive the effective allowance,
   * not a fault: the account's uploads are not refused by it, and the figure the
   * token minter applies is the plan default or unlimited exactly as it always
   * was. What is lost is the headroom verdict in the requirements block, which
   * cannot be computed from a usage total with no ceiling to measure it against,
   * and which would otherwise read "not reported" with nothing on the screen
   * explaining why.
   */
  if (!usageFigureAbsent && allowanceFigureAbsent && observed.spaceFigureSource === 'read-carried-no-figure') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SPACE_ALLOWANCE_UNREPORTED'),
        title: 'This account’s usage is reported and its allowance is not',
        detail:
          'The read completed, carried a usage total and carried no allowance. That is a SERVER that does not derive the effective allowance — the per-account FILE_UPLOAD_BYTES_LIMIT row is legitimately absent on most accounts, and a server that reports only the row reports nothing. It is not a fault and nothing is refused by it: the upload-token minter still falls back to the plan default, and to unlimited where there is no live subscription, so uploads go through at a ceiling this client is simply not told. What it costs is the headroom verdict in the requirements block below, which has a usage total and nothing to measure it against and therefore stays undetermined. Nothing short of attempting an upload establishes the headroom in this state.',
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
        remedy: remedyForUnreportedAllowance(),
      }),
    )
  }

  // `not-attempted` EXPLICITLY, never an absent field. Absent means the caller did
  // not say which kind of empty this is, and inventing "nobody asked" from silence
  // would be this block making the same absent-is-false mistake it exists to flag —
  // on a model where nothing at all was observed, which is the one case that must
  // claim nothing.
  if (anyFigureAbsent && observed.spaceFigureSource === 'not-attempted') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_SPACE_NOT_READ'),
        title: 'This caller did not ask for this account’s own space figures',
        detail:
          'The rows above are empty because nothing asked, and that is said here rather than left to look like a quiet deployment with nothing stored. It is a gap in the CALLER, not in the deployment, and it is no longer the state the diagnostics tab is in: it reads both figures from the requesting session’s own subscription settings, which carry no account identifier in either direction. A model built without them — a test, or a future caller — reports this instead of a figure it never looked for. Treat the Space rows as unread, never as zero.',
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
        remedy: remedyForUnaskedSpaceRead(),
      }),
    )
  }

  /**
   * *** THE ITEM TOTAL'S OWN ARMS, AND WHY THIS BLOCK NOW EMITS UP TO TWO. ***
   *
   * The arms above are about the FILE figures and emit at most one between them.
   * These four are about the ITEM figure, they emit at most one between them, and
   * they are deliberately not merged with the file arms: the two halves come from
   * two different services and either can be perfect while the other is missing.
   * Folding them would mean a file-side finding silencing an item-side one, which
   * is the exact defect recorded above — an arm that is present, passing and
   * incapable of firing, because some other figure arrived.
   *
   * So the invariant this block holds is one finding PER SUBJECT rather than one
   * finding outright, and the subjects are disjoint by construction: these four
   * key on `itemBytesUsed` and `itemUsageReading`, which no file arm reads, and
   * the first three require the item figure to be ABSENT while the fourth
   * requires it to be present.
   *
   * NOTHING IS SYNTHESISED HERE EITHER. There is no arm that turns a failed read
   * into a zero, and the completeness arm exists precisely because a sum that
   * skipped unmeasured rows is a floor rather than a figure.
   */
  const itemFigureAbsent = observed.itemBytesUsed === undefined

  if (itemFigureAbsent && itemReading === 'endpoint-absent') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_STORAGE_ENDPOINT_ABSENT'),
        title: 'This server build does not report how much this account has stored',
        detail:
          'The item-usage request completed and the server answered that it has no such route. That is a DEPLOYMENT OLDER THAN THE FIGURE, not a fault in the one that is running: nothing is broken, nothing is refused, and sync, uploads and every other row on this screen are unaffected. What is missing is the answer to "how much is this account storing", which is most of what a storage report is for — the file rows above cover attachments only, so on this build an account whose storage is entirely notes reads as holding nothing at all. Upgrading the server fills it with no migration and no configuration: the total is computed from the item table on each request rather than from anything that has to be built up first, so the first read after the upgrade is already correct and already covers everything stored before it.',
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
        remedy: remedyForAbsentStorageEndpoint(),
      }),
    )
  } else if (itemFigureAbsent && itemReading === 'read-threw') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_STORAGE_READ_FAILED'),
        title: 'The stored-item total for this account could not be read',
        detail:
          'The rows above are empty because the read FAILED, not because this build does not look and not because the server lacks the route — a server that lacks it answers, and that answer is reported separately. No answer arrived at all: a request that never completed, or one this client re-threw. The figure is served by the SYNCING server on the session’s own credentials, so a read that will not produce it points at that service or at the session, and not at the files service, which neither stores nor serves it. Do not read this as evidence about the notes themselves: syncing can be entirely healthy while this one read fails, and a deployment whose syncing is broken has louder symptoms than an empty row here. Treat the total as unread, never as zero.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForFailedStorageRead(),
      }),
    )
  } else if (itemFigureAbsent && itemReading === 'not-attempted') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_STORAGE_NOT_READ'),
        title: 'This caller did not ask how much this account has stored',
        detail:
          'The item rows above are empty because nothing asked, and that is said here rather than left to look like an account with nothing in it. It is a gap in the CALLER, not in the deployment: the diagnostics tab reads the figure from the requesting session’s own items, carrying no account identifier in either direction. A model built without it — a test, or a future caller — reports this instead of a figure it never looked for.',
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
        remedy: remedyForUnaskedStorageRead(),
      }),
    )
  } else if (!itemFigureAbsent && observed.itemBytesComplete === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ACCOUNT_STORAGE_TOTAL_PARTIAL'),
        title: 'The stored-item total is a floor: some of this account’s items carry no recorded size',
        detail:
          'The read completed and produced a figure, and the server also reported that some of this account’s items have no recorded payload size — the column is nullable and was added by a migration over a table that already had rows, so items written before it carry none. Those items are REAL STORAGE that the sum cannot see, so every figure derived from it, including the account total, is a lower bound rather than a measurement. Degraded rather than down: nothing is refused and no data is at risk, and the only thing that is wrong is the number. The server can re-derive the missing sizes from the items themselves — the admin quota recalculation for this account does it — after which this row reads "every item measured" and the total becomes exact.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForPartialStorageTotal(),
      }),
    )
  }

  return {
    heading: safeConstant('Space'),
    description:
      'How much this ACCOUNT is storing and what room it has — the item payload, the uploaded files, and the total of the two — plus the browser’s own usage on this machine, which is a different number with a different failure: the server-side allowance refuses uploads, the local one evicts the local database. Every row here is a measurement; the verdict about whether an upload will succeed is one row, in the requirements block below.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 3: what must be true for this user, right now                       */
/* -------------------------------------------------------------------------- */

const LIVE_SYNC_NOTE =
  'The per-account Live sync switch (LIVE_SYNC_ENABLED), which an administrator can turn off for ONE account on a deployment that is otherwise perfect. Read from the admin feature-flags endpoint for the requesting session, as the EFFECTIVE value: the endpoint reports an unset flag as null and the server treats that as enabled, so an unset flag reads "enabled" here because that is what the server will do. The endpoint is admin-gated, so a non-admin session cannot read it and the row says so rather than claiming a fault; the fallback evidence then is the transport being refused with the LIVE_SYNC_DISABLED code, which is conclusive when it happens and silent when it does not. What breaks while it is off: note syncing for this account stays on HTTP. Invites, API RPC, collaboration and files are unaffected, which is what makes it so easy to misread as a broken deployment.'

function buildRequirementsBlock(observed: AccountObservations, reading: AdminReading): DiagnosticBlock {
  const state = describeFileQuota(observed.fileUploadBytesUsed, observed.fileUploadBytesLimit)
  const exhausted = state === 'exhausted' || state === 'no-allowance'
  const quotaPressure = exhausted || state === 'nearly-full'

  const liveSyncFlag = observed.liveSyncEnabledForAccount
  const liveSyncRefused = observed.fallbackReason === 'live-sync-disabled'
  // `not-attempted` EXPLICITLY for an absent field, exactly as the Space block
  // does: inventing "nobody asked" from silence would be a claim, and this is the
  // one place that must claim nothing.
  const flagReading: AccountFlagReading = observed.flagReading ?? 'not-attempted'
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
      note: 'The one verdict about the figures in the Space block above. What breaks when this fails: the files server refuses new uploads for this account, with existing files still readable and note syncing entirely unaffected — so the symptom is attachments failing and nothing else, which is why it is so often chased on the transport first. An allowance of nothing ("no allowance granted") refuses every upload and is reported as broken rather than as an absent limit. AN UNREPORTED LIMIT IS STILL NOT AN ABSENT ALLOWANCE, and that is now answered rather than merely warned about: the server derives the EFFECTIVE allowance the token minter would apply — the plan default, or unlimited where there is no live subscription — so this row resolves on a deployment that has never written a limit setting, which used to be every one of them. It stays undetermined where the USAGE total is missing, because headroom cannot be derived from a ceiling alone, and where the server is too old to send an allowance at all; the Space block above says which of those it was. Nothing short of attempting an upload establishes the headroom in either state, and this row does not pretend otherwise.',
    }),
    diagnosticRow({
      label: safeConstant('Live sync for this account'),
      value:
        liveSyncFlag !== undefined
          ? safeState(liveSyncFlag, 'enabled', 'disabled')
          : liveSyncRefused
            ? safeConstant('disabled (refused on the sync lane)')
            : ACCOUNT_FLAG_ABSENCE[flagReading],
      verdict:
        liveSyncFlag === true ? 'healthy' : liveSyncFlag === false || liveSyncRefused ? 'broken' : 'undetermined',
      evidence: liveSyncFlag !== undefined || liveSyncRefused ? EVIDENCE_DIRECT : EVIDENCE_ABSENT,
      note: LIVE_SYNC_NOTE,
    }),
    diagnosticRow({
      label: safeConstant('Collaboration permitted for this account'),
      value:
        observed.collaborationEnabledForAccount === undefined
          ? ACCOUNT_FLAG_ABSENCE[flagReading]
          : safeState(observed.collaborationEnabledForAccount, 'enabled', 'disabled'),
      ...absentOr(
        observed.collaborationEnabledForAccount,
        observed.collaborationEnabledForAccount === true ? 'healthy' : 'broken',
      ),
      note: 'The per-account COLLABORATION_ENABLED switch, read from the admin feature-flags endpoint for the requesting session. What breaks while it is off: shared vaults and collaborative editing are refused for this account alone. It is a DIFFERENT fact from the client-side entitlement row below — one is the server permitting it, the other is this client offering it — and either alone is enough to make collaboration not work. The value is EFFECTIVE rather than raw: the endpoint reports an unset flag as null and the server treats that as enabled, so an unset flag reads "enabled" here because that is what the server will do. Empty means the read did not happen or did not land, and the wording says which — most often that the endpoint is admin-gated and this session is not an admin, which is not a fault.',
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

/**
 * *** THIS LINE WAS STALE, AND IT WAS STALE IN THE DIRECTION THAT MATTERS. ***
 *
 * It read "not reported by any server build; only a refusal observed on the sync
 * lane evidences them" — written when nothing fetched the flags. Something does:
 * the diagnostics tab reads `GET /v1/admin/users/:userUuid/feature-flags` for the
 * REQUESTING session, which is the route the admin Users tab has always used, and
 * the two flag rows above carry the EFFECTIVE values from it. A pasteable report
 * asserting that no server reports a fact the rows beside it just reported is the
 * one kind of error this pane cannot afford, because its only asset is that it can
 * be believed.
 *
 * What survives of the old sentence is the part that is still true and is the
 * reason the rows can read empty: the endpoint is admin-gated, so a non-admin
 * session is refused on authorization and the rows say so rather than claiming the
 * flags are off.
 */
const REPORT_ACCOUNT_FLAGS = reportLine(
  safeConstant('Per-account feature flags'),
  safeConstant(
    'read for the requesting session from the admin feature-flags endpoint, as EFFECTIVE booleans; the endpoint is admin-gated, so a non-admin session reads them as unavailable rather than as off',
  ),
)

/**
 * The file census is a STATE and the report says so, because the obvious next
 * edit is to make it a number. How many files one person keeps is a fact about
 * that person, the diagnosis needs only "any or none", and a withholding that is
 * written down is one a later reader has to argue with rather than overlook.
 */
const REPORT_FILE_CENSUS = reportLine(
  safeConstant('Uploaded files'),
  safeConstant('reported as present, none or not loaded; never counted and never named'),
)

/**
 * The item total is BYTES and never a population.
 *
 * The obvious next edit to a storage figure is to print how many things make it
 * up, and "this account holds 4,812 notes" is a fact about a person that no
 * diagnosis needs. The server does report the counts — it has to, in order to say
 * whether the sum covers every item — and the caller reduces them to one boolean
 * before they reach this module. Written down so that a later reader has to argue
 * with it rather than overlook it, exactly like the file census above.
 */
const REPORT_ITEM_COUNTS = reportLine(
  safeConstant('Stored items'),
  safeConstant('reported as whole megabytes and a completeness boolean; never counted and never named'),
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
    extraReportLines: [
      REPORT_NO_IDENTIFIERS,
      REPORT_BYTES_REDUCED,
      REPORT_FILE_CENSUS,
      REPORT_ITEM_COUNTS,
      REPORT_ACCOUNT_FLAGS,
    ],
  })
}
