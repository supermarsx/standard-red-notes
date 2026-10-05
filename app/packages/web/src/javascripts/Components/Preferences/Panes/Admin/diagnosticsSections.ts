import type { SyncFallbackReason, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'
import type { Remedy } from './diagnosticRemedies'
import { admitToken, NOT_REPORTED, WITHHELD, type DeclaredPattern } from './reportAllowlist'
import type { CapabilityTestOutcome, Tone } from './syncDiagnostics'

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
 */
export const VERDICTS = ['healthy', 'degraded', 'broken', 'undetermined', 'informational'] as const

export type Verdict = (typeof VERDICTS)[number]

/**
 * How much an operator should care, lowest first. Used to pick a section's worst
 * verdict for the Overview router and the sub-tab chip.
 *
 * `undetermined` sits ABOVE `healthy` and below `degraded` on purpose: a section
 * that could not establish its facts is worth opening, and is not worth opening
 * ahead of one that is actually degraded.
 */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  informational: 0,
  healthy: 1,
  undetermined: 2,
  degraded: 3,
  broken: 4,
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE — the fall-through WAS the bug. ***
 *
 * The chip label for each verdict. Two verdicts share the neutral TONE and must
 * not share a label: "Unknown" is the panel admitting it cannot tell, "Info" is a
 * row that was never a verdict. The ternary chain this replaces
 * (`tone === 'good' ? 'OK' : tone === 'bad' ? 'Down' : 'Note'`) could express
 * neither.
 */
export const VERDICT_CHIP_LABEL: Record<Verdict, string> = {
  healthy: 'OK',
  degraded: 'Degraded',
  broken: 'Down',
  undetermined: 'Unknown',
  informational: 'Info',
}

/** *** EXHAUSTIVE `Record` ON PURPOSE. *** The tone a verdict paints with. */
export const TONE_FOR_VERDICT: Record<Verdict, Tone> = {
  healthy: 'good',
  degraded: 'warn',
  broken: 'bad',
  undetermined: 'neutral',
  informational: 'neutral',
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
}

/** What a verdict rests on. */
export type Evidence = { readonly kind: 'direct' } | ProxyEvidence | { readonly kind: 'absent' }

export const EVIDENCE_DIRECT: Evidence = { kind: 'direct' }

export const EVIDENCE_ABSENT: Evidence = { kind: 'absent' }

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
 */
export function evidenceProxy(input: {
  observed: string
  cannotConfirm: string
  necessaryCondition: boolean
}): Evidence {
  return {
    kind: 'proxy',
    observed: input.observed,
    cannotConfirm: input.cannotConfirm,
    relation: input.necessaryCondition ? 'necessary' : 'correlated',
  }
}

/** Verdicts that assert the described thing is working, wholly or in part. */
const ASSERTS_FUNCTION: Record<Verdict, boolean> = {
  healthy: true,
  degraded: true,
  broken: false,
  undetermined: false,
  informational: false,
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
 * Cap a claim at what its evidence establishes. The whole point of the task in
 * four lines.
 */
function capVerdict(claimed: Verdict, evidence: Evidence): Verdict {
  if (evidence.kind === 'direct') {
    return claimed
  }
  if (evidence.kind === 'absent') {
    return 'undetermined'
  }
  if (ASSERTS_FUNCTION[claimed]) {
    return 'undetermined'
  }
  if (claimed === 'broken' && !BROKEN_SURVIVES[evidence.relation]) {
    return 'undetermined'
  }
  return claimed
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

/**
 * A probe outcome tagged with the section it belongs to.
 *
 * Declared here as an intersection rather than by adding the field to
 * `CapabilityTestOutcome` itself: that type lives in `syncDiagnostics.ts`, which
 * another change owns. The tag lets a probe result appear read-only inside its
 * section while the consent paragraph and the button that mints a real
 * server-side ticket stay in exactly one place.
 */
export type SectionTaggedOutcome = CapabilityTestOutcome & { readonly section?: SectionId }

export function outcomesForSection(
  outcomes: readonly SectionTaggedOutcome[],
  section: SectionId,
): readonly SectionTaggedOutcome[] {
  return outcomes.filter((outcome) => outcome.section === section)
}

/** A headed group of rows and findings inside a section. */
export type DiagnosticBlock = {
  readonly heading: SafeValue
  readonly description: string
  readonly rows: readonly DiagnosticRow[]
  readonly findings: readonly DiagnosticFinding[]
  /** Probe results belonging to this block, rendered read-only. */
  readonly outcomes?: readonly SectionTaggedOutcome[]
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
  return block.rows.length === 0 && block.findings.length === 0 && (block.outcomes ?? []).length === 0
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

const LABEL_WORST = safeConstant('Worst verdict')
const LABEL_FINDING = safeConstant('Finding')
const NOTHING_REPORTED = safeConstant('- Nothing was reported for this block.')

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

  const reportLines: SafeValue[] = [
    mint(`## ${title}`),
    mint(''),
    reportLine(LABEL_WORST, safeEnum(worstVerdict, VERDICTS)),
    mint(''),
  ]

  for (const block of blocks) {
    reportLines.push(mint(`### ${block.heading}`), mint(''))
    if (isBlockEmpty(block)) {
      reportLines.push(NOTHING_REPORTED)
    }
    for (const row of block.rows) {
      reportLines.push(reportLine(row.label, row.value))
    }
    for (const finding of block.findings) {
      reportLines.push(reportLine(LABEL_FINDING, safeTokens(finding.code, safeEnum(finding.verdict, VERDICTS))))
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
  /** Whether the socket itself survived the transition, or was torn down. */
  readonly socketPreserved: boolean
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
}
