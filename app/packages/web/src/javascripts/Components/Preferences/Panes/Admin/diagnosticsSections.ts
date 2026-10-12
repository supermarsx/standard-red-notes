import type { SyncFallbackReason, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'
import type { Remedy } from './diagnosticRemedies'
import { admitToken, NOT_REPORTED, WITHHELD, type DeclaredPattern } from './reportAllowlist'
import type { Tone } from './syncDiagnostics'

/**
 * Standard Red Notes: the shared contract behind the sectioned admin diagnostics.
 *
 * ONE renderer (`DiagnosticsSection.tsx`), one pure model builder per section.
 * Each section is a `.ts` module that returns data and renders nothing, which is
 * the boundary this pane already had — `syncDiagnostics.ts` decides what the
 * operator is TOLD, the tab only paints it — generalised so that several sections
 * can be written at once without two of them meeting in the same file.
 *
 * Nothing here is decoration. Each of the three mechanisms below exists because
 * the pane has already been confidently wrong in that exact way, and a panel whose
 * only asset is that it can be believed cannot afford a fourth instance.
 *
 * -------------------------------------------------------------------------------
 * 1. `SafeValue`: presence, never values — held in the type system.
 * -------------------------------------------------------------------------------
 *
 * The server contract is that this pane receives booleans, closed enums, bounded
 * counts, durations and compile-time constants, and never a hostname, URL, env
 * value, path or secret. That contract was previously held by convention plus a
 * planted-secret scan. Convention does not survive five people writing five
 * sections in parallel.
 *
 * So a row's label and value are not `string`. They are `SafeValue`, and the only
 * way to obtain one is a constructor in this file, each of which accepts exactly
 * one of the permitted categories:
 *
 *   - `safeConstant` — a string LITERAL from this build. Its signature rejects a
 *     value of type `string`, so a server-supplied string cannot be passed to it
 *     even by accident: `safeConstant(payload.mode)` does not compile.
 *   - `safeYesNo` / `safePresence` / `safeState` — a boolean, three-valued so
 *     `undefined` reads "not reported" rather than "no" (see rule 3).
 *   - `safeEnum` — a string admitted only if it is one of a declared tuple of
 *     literals. Anything else collapses to `other (unrecognised)`; the rejected
 *     value is never echoed.
 *   - `safeCount` — a finite, non-negative integer.
 *   - `safeDuration` — a duration. Deliberately not a timestamp: a duration
 *     cannot be correlated against anyone else's logs.
 *   - `safePercentBucket` — a magnitude reduced to one of six closed buckets,
 *     for the user-space figures that are real user data.
 *   - `safeEnvName` — an environment variable NAME, admitted by SHAPE. A FLOOR,
 *     not an admission: it is applied to names this build already owns (see
 *     `KnownEnvKey`), because shape is not membership. It used to be the
 *     admission for a key a newer server reports, and that was a hole — an
 *     upper-snake-case key off the wire looks exactly like a variable name and
 *     was printed as a row label, while differently-shaped ones were refused. A
 *     key outside this build's own set is now counted and never named.
 *   - `safeToken` — a value admitted by SHAPE against a pattern this build
 *     declared, for the few server strings whose whole content is pinned by a
 *     format: a 40-hex git revision is the case it exists for. It is
 *     `reportAllowlist.ts`'s `admitToken` plus the brand, so a row and the two
 *     copyable reports admit a token by one rule rather than three.
 *
 * `note`, `detail` and `title` stay plain `string` because they are prose written
 * by this build, and prose is what makes a row useful. They are rendered on
 * screen and they are NOT a path into the copyable report — `reportLines` is, and
 * every line in it is a `SafeValue`.
 *
 * The brand is a nominal type, not a cryptographic one: `'host:1234' as SafeValue`
 * still compiles. That is intentional. The goal is that no violation can happen by
 * accident and that every deliberate one is a single greppable expression — and
 * `diagnosticsSections.spec.ts` greps the section modules for it.
 *
 * -------------------------------------------------------------------------------
 * 2. `Evidence`: a row may not claim more than its source establishes.
 * -------------------------------------------------------------------------------
 *
 * The live instance. The pane renders a green "SYNC_ITEMS Advertised" chip from
 * `gate.syncItemsAdvertised`, which the server derives from
 * `container.isBound(ApiGateway_GRPCSyncingServerServiceProxy)`
 * (`api-gateway/bin/server.ts`). The handshake advertises SYNC_ITEMS only if
 * `backend.ready()` (`syncCommandHandler.ts`), which ADDITIONALLY requires a
 * usable internal gRPC auth secret of at least 32 bytes. A deployment with the
 * proxy bound and a short or absent secret therefore gets a green chip over a
 * socket that withholds the operation, and every client silently syncs over HTTP.
 *
 * The chip was not wrong about its input. It was wrong about what its input
 * established. So a row does not state a tone; it states a `verdict` and the
 * `Evidence` the verdict rests on, and the tone is DERIVED:
 *
 *   - `EVIDENCE_DIRECT` — the source is the thing the row describes. Any verdict.
 *   - `evidenceProxy(...)` — a weaker signal standing in for it. A verdict that
 *     asserts the thing WORKS (`healthy`, `degraded`) is capped to
 *     `undetermined`. A `broken` verdict survives only if the proxy is a
 *     necessary condition, because a necessary condition failing is conclusive
 *     while a merely correlated one is not.
 *   - `EVIDENCE_ABSENT` — nothing was reported. Every verdict caps to
 *     `undetermined`.
 *
 * When a cap happens the row carries a `caveat` naming what was observed and what
 * it does not establish, so the screen says why it is withholding the stronger
 * claim instead of silently downgrading.
 *
 * The caveat is held to the same standard as the verdict, because the first
 * version of this file was not. It printed "a condition X requires. Its failure
 * is conclusive" for EVERY uncapped proxy row. That is true of a necessary
 * condition and false of a merely correlated one — and an `informational` or
 * `undetermined` claim is not capped on either, so `verdict === claimed` held and
 * the sentence went out over a signal whose author had explicitly declared
 * `necessaryCondition: false`. A caveat that overstates is this file's own defect
 * one level down. So the proxy arm stores a CLOSED `ProxyRelation` instead of the
 * boolean it is derived from, and BOTH the cap and the sentence are selected from
 * it by exhaustive `Record`s: a relation nobody wrote a sentence for fails
 * compilation rather than inheriting the other relation's.
 *
 * -------------------------------------------------------------------------------
 * 3. "Could not determine" is a state, not a shade of "unavailable".
 * -------------------------------------------------------------------------------
 *
 * `undetermined` is a first-class `Verdict` with its own chip label, distinct from
 * `broken`. The bug this closes is already recorded in this directory: a
 * `good ? 'Healthy' : warn ? 'Degraded' : 'Unavailable'` ternary gave the neutral
 * tone — which means "no verdict at all" — the label "Unavailable", so a failure
 * to READ the diagnostics endpoint rendered as a confident claim that the socket
 * was down. Every mapping out of `Verdict` and `Tone` in this file is an
 * exhaustive `Record`, so a verdict added later fails compilation rather than
 * quietly inheriting someone else's label.
 *
 * Absent is also not false (rule 3 of the section contract): every server field a
 * builder reads is optional, and `recorded !== true` or `undefined` must produce
 * "not reported" — never a negative verdict. The three-valued `safeYesNo`,
 * `safePresence` and `safeState` constructors exist so that writing it the wrong
 * way takes more effort than writing it the right way.
 */

/* -------------------------------------------------------------------------- */
/* Section identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The five topic sections, as a VALUE as well as a type, so "exhaustive over the
 * sections" is checkable by a test and not only by the compiler.
 *
 * Overview, Checks and Copyable report are deliberately absent: they are not
 * topic sections. Overview is a router over these five, Checks is the single
 * surface where the operator presses a button that mints a real server-side
 * ticket, and the report is an output of all of them.
 */
export const SECTION_IDS = ['websocket', 'environment', 'backend', 'account', 'browser'] as const

export type SectionId = (typeof SECTION_IDS)[number]

/* -------------------------------------------------------------------------- */
/* SafeValue                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A string that has been reduced to one of the categories the presence-only
 * contract permits. Obtainable only from the constructors below.
 *
 * It is a subtype of `string`, so a consumer — the renderer, the report builder —
 * uses it exactly like a string with no unwrapping. The constraint binds
 * producers, which is where the hazard is.
 */
export type SafeValue = string & { readonly __diagnosticSafeValue: 'presence-only' }

const mint = (value: string): SafeValue => value as unknown as SafeValue

/** Printed where a closed enum received something outside its declared tuple. */
export const UNRECOGNISED = 'other (unrecognised)'

/**
 * Accept a string LITERAL only.
 *
 * `string extends T` is true exactly when the argument's type widened to
 * `string` — which is what every server-supplied field, every thrown message and
 * every interpolated template is — and the parameter then resolves to `never`, so
 * the call does not compile. A closed enum off the wire, typed
 * `'grpc' | 'unset' | 'other'`, is a union of literals and passes, which is
 * correct: a closed enum is a permitted category.
 */
export function safeConstant<T extends string>(text: T & (string extends T ? never : unknown)): SafeValue {
  return mint(text)
}

/**
 * What a row prints when the FIELD it reports has no producer at all — as opposed
 * to a field that has one and did not report this time.
 *
 * *** THE DIFFERENCE AN OPERATOR ACTUALLY READS. *** "not reported" is the right
 * word for a reading that could have arrived and did not, and it invites exactly
 * one question: why not? On a row whose field nothing in the system emits, that
 * question has no answer and the operator was sent looking for a defect in a pane
 * that was working correctly — which is the complaint that produced this constant.
 * Saying so in the value costs one line and closes the question in place.
 *
 * Use it ONLY where the absence is structural and permanent until something is
 * built. A field that is merely absent on this run must keep "not reported": a row
 * that claims nothing can ever report it, when something can, is the same lie in
 * the other direction.
 */
export const NOT_PUBLISHED: SafeValue = mint('no endpoint publishes this')

/**
 * *** THREE MORE SILENCES, EACH OF WHICH USED TO READ "not reported". ***
 *
 * Measured on a healthy deployment the operator pasted: 13 rows read exactly
 * `not reported`, and the pane counted every one of them as "asked for and
 * nothing came back" — which made each section, and the headline over them, read
 * UNKNOWN on a server where nothing was wrong. They were three different facts:
 *
 *   - NOTHING TO REPORT. "Most recent gRPC failure" beside a failure count of
 *     zero; "Why the read failed" on a read that answered; "FILES_V1 unmet
 *     condition" with none unmet. The row describes an event that did not happen,
 *     and the absence of an event is not a missing reading.
 *   - NOT AVAILABLE HERE. `navigator.deviceMemory` on Gecko; the role names no
 *     client surface exposes. Nothing went unanswered: there is nobody to ask.
 *     `NOT_PUBLISHED` above is the same fact about a server endpoint.
 *   - NOT TESTED. A check that establishes the row exists and nobody has run it.
 *     The operator's next action is one button, which "unknown" does not say.
 *
 * Only the fourth — asked, and nothing came back — is `NOT_REPORTED`, and only
 * that one may stop a headline from reading OK on its own.
 *
 * Each takes a LITERAL qualifier, exactly as `safeConstant` does, so the reason
 * printed in the copyable report is this build's own words and never a server's.
 * The fixed prefix is what `readingOf` matches, which keeps the reading derived
 * from the value: there is still no second place for a builder to state a reading
 * that disagrees with what its row prints.
 */
export const NOTHING_TO_REPORT = 'nothing to report'
export const NOT_AVAILABLE_HERE = 'not available here'
export const NOT_TESTED = 'not tested'

export function safeNothingToReport<T extends string>(why: T & (string extends T ? never : unknown)): SafeValue {
  return mint(`${NOTHING_TO_REPORT} (${why})`)
}

export function safeNotAvailableHere<T extends string>(why: T & (string extends T ? never : unknown)): SafeValue {
  return mint(`${NOT_AVAILABLE_HERE} (${why})`)
}

export function safeNotTested<T extends string>(how: T & (string extends T ? never : unknown)): SafeValue {
  return mint(`${NOT_TESTED} (${how})`)
}

/** `yes` / `no` / `not reported`. Three-valued because absent is not false. */
export function safeYesNo(value: boolean | undefined): SafeValue {
  return mint(value === true ? 'yes' : value === false ? 'no' : NOT_REPORTED)
}

/** `set` / `not set` / `not reported`, for a configuration-presence boolean. */
export function safePresence(value: boolean | undefined): SafeValue {
  return mint(value === true ? 'set' : value === false ? 'not set' : NOT_REPORTED)
}

/**
 * A boolean rendered in the row's own words — `attached` / `not attached`,
 * `issuing` / `refusing`. Both words must be literals from this build.
 */
export function safeState<WhenTrue extends string, WhenFalse extends string>(
  value: boolean | undefined,
  whenTrue: WhenTrue & (string extends WhenTrue ? never : unknown),
  whenFalse: WhenFalse & (string extends WhenFalse ? never : unknown),
): SafeValue {
  return mint(value === true ? whenTrue : value === false ? whenFalse : NOT_REPORTED)
}

/**
 * Admit a value only if it is one of `allowed`; never echo it otherwise.
 *
 * This is the constructor every server-reported enum goes through. An unknown
 * code collapses to a constant rather than being printed, so a future server
 * field — or a misbehaving one — cannot put arbitrary bytes on the screen or in
 * the report through a field this build believed was an enum.
 */
export function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): SafeValue {
  if (value === undefined || value === null) {
    return mint(NOT_REPORTED)
  }
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? mint(value) : mint(UNRECOGNISED)
}

/**
 * A bounded count. Non-integers, negatives, NaN and Infinity are "not reported"
 * rather than printed: a counter that arrives malformed is a fact about the
 * server, not a number to render.
 */
export function safeCount(value: number | undefined): SafeValue {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return mint(NOT_REPORTED)
  }
  return mint(String(value))
}

/**
 * A duration, explicitly permitted by the secrecy contract — and deliberately
 * NOT a timestamp. "Has the container restarted since I changed that setting?" is
 * the most-asked question in this area and an uptime answers it; an absolute
 * instant additionally lets a reader of the public report line this deployment up
 * against other logs, and buys nothing.
 */
export function safeDuration(seconds: number | undefined): SafeValue {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return mint(NOT_REPORTED)
  }

  const whole = Math.floor(seconds)
  if (whole < 1) {
    return mint('under 1s')
  }
  if (whole < 60) {
    return mint(`${whole}s`)
  }
  if (whole < 3600) {
    return mint(`${Math.floor(whole / 60)}m ${whole % 60}s`)
  }
  if (whole < 86400) {
    return mint(`${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`)
  }
  return mint(`${Math.floor(whole / 86400)}d ${Math.floor((whole % 86400) / 3600)}h`)
}

/** The closed buckets a magnitude is reduced to before it may be reported. */
export const PERCENT_BUCKETS = ['0-25%', '25-50%', '50-75%', '75-90%', '90-100%', 'over 100%'] as const

/**
 * A fraction as one of six buckets.
 *
 * The user-space section is the first part of this pane to hold real user data —
 * origin storage usage, a file-upload quota. A bucket answers the diagnostic
 * question ("is this origin about to be evicted?") without putting a figure about
 * one person's vault into a report written to be pasted in public.
 */
export function safePercentBucket(fraction: number | undefined): SafeValue {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) {
    return mint(NOT_REPORTED)
  }
  if (fraction > 1) {
    return mint('over 100%')
  }
  if (fraction < 0.25) {
    return mint('0-25%')
  }
  if (fraction < 0.5) {
    return mint('25-50%')
  }
  if (fraction < 0.75) {
    return mint('50-75%')
  }
  if (fraction < 0.9) {
    return mint('75-90%')
  }
  return mint('90-100%')
}

/**
 * The shape an environment variable NAME has in this project: upper snake case.
 */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * An environment variable name, admitted by shape and refused — not repaired —
 * otherwise. The same discipline as `admitToken`: a partially scrubbed string is
 * not safe, whereas a constant is.
 *
 * SHAPE IS NOT MEMBERSHIP, and this constructor is no longer asked to pretend
 * otherwise. It sits under names that are already literals of this build, as a
 * floor against a name that drifts out of the project's own convention; the
 * question "did the server choose this string" is answered by a closed set
 * before a value ever gets here.
 */
export function safeEnvName(name: unknown): SafeValue {
  if (typeof name !== 'string') {
    return mint(NOT_REPORTED)
  }
  return ENV_NAME.test(name) ? mint(name) : mint(WITHHELD)
}

/**
 * A token admitted by SHAPE against a pattern this build declared, and refused —
 * not repaired — otherwise.
 *
 * THE GAP THIS CLOSES. A 40-character git revision is not a constant of this
 * build, not a boolean, not a member of a closed enum, not a count and not a
 * duration, so before this constructor existed the Environment section could not
 * print the deployment revision at all: it reported the identity's STATE and sent
 * the reader to the copyable report for the revision itself, which had been
 * admitting it by shape — under its own rule — all along.
 *
 * There is now ONE rule. This is `admitToken` with the brand applied, so a row,
 * the capability report and the health report cannot disagree about what counts
 * as a revision, and loosening the shape loosens all three at once.
 *
 * WHY THE PATTERN CANNOT COME OFF THE WIRE. `DeclaredPattern` is obtainable only
 * from `declarePattern`, whose source must be a string LITERAL and must be
 * anchored. So the shape is always one this build wrote, and admitting a value
 * against a shape derived from that same server is not expressible — which it
 * would need to be for the admission to be circular.
 *
 * A value that does not match becomes `WITHHELD`; the rejected value is NEVER
 * echoed, not even in part, exactly as in `safeEnum` and `safeEnvName`. A
 * partially scrubbed string is not safe; a constant is.
 */
export function safeToken(value: unknown, pattern: DeclaredPattern): SafeValue {
  return mint(admitToken(value, pattern))
}

/** Join already-safe parts, for a value like `redis (ready)`. */
export function safeTokens(...parts: readonly SafeValue[]): SafeValue {
  return mint(parts.join(' '))
}

/** One markdown line for the copyable report. Both halves are already safe. */
export function reportLine(label: SafeValue, value: SafeValue): SafeValue {
  return mint(`- ${label}: ${value}`)
}

/**
 * One ROW as a report line, carrying its STATUS tag.
 *
 * Separate from `reportLine` on purpose: `reportLine` also mints the handful of
 * lines a section writes by hand (`extraReportLines`), which are statements about
 * the section rather than readings of a field and have no status to carry. Only a
 * real row gets a tag, so the tag column means exactly one thing.
 *
 * *** THE TAG IS THE VERDICT NOW, AND IT USED TO BE THE READING. *** The line
 * began `[v]`, `[?]` or `[n]` — whether a value had arrived — so a row could read
 * `[v] Roles held by this account: not exposed by any client surface` and be
 * counted as an answer, and nothing on any line of a 560-line paste said whether
 * the fact it carried was good news. The reading is still in the line: it is the
 * value. What the reader could not get from the value was the verdict.
 *
 * The tag comes from an exhaustive `Record` over `Verdict`, so it is a literal of
 * this build whatever the server sent.
 */
export function reportRow(row: {
  readonly label: SafeValue
  readonly value: SafeValue
  readonly verdict: Verdict
}): SafeValue {
  return mint(`- [${STATUS_TAG[row.verdict]}] ${row.label}: ${row.value}`)
}

/* -------------------------------------------------------------------------- */
/* The silences                                                               */
/* -------------------------------------------------------------------------- */

/**
 * *** FIVE DIFFERENT FACTS, AND FOUR OF THEM USED TO READ ALIKE. ***
 *
 * The pane models absence carefully — `safeYesNo` and friends are three-valued so
 * an absent field cannot read as `false` — and then printed every kind of absence
 * as the one sentence `not reported`. On the deployment this was last measured on,
 * 13 of 205 rows read exactly that, every one was counted as "asked for and
 * nothing came back", and that count alone made all five sections and the
 * headline read UNKNOWN over a server with nothing wrong with it.
 *
 * So the distinction is a CLOSED value derived from the row, once, here:
 *
 *   - `answered`       — the server (or the browser) produced a value. This
 *     includes a value that was refused on the way out: `withheld (unrecognised
 *     format)` and `other (unrecognised)` are both readings, and a reading is not
 *     a silence. That matters for the census, which would otherwise count a
 *     misbehaving server as a quiet one.
 *   - `unanswered`     — this build asked and nothing came back. The question
 *     "why not?" is open, and this is the ONE silence worth asking it of.
 *   - `untested`       — a check that establishes the row exists and has not been
 *     run. Not a mystery: the next action is one button.
 *   - `not-applicable` — the row describes something that did not happen, so there
 *     is nothing to say. The absence of a failure is not a missing reading.
 *   - `unavailable`    — nothing here can produce the value at all: no endpoint
 *     publishes it, no client surface exposes it, or this browser does not offer
 *     the API. The same question has no answer, and the row says so.
 *
 * Derived from the VALUE rather than stored on the row, deliberately: the value
 * is minted by the constructors above, which are the only things that can produce
 * a sentinel, so there is no second place for a builder to state a reading that
 * disagrees with what its row actually prints.
 */
export const ROW_READINGS = ['answered', 'unanswered', 'untested', 'not-applicable', 'unavailable'] as const

export type RowReading = (typeof ROW_READINGS)[number]

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The on-screen tag for the four silences. */
export const READING_TAG: Record<RowReading, string> = {
  answered: 'answered',
  unanswered: 'no answer',
  untested: 'not tested',
  'not-applicable': 'nothing to report',
  unavailable: 'not available here',
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** What each reading MEANS, in one line. */
export const READING_MEANING: Record<RowReading, string> = {
  answered: 'a value arrived',
  unanswered: 'this build asked and nothing came back',
  untested: 'a check establishes this and it has not been run yet',
  'not-applicable': 'the row describes something that did not happen, so there is nothing to say',
  unavailable: 'nothing here can produce the value — no endpoint, client surface or browser API offers it',
}

/** Whether `value` is the sentinel itself or the sentinel joined to a qualifier. */
const opensWith = (value: string, sentinel: string): boolean => value === sentinel || value.startsWith(`${sentinel} `)

/**
 * Which silence — or none — a value represents.
 *
 * Matched by PREFIX rather than equality, because several rows join a sentinel to
 * a qualifier (`nothing to report (no failure recorded)`), and anchored at the
 * start so a row whose value merely CONTAINS the words — `not set (threshold not
 * established: no lane decision reported)` is a real one — stays `answered`,
 * which it is.
 */
export function readingOf(value: string): RowReading {
  if (opensWith(value, NOT_PUBLISHED) || opensWith(value, NOT_AVAILABLE_HERE)) {
    return 'unavailable'
  }
  if (opensWith(value, NOTHING_TO_REPORT)) {
    return 'not-applicable'
  }
  if (opensWith(value, NOT_TESTED)) {
    return 'untested'
  }
  if (opensWith(value, NOT_REPORTED)) {
    return 'unanswered'
  }
  return 'answered'
}

/** How many rows of each reading. Always every key, so a zero is a reading. */
export function readingCensus(rows: readonly { readonly value: SafeValue }[]): Record<RowReading, number> {
  const census: Record<RowReading, number> = {
    answered: 0,
    unanswered: 0,
    untested: 0,
    'not-applicable': 0,
    unavailable: 0,
  }
  for (const row of rows) {
    census[readingOf(row.value)] += 1
  }

  return census
}

/**
 * The census as one sentence, for a block header and for the report.
 *
 * Every non-zero reading is named with its count; a reading at zero is omitted
 * because the sentence is read beside the rows themselves, where an absent group
 * is visible. A block with no rows at all says so instead — `isBlockEmpty` and
 * `emptyNote` already own that case and it must not come out as "0 answered".
 */
export function describeCensus(census: Record<RowReading, number>): string {
  const parts = ROW_READINGS.filter((reading) => census[reading] > 0).map(
    (reading) => `${census[reading]} ${READING_TAG[reading]}`,
  )

  return parts.length === 0 ? 'no rows' : parts.join(' · ')
}

/* -------------------------------------------------------------------------- */
/* Verdicts, evidence and tone                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a row or finding claims, as a VALUE as well as a type.
 *
 * `undetermined` and `informational` are not spare slots and are not shades of
 * `broken`. `undetermined` means the panel does not know — the single most
 * important thing this task adds, because the state the pane used to render as
 * "Unavailable" was usually this one. `informational` means the row carries
 * context with no verdict at all, like a CPU count.
 *
 * *** `untested` AND `not-applicable` ARE NOT SHADES OF `undetermined` EITHER. ***
 * They were split out of it, because `undetermined` had become the pane's answer
 * to four different situations and a healthy deployment read UNKNOWN from top to
 * bottom as a result:
 *
 *   - `untested` — a check exists that establishes this, and it has not been run.
 *     The reader's next action is known and is one button. It still stops a
 *     headline from reading OK, which is the point of keeping it a verdict: an OK
 *     nobody tested is the claim this pane exists to refuse.
 *   - `not-applicable` — there is nothing to judge. The row describes a failure
 *     that did not occur, or a value nothing here can produce. It carries no
 *     weight in either direction and ranks below even `informational`.
 *
 * What is left in `undetermined` is the one case that deserves the word: a
 * reading that should have arrived and did not.
 */
export const VERDICTS = [
  'healthy',
  'degraded',
  'broken',
  'undetermined',
  'untested',
  'not-applicable',
  'informational',
] as const

export type Verdict = (typeof VERDICTS)[number]

/**
 * How much an operator should care, lowest first. Used to pick a section's worst
 * verdict for the summary, the sub-tab chip and the headline.
 *
 * `undetermined` sits ABOVE `healthy` and below `degraded` on purpose: a section
 * that could not establish its facts is worth opening, and is not worth opening
 * ahead of one that is actually degraded. `untested` sits just beneath it — both
 * keep a headline off OK, and a reading that failed to arrive is the more
 * surprising of the two. `not-applicable` is the floor: it is the only verdict
 * that says there was nothing to look at.
 */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  'not-applicable': 0,
  informational: 1,
  healthy: 2,
  untested: 3,
  undetermined: 4,
  degraded: 5,
  broken: 6,
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE — the fall-through WAS the bug. ***
 *
 * The chip label for each verdict, in the fewest plain words that cannot be taken
 * for one another. Three verdicts paint with a quiet tone and must not share a
 * label: "Unknown" is the panel admitting it cannot tell, "Not tested" is a check
 * nobody has run, and "Info" is a row that was never a verdict. The ternary chain
 * this replaces (`tone === 'good' ? 'OK' : tone === 'bad' ? 'Down' : 'Note'`)
 * could express none of them.
 */
export const VERDICT_CHIP_LABEL: Record<Verdict, string> = {
  healthy: 'OK',
  degraded: 'Degraded',
  broken: 'Not working',
  undetermined: 'Unknown',
  untested: 'Not tested',
  'not-applicable': 'N/A',
  informational: 'Info',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each verdict MEANS, as a phrase a
 * sentence can be built round. The chip is the word; this is the gloss printed
 * once in each legend, on screen and in the report, so the two cannot describe a
 * status differently.
 */
export const VERDICT_MEANING: Record<Verdict, string> = {
  healthy: 'working',
  degraded: 'working, with something lost',
  broken: 'not working',
  undetermined: 'could not be checked — a reading that should have arrived did not',
  untested: 'not tested yet — a check establishes it and has not been run',
  'not-applicable': 'not applicable here — nothing to judge',
  informational: 'context only, no verdict',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The tag at the head of every row in the
 * copyable report. Upper case and spelled out: the report is read without the
 * pane, without colour and without icons, so the word is the whole signal.
 */
export const STATUS_TAG: Record<Verdict, string> = {
  healthy: 'OK',
  degraded: 'DEGRADED',
  broken: 'NOT WORKING',
  undetermined: 'UNKNOWN',
  untested: 'NOT TESTED',
  'not-applicable': 'N/A',
  informational: 'INFO',
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The tone a verdict paints with. */
export const TONE_FOR_VERDICT: Record<Verdict, Tone> = {
  healthy: 'good',
  degraded: 'warn',
  broken: 'bad',
  undetermined: 'neutral',
  untested: 'neutral',
  'not-applicable': 'neutral',
  informational: 'neutral',
}

/**
 * Whether a verdict keeps a section, and the headline over it, from reading OK.
 *
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The two that paint quietly and still
 * block are the ones this record exists for: `undetermined` and `untested` have no
 * alarming colour, and a headline derived from colour alone would step over both.
 */
export const BLOCKS_OK: Record<Verdict, boolean> = {
  healthy: false,
  degraded: true,
  broken: true,
  undetermined: true,
  untested: true,
  'not-applicable': false,
  informational: false,
}

/**
 * How a proxy signal relates, LOGICALLY, to the thing the row describes — as a
 * VALUE as well as a type, so "exhaustive over the relations" is checkable by a
 * test and not only by the compiler.
 *
 * It is a closed set rather than the boolean a section author supplies because
 * TWO different things are derived from it — whether a `broken` claim survives,
 * and which caveat sentence is printed — and the second of those was once derived
 * by falling out of the bottom of an `if`, which is how the "its failure is
 * conclusive" sentence came to be printed over a merely correlated signal.
 *
 * `necessary` — the thing described cannot work unless the observed signal holds.
 * Its failure is conclusive; its success establishes nothing.
 * `correlated` — the signal travels with the thing described but is not required
 * by it. Neither its success nor its failure establishes anything.
 */
export const PROXY_RELATIONS = ['necessary', 'correlated'] as const

export type ProxyRelation = (typeof PROXY_RELATIONS)[number]

/**
 * A weaker signal standing in for the thing a row describes.
 *
 * It carries prose because the prose IS the mechanism: a capped row has to be
 * able to say "this reads that the gRPC proxy is bound, which does not establish
 * that the handshake advertises SYNC_ITEMS".
 */
export type ProxyEvidence = {
  readonly kind: 'proxy'
  /** What was actually read, in this build's words. */
  readonly observed: string
  /** The thing the row is ABOUT, which the observation only implies. */
  readonly cannotConfirm: string
  /**
   * The logical relationship, closed. Stored instead of the boolean it is built
   * from so that nothing downstream can branch on it with an `else`.
   */
  readonly relation: ProxyRelation
  /**
   * The DIRECT observation of the thing this signal only implies, when the pane
   * has a way to make one. See `Witness`.
   */
  readonly confirmedBy?: Witness
}

/**
 * A direct observation of something a proxy row can only imply.
 *
 * *** WHY THIS EXISTS: THE CAP WAS RIGHT AND ITS RESULT WAS UNUSABLE. *** A row
 * resting on a necessary condition may not claim the thing works — that rule is
 * the pane's reason for being believed, and it stays. But the cap's only answer
 * was `undetermined`, so on a healthy deployment thirty-three rows read "Unknown"
 * for ever: the socket lane was built, the gateway attached, every required
 * variable set, six internal probes answering — and each of them unknown, because
 * each is necessary for something it cannot establish. Nothing the operator did
 * could clear one. A verdict that cannot be cleared is not information.
 *
 * What a capped row is missing is not more hedging. It is the observation it
 * stands in for — and in most cases the pane CAN make that observation: "that a
 * client is being admitted onto the lane now" is this tab's own socket being
 * READY; "that an authorized file transfer works" is an upload and a read-back.
 * A witness is that observation, handed to the row that needs it. The row still
 * cannot claim anything on its own evidence. It can now say who can.
 *
 * `state` is closed, and each member is a different sentence:
 *
 *   - `confirmed`   — the direct observation was made and held. The row reads OK,
 *     and says what confirmed it.
 *   - `refuted`     — it was made and did not hold. The row's own condition still
 *     holds, so the fault lies past it; the row carries no verdict and points at
 *     the observation, which reports the failure itself.
 *   - `not-run`     — a check makes the observation and has not been run. The row
 *     reads "not tested" and names the check.
 *   - `unavailable` — it cannot be made from here, for a stated reason that is not
 *     a fault (a tab that is deliberately not the socket's owner cannot observe
 *     the socket). No verdict.
 *   - `unknown`     — nothing says whether it was made. The row keeps the old
 *     answer, `undetermined`, because that is now the honest one: an observation
 *     that should have been available and was not.
 *
 * `what` and `how` are prose written by this build and are rendered on screen in
 * a caveat only. Neither is a path into the copyable report.
 */
export const WITNESS_STATES = ['confirmed', 'refuted', 'not-run', 'unavailable', 'unknown'] as const

export type WitnessState = (typeof WITNESS_STATES)[number]

export type Witness = {
  readonly state: WitnessState
  /** The observation, as a clause: "this tab's own socket is READY". */
  readonly what: string
  /**
   * For `not-run`, how to make it ("run the file round trip check"). For
   * `unavailable`, why it cannot be made here. Unused otherwise.
   */
  readonly how?: string
}

/**
 * An event that did not happen, or a value nothing here can produce.
 *
 * `because` is REQUIRED and is the whole discipline of these two arms: "nothing to
 * report" is a claim, and the claim is only as good as the observation it rests
 * on. "Most recent gRPC failure" is not applicable BECAUSE the gateway reported
 * its fallback counters and both read zero — and where those counters are absent
 * the row must go on reading `not reported`, since a failure nobody counted is
 * not a failure that did not happen. A builder cannot reach either arm without
 * writing that sentence down, and the renderer prints it under the row.
 */
export type SettledAbsenceEvidence =
  | { readonly kind: 'not-applicable'; readonly because: string }
  | { readonly kind: 'unavailable'; readonly because: string }

/** A check exists that establishes this row, and it has not been run. */
export type UntestedEvidence = {
  readonly kind: 'untested'
  /** How to run it, in the reader's terms. Printed under the row. */
  readonly how: string
}

/** What a verdict rests on. */
export type Evidence =
  { readonly kind: 'direct' } | ProxyEvidence | { readonly kind: 'absent' } | SettledAbsenceEvidence | UntestedEvidence

export const EVIDENCE_DIRECT: Evidence = { kind: 'direct' }

export const EVIDENCE_ABSENT: Evidence = { kind: 'absent' }

/** Nothing happened that this row would describe. `because` names what established that. */
export function evidenceNothingToReport(because: string): Evidence {
  return { kind: 'not-applicable', because }
}

/** Nothing here can produce this value at all. `because` names which surface is missing. */
export function evidenceNotAvailableHere(because: string): Evidence {
  return { kind: 'unavailable', because }
}

/** A check establishes this and has not been run. `how` says which, and how to run it. */
export function evidenceUntested(how: string): Evidence {
  return { kind: 'untested', how }
}

/**
 * `necessaryCondition` stays a boolean at this boundary deliberately: it is the
 * one bit a section author actually decides, every section in the tree already
 * states it that way, and this is the single expression in the codebase that
 * turns it into the closed relation everything else reads.
 *
 * True when the observed signal is a NECESSARY condition of the thing described.
 * A necessary condition failing is conclusive, so a `broken` verdict survives; a
 * merely correlated signal establishes nothing in either direction and caps to
 * `undetermined`.
 *
 * `confirmedBy` is the direct observation of `cannotConfirm`, when one exists. It
 * changes what a POSITIVE claim resolves to and nothing else — see `capVerdict`.
 */
export function evidenceProxy(input: {
  observed: string
  cannotConfirm: string
  necessaryCondition: boolean
  confirmedBy?: Witness
}): Evidence {
  return {
    kind: 'proxy',
    observed: input.observed,
    cannotConfirm: input.cannotConfirm,
    relation: input.necessaryCondition ? 'necessary' : 'correlated',
    ...(input.confirmedBy === undefined ? {} : { confirmedBy: input.confirmedBy }),
  }
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What a `healthy` claim on a proxy
 * resolves to, per state of the observation that would confirm it.
 *
 * This is the only place a proxy row can come to read OK, and it does so on the
 * WITNESS's evidence, never on its own: `confirmed` is the single member that
 * yields `healthy`. `unknown` keeps the answer the cap has always given, so a
 * caller that supplies no witness — every section spec written before witnesses
 * existed — sees exactly the verdict it saw before.
 */
const HEALTHY_CLAIM_ON_PROXY: Record<WitnessState, Verdict> = {
  confirmed: 'healthy',
  refuted: 'informational',
  'not-run': 'untested',
  unavailable: 'informational',
  unknown: 'undetermined',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** Whether a `broken` claim survives on
 * each relation. A necessary condition failing is conclusive; a correlated signal
 * failing establishes nothing, so the claim caps to `undetermined`.
 */
const BROKEN_SURVIVES: Record<ProxyRelation, boolean> = {
  necessary: true,
  correlated: false,
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE — the fall-through WAS the bug, twice. ***
 *
 * The sentence printed on an UNCAPPED proxy row, which is the row that keeps its
 * claim and therefore has to describe the relationship it kept it on. There is one
 * sentence per relation and no default, so the `necessary` sentence — the one that
 * asserts "its failure is conclusive" — cannot reach a `correlated` signal, which
 * is exactly what it used to do for any `informational` or `undetermined` claim.
 */
const PROXY_CAVEAT: Record<ProxyRelation, (evidence: ProxyEvidence) => string> = {
  necessary: (evidence) =>
    `Indirect: this reads ${evidence.observed}, a condition ${evidence.cannotConfirm} requires. Its failure is conclusive; its success would not have been.`,
  correlated: (evidence) =>
    `Indirect: this reads ${evidence.observed}, which travels with ${evidence.cannotConfirm} without being required by it. Neither its success nor its failure establishes ${evidence.cannotConfirm}, so no verdict is claimed from it.`,
}

/**
 * Cap a claim at what its evidence establishes. The whole point of the pane.
 *
 * THE FOUR SETTLED ARMS FIRST. Direct evidence carries any claim. Absent evidence
 * carries none. The two settled absences are `not-applicable` whatever was
 * claimed, and an untested row is `untested` whatever was claimed — a builder
 * cannot make one of those rows read OK by asking for it.
 *
 * THE PROXY ARM. A `healthy` claim resolves on the witness, and only a confirmed
 * witness yields `healthy`. A `degraded` claim is a suspicion of loss resting on
 * indirect evidence, and stays `undetermined` with or without a witness: a
 * witness establishes that the thing works, and that is not what the row is
 * suggesting. A `broken` claim survives on a necessary condition and on nothing
 * else, exactly as before.
 */
function capVerdict(claimed: Verdict, evidence: Evidence): Verdict {
  if (evidence.kind === 'direct') {
    return claimed
  }
  if (evidence.kind === 'absent') {
    return 'undetermined'
  }
  if (evidence.kind === 'not-applicable' || evidence.kind === 'unavailable') {
    return 'not-applicable'
  }
  if (evidence.kind === 'untested') {
    return 'untested'
  }
  if (claimed === 'healthy') {
    return HEALTHY_CLAIM_ON_PROXY[evidence.confirmedBy?.state ?? 'unknown']
  }
  if (claimed === 'degraded') {
    return 'undetermined'
  }
  if (claimed === 'broken' && !BROKEN_SURVIVES[evidence.relation]) {
    return 'undetermined'
  }
  return claimed
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The sentence under a proxy row whose
 * `healthy` claim was resolved on a witness, one per state.
 *
 * Every one of them restates what the row itself read, because the resolution
 * must never read as the row having proved something: the row's evidence is
 * unchanged, and what moved its verdict is named beside it.
 */
const WITNESSED_CAVEAT: Record<WitnessState, (evidence: ProxyEvidence, witness: Witness | undefined) => string> = {
  confirmed: (evidence, witness) =>
    `Confirmed directly: ${witness?.what ?? ''}. On its own this row reads ${evidence.observed}, which is necessary and would not have been enough.`,
  refuted: (evidence, witness) =>
    `This reads ${evidence.observed}, and yet ${witness?.what ?? ''} did NOT hold. So the condition here is met and the fault lies past it — the row that reports that observation carries the verdict; this one claims none.`,
  'not-run': (evidence, witness) =>
    `This reads ${evidence.observed}, which is necessary for ${evidence.cannotConfirm} and does not establish it. Not tested yet: ${witness?.how ?? 'run the checks on this pane'}.`,
  unavailable: (evidence, witness) =>
    `This reads ${evidence.observed}. Whether ${evidence.cannotConfirm} cannot be confirmed from here: ${witness?.how ?? 'no direct observation is available'}. No verdict is claimed, and that is not a fault.`,
  unknown: (evidence) =>
    `This reads ${evidence.observed}, which does not establish ${evidence.cannotConfirm}. Reported as undetermined rather than claiming it.`,
}

function caveatFor(claimed: Verdict, verdict: Verdict, evidence: Evidence): string | undefined {
  if (evidence.kind === 'direct') {
    return undefined
  }
  if (evidence.kind === 'absent') {
    return claimed === 'undetermined'
      ? undefined
      : 'Nothing was reported for this, so no verdict is claimed. An unreported field is not a negative answer.'
  }
  if (evidence.kind === 'not-applicable' || evidence.kind === 'unavailable') {
    return evidence.because
  }
  if (evidence.kind === 'untested') {
    return `Not tested yet: ${evidence.how}.`
  }
  if (claimed === 'healthy') {
    return WITNESSED_CAVEAT[evidence.confirmedBy?.state ?? 'unknown'](evidence, evidence.confirmedBy)
  }
  if (verdict !== claimed) {
    return `This reads ${evidence.observed}, which does not establish ${evidence.cannotConfirm}. Reported as undetermined rather than claiming it.`
  }
  return PROXY_CAVEAT[evidence.relation](evidence)
}

/* -------------------------------------------------------------------------- */
/* Rows, findings, blocks and the section model                               */
/* -------------------------------------------------------------------------- */

/**
 * One fact. The same shape `TopologyFact`, `RealtimeHealthRow` and
 * `EnvironmentRow` already are, plus the evidence discipline.
 *
 * Built only by `diagnosticRow` — the brand is unforgeable by a plain object
 * literal — so there is no way to express a tone that disagrees with its
 * evidence.
 */
export type DiagnosticRow = {
  readonly label: SafeValue
  readonly value: SafeValue
  /** The verdict the builder stated, before any cap. Kept so the cap is visible. */
  readonly claimed: Verdict
  /** The verdict after capping. Equal to `claimed` unless the evidence is weaker. */
  readonly verdict: Verdict
  readonly tone: Tone
  readonly evidence: Evidence
  /** Present when the evidence is indirect: what it does and does not establish. */
  readonly caveat?: string
  /** What this row means when it reads badly — and, as often, when it does not. */
  readonly note: string
  readonly __diagnosticRow: 'built-by-diagnosticRow'
}

export type DiagnosticRowInput = {
  label: SafeValue
  value: SafeValue
  verdict: Verdict
  evidence: Evidence
  note: string
}

export function diagnosticRow(input: DiagnosticRowInput): DiagnosticRow {
  const verdict = capVerdict(input.verdict, input.evidence)
  const caveat = caveatFor(input.verdict, verdict, input.evidence)

  return {
    label: input.label,
    value: input.value,
    claimed: input.verdict,
    verdict,
    tone: TONE_FOR_VERDICT[verdict],
    evidence: input.evidence,
    ...(caveat === undefined ? {} : { caveat }),
    note: input.note,
  } as unknown as DiagnosticRow
}

/**
 * Something an operator has to act on, or know about.
 *
 * `code` is the ONLY part of a finding that enters the copyable report. `title`
 * and `detail` are prose for the screen: they are written by this build, but they
 * are `string`, so a builder COULD interpolate a server-supplied value into one
 * and nothing in the type system would notice. Keeping them off the report path
 * means that mistake stays on the operator's own screen instead of being pasted
 * into an issue tracker. A `Remedy` is exempt because its own constructor already
 * redacts the one server-authored string it carries.
 */
export type DiagnosticFinding = {
  /** A stable, closed identifier — `safeConstant('SYNC_ITEMS_WITHHELD')`. */
  readonly code: SafeValue
  readonly title: string
  readonly detail: string
  readonly claimed: Verdict
  readonly verdict: Verdict
  readonly tone: Tone
  readonly evidence: Evidence
  readonly caveat?: string
  /** Reuses the existing `Remedy` from `diagnosticRemedies.ts`, read-only. */
  readonly remedy?: Remedy
  readonly __diagnosticFinding: 'built-by-diagnosticFinding'
}

export type DiagnosticFindingInput = {
  code: SafeValue
  title: string
  detail: string
  verdict: Verdict
  evidence: Evidence
  remedy?: Remedy
}

export function diagnosticFinding(input: DiagnosticFindingInput): DiagnosticFinding {
  const verdict = capVerdict(input.verdict, input.evidence)
  const caveat = caveatFor(input.verdict, verdict, input.evidence)

  return {
    code: input.code,
    title: input.title,
    detail: input.detail,
    claimed: input.verdict,
    verdict,
    tone: TONE_FOR_VERDICT[verdict],
    evidence: input.evidence,
    ...(caveat === undefined ? {} : { caveat }),
    ...(input.remedy === undefined ? {} : { remedy: input.remedy }),
  } as unknown as DiagnosticFinding
}

/** A headed group of rows and findings inside a section. */
export type DiagnosticBlock = {
  readonly heading: SafeValue
  readonly description: string
  readonly rows: readonly DiagnosticRow[]
  readonly findings: readonly DiagnosticFinding[]
  /**
   * What to say when the block has nothing at all. A block with no rows is
   * normally a server that reported nothing, which is a fact worth a sentence —
   * never an empty panel the operator has to interpret.
   */
  readonly emptyNote?: string
}

export function blockWorstVerdict(block: DiagnosticBlock): Verdict {
  return worstVerdictOf([...block.rows.map((row) => row.verdict), ...block.findings.map((finding) => finding.verdict)])
}

export function isBlockEmpty(block: DiagnosticBlock): boolean {
  return block.rows.length === 0 && block.findings.length === 0
}

/**
 * The worst verdict in a list, or `undetermined` for an empty one.
 *
 * Empty does not mean healthy. A section that produced no rows established
 * nothing, and the Overview router must send the operator to look rather than
 * reassure them.
 */
export function worstVerdictOf(verdicts: readonly Verdict[]): Verdict {
  let worst: Verdict = 'undetermined'
  let severity = -1
  for (const verdict of verdicts) {
    if (VERDICT_SEVERITY[verdict] > severity) {
      severity = VERDICT_SEVERITY[verdict]
      worst = verdict
    }
  }
  return worst
}

/** How many of each verdict. Always every key, so a zero is a count and not an absent one. */
export function verdictCensus(verdicts: readonly Verdict[]): Record<Verdict, number> {
  const census: Record<Verdict, number> = {
    healthy: 0,
    degraded: 0,
    broken: 0,
    undetermined: 0,
    untested: 0,
    'not-applicable': 0,
    informational: 0,
  }
  for (const verdict of verdicts) {
    census[verdict] += 1
  }

  return census
}

/**
 * The verdict census as one short line: `41 OK · 3 not tested · 12 info`.
 *
 * In SEVERITY order, worst first, so the first number a reader meets is the one
 * that decides whether they keep reading — and a verdict at zero is omitted, since
 * this line is read beside the rows it counts. The words are `VERDICT_CHIP_LABEL`'s
 * own, lower-cased, so the line and the chips under it cannot name a status
 * differently.
 */
export function describeVerdictCensus(census: Record<Verdict, number>): string {
  const parts = [...VERDICTS]
    .sort((left, right) => VERDICT_SEVERITY[right] - VERDICT_SEVERITY[left])
    .filter((verdict) => census[verdict] > 0)
    .map((verdict) => `${census[verdict]} ${verdict === 'healthy' ? 'OK' : VERDICT_CHIP_LABEL[verdict].toLowerCase()}`)

  return parts.length === 0 ? 'no rows' : parts.join(' · ')
}

/**
 * The sub-tab label for each section, in one place.
 *
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** It is also the single source of truth
 * for the tab bar and the report heading: five section modules each naming
 * themselves is how a tab comes to disagree with the screen it opens.
 */
export const SECTION_TITLE: Record<SectionId, SafeValue> = {
  websocket: safeConstant('WebSocket'),
  environment: safeConstant('Environment & setup'),
  backend: safeConstant('Database & internal comms'),
  account: safeConstant('Account, space & requirements'),
  browser: safeConstant('Browser'),
}

/**
 * What one section hands the renderer, the Overview router and the report.
 *
 * `worst`, `worstVerdict`, `headline` and `reportLines` are DERIVED by
 * `buildSectionModel` and cannot be supplied: a section that understated its own
 * worst tone would defeat the router, and hand-written report lines are how a
 * value reaches a public paste.
 */
export type SectionModel = {
  readonly id: SectionId
  readonly title: SafeValue
  /** Worst tone across blocks; drives the Overview router and the sub-tab chip. */
  readonly worst: Tone
  readonly worstVerdict: Verdict
  /** The single worst finding, for the Overview router's one-line-per-section row. */
  readonly headline: DiagnosticFinding | undefined
  readonly blocks: readonly DiagnosticBlock[]
  /**
   * How many ROWS carry each verdict, across every block. Findings are not
   * counted here: a finding restates rows already in this census, and counting
   * both would make one fault read as two.
   */
  readonly counts: Record<Verdict, number>
  /** Markdown for the copyable report. Every line is a `SafeValue`. */
  readonly reportLines: readonly SafeValue[]
  readonly __sectionModel: 'built-by-buildSectionModel'
}

export type SectionModelInput = {
  id: SectionId
  blocks: readonly DiagnosticBlock[]
  /**
   * Lines the rows do not already carry. Mint them with `reportLine` — there is
   * no other way to produce one.
   */
  extraReportLines?: readonly SafeValue[]
}

const LABEL_WORST = safeConstant('Status')
const LABEL_FINDING = safeConstant('Finding')
const LABEL_ROWS = safeConstant('Rows')
const NOTHING_REPORTED = safeConstant('- Nothing was reported for this block.')

/**
 * The row census as a value.
 *
 * Minted rather than built from a constructor because it is two permitted
 * categories spliced together — bounded counts and literals of this build, and
 * nothing else can reach it: `describeCensus` reads only `READING_TAG` and the
 * integers `readingCensus` counted. It exists so a reader of the pasted report
 * can tell "this section reported 22 facts" from "this section reported 3 facts
 * and 19 silences" without counting the lines themselves.
 */
const censusValue = (rows: readonly DiagnosticRow[]): SafeValue =>
  mint(`${rows.length} (${describeCensus(readingCensus(rows))})`)

/**
 * A verdict as its report tag. Minted because `STATUS_TAG` is an exhaustive
 * `Record` of literals of this build keyed by a closed union — there is no
 * value of `Verdict` for which this can yield anything a server chose.
 */
const statusValue = (verdict: Verdict): SafeValue => mint(STATUS_TAG[verdict])

export function buildSectionModel(input: SectionModelInput): SectionModel {
  const { id, blocks } = input
  const title = SECTION_TITLE[id]

  const verdicts: Verdict[] = []
  for (const block of blocks) {
    for (const row of block.rows) {
      verdicts.push(row.verdict)
    }
    for (const finding of block.findings) {
      verdicts.push(finding.verdict)
    }
  }

  const worstVerdict = worstVerdictOf(verdicts)

  let headline: DiagnosticFinding | undefined
  for (const block of blocks) {
    for (const finding of block.findings) {
      if (headline === undefined || VERDICT_SEVERITY[finding.verdict] > VERDICT_SEVERITY[headline.verdict]) {
        headline = finding
      }
    }
  }

  const everyRow = blocks.flatMap((block) => [...block.rows])

  const reportLines: SafeValue[] = [
    mint(`## ${title}`),
    mint(''),
    reportLine(LABEL_WORST, statusValue(worstVerdict)),
    reportLine(LABEL_ROWS, censusValue(everyRow)),
    mint(''),
  ]

  for (const block of blocks) {
    reportLines.push(mint(`### ${block.heading}`), mint(''))
    if (isBlockEmpty(block)) {
      reportLines.push(NOTHING_REPORTED)
    }
    for (const row of block.rows) {
      reportLines.push(reportRow(row))
    }
    for (const finding of block.findings) {
      reportLines.push(reportLine(LABEL_FINDING, safeTokens(statusValue(finding.verdict), finding.code)))
    }
    reportLines.push(mint(''))
  }

  reportLines.push(...(input.extraReportLines ?? []))

  return {
    id,
    title,
    worst: TONE_FOR_VERDICT[worstVerdict],
    worstVerdict,
    headline,
    blocks,
    counts: verdictCensus(everyRow.map((row) => row.verdict)),
    reportLines,
  } as unknown as SectionModel
}

/* -------------------------------------------------------------------------- */
/* The lane-degradation ledger, as the WebSocket section reads it             */
/* -------------------------------------------------------------------------- */

/**
 * The HTTP statuses the socket's control-plane lane degrades on, as a fixed,
 * closed-key tuple.
 *
 * 498 and 401 are two different situations and collapsing them would waste the
 * fact: the socket's API_RPC credential is captured once when the ticket is
 * minted and never refreshed, so a session rotated since the socket connected is
 * answered 498 during the refresh cooldown and 401 afterwards. The second is a
 * stranded lane; the first recovers by itself.
 */
export const LANE_REJECTION_STATUSES = [401, 498] as const

export type LaneRejectionStatus = (typeof LANE_REJECTION_STATUSES)[number]

/**
 * One transport transition.
 *
 * `msSinceLedgerStart` is a DURATION, not a wall-clock instant — the plan sketched
 * an `at` timestamp and this is a deliberate narrowing. The ledger's point is
 * ordering and flap frequency, both of which a relative offset gives, and a
 * duration is a category the public report already permits while an absolute
 * instant would let a reader correlate this deployment against other logs.
 */
export type LaneTransitionRecord = {
  readonly state: SyncTransportState
  readonly reason?: SyncFallbackReason
  /**
   * Whether the socket itself survived a fall onto HTTP, or was torn down.
   * Present only on a transition that LANDED on HTTP: a dial has no socket yet and
   * READY has one by definition, so the question has no answer for either.
   */
  readonly socketPreserved?: boolean
  readonly msSinceLedgerStart: number
}

/**
 * What the client-side ledger exposes. Declared here, produced elsewhere, so the
 * section that reads it and the transport that fills it cannot disagree about the
 * shape — and so the section can be built and tested before the producer exists.
 *
 * Every field is a count, a closed code or a duration. There is nothing in this
 * shape that could carry a URL or a credential, which matters because the whole
 * reason the ledger exists is to make a CREDENTIAL failure observable.
 */
export type LaneDegradationLedgerView = {
  /**
   * Control-plane reads the socket lane refused and that were then served over
   * HTTP with no record anywhere. The one number that distinguishes a stranded
   * socket from a healthy one, because note syncing stays healthy throughout.
   */
  readonly controlPlaneRejections: number
  readonly controlPlaneRejectionsByStatus: Readonly<Partial<Record<LaneRejectionStatus, number>>>
  readonly fallbackCounts: Readonly<Partial<Record<SyncFallbackReason, number>>>
  /** Oldest first, bounded by the producer. */
  readonly transitions: readonly LaneTransitionRecord[]
  /** How many transitions fell off the end of the bounded ring. */
  readonly transitionsDropped: number
  /**
   * Single lanes that stood down while the transport stayed on the socket, by
   * cause. Not transitions — the transport did not move. Absent from a producer
   * older than the counter, which is not the same as none having happened.
   */
  readonly laneStandDownCounts?: Readonly<Partial<Record<SyncFallbackReason, number>>>
}
