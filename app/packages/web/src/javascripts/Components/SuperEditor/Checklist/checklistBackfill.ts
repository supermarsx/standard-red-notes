import { normalizeChecklistDueAt } from './checklistDueDate'
import {
  CHECKLIST_GENERATE_CAP_DEFAULT,
  CHECKLIST_GENERATE_CAP_MAX,
  CHECKLIST_GENERATE_CAP_MIN,
  checklistMissedOccurrencePlan,
  normalizeChecklistRecurrence,
  type ChecklistRecurrence,
} from './checklistRecurrence'

/**
 * Standard Red Notes: whether a recurring checklist task's missed occurrences
 * get written down, and how many of them.
 *
 * Pure and application-free, like `todoFilters.ts`: the preference values arrive
 * as `unknown` and leave as bounded, usable settings, and the generate/skip
 * decision is a function of a task's own schedule. Nothing here throws, because
 * every input is either a SYNCED preference another (older or newer) client may
 * have written or a value read out of a note.
 *
 * The grid walk itself lives in `checklistRecurrence.ts`; this module owns only
 * the settings read, the decision, and the words the summary row carries.
 */

/**
 * The two synced `UserPrefs` keys, as the strings that are actually written.
 *
 * `todoFilters.ts:76-87` explains the pinning rule: web consumes `PrefKey`'s
 * RUNTIME value from the generated `snjs` bundle, so a brand-new enum member is
 * absent there until that shared artifact is rebuilt, and reading one yields
 * `undefined` — a preference that silently falls to its default forever and
 * looks like "the setting does nothing". A string enum member IS its own string
 * at runtime, so pinning the literal depends on nothing generated.
 *
 * The canonical form of that pin is `'x' as PrefKey.X`. It is deliberately NOT
 * written that way here yet: web type-checks `@standardnotes/snjs` against
 * `packages/models/dist/**.d.ts`, a build artifact that still predates both
 * members (they exist in `models/src/Domain/Syncable/UserPrefs/PrefKey.ts`), so
 * the cast does not currently compile. Once `@standardnotes/models` has been
 * rebuilt in a normal build cycle, add the two casts — the strings below are
 * already exactly the enum's values, so nothing else moves.
 */
export const CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY = 'checklistAutoGenerateRecurrences'
export const CHECKLIST_GENERATE_CAP_PREF_KEY = 'checklistGenerateCap'

/**
 * Generation is ON by default: the alternative is that a recurring task a user
 * fell behind on quietly loses every occurrence it owed, which is the defect
 * this feature exists to fix.
 */
export const DEFAULT_CHECKLIST_AUTO_GENERATE_RECURRENCES = true

export { CHECKLIST_GENERATE_CAP_DEFAULT, CHECKLIST_GENERATE_CAP_MAX, CHECKLIST_GENERATE_CAP_MIN }

/** The two preferences, resolved into values the generation pass can use. */
export type ChecklistBackfillSettings = {
  autoGenerate: boolean
  cap: number
}

/**
 * Coerce the auto-generate preference. Only an explicit `false` turns generation
 * off; a missing value, a value from a client that does not know this key, and a
 * corrupted value all read as the default rather than disabling a feature the
 * user never opted out of.
 */
export function normalizeChecklistAutoGenerateRecurrences(raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : DEFAULT_CHECKLIST_AUTO_GENERATE_RECURRENCES
}

/**
 * Coerce the generated-occurrence cap into
 * {@link CHECKLIST_GENERATE_CAP_MIN}..{@link CHECKLIST_GENERATE_CAP_MAX}.
 *
 * Clamped ON READ, not on write, for the same reason `normalizeTodoFilters`
 * is: this is a synced value, so the writer may be another device running a
 * different version of this code, and the value that arrives has never been
 * validated here. A fractional value is truncated rather than rounded — the
 * number is an upper bound on work, and a bound should not be raised by
 * reading it.
 */
export function normalizeChecklistGenerateCap(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return CHECKLIST_GENERATE_CAP_DEFAULT
  }
  return Math.min(CHECKLIST_GENERATE_CAP_MAX, Math.max(CHECKLIST_GENERATE_CAP_MIN, Math.trunc(raw)))
}

/** Resolve both preferences at once from whatever the preference store returns. */
export function resolveChecklistBackfillSettings(raw: {
  autoGenerate?: unknown
  cap?: unknown
}): ChecklistBackfillSettings {
  return {
    autoGenerate: normalizeChecklistAutoGenerateRecurrences(raw.autoGenerate),
    cap: normalizeChecklistGenerateCap(raw.cap),
  }
}

/**
 * The record carried by the summary row when the cap could not hold the whole
 * window. Maps one-to-one onto the node state payload defined by
 * `CHECKLIST_OCCURRENCE_SUMMARY_STATE_KEY`.
 */
export type ChecklistOccurrenceSummary = {
  /** How many occurrences were NOT generated. Always at least 1. */
  missedCount: number
  oldestMissedAt: string
  newestMissedAt: string
}

/** Why a task generates nothing. Each value is a distinct, nameable situation. */
export type ChecklistBackfillSkipReason =
  /** The auto-generate preference is off. */
  | 'disabled'
  /** Already completed; completion advances the schedule by its own route. */
  | 'completed'
  /** Not a recurring, dated task — a plain todo, or the summary row itself. */
  | 'no-schedule'
  /** Nothing is owed: the deadline is in the future. The idempotent case. */
  | 'not-due'
  /** A schedule that cannot be resolved, or one with no future occurrence left. */
  | 'unresolvable'

export type ChecklistBackfillDecision =
  | { generate: false; reason: ChecklistBackfillSkipReason }
  | {
      generate: true
      /** Occurrences to materialize as plain dated siblings, oldest first. */
      occurrences: string[]
      /** Where the live row must move; strictly after `now`. */
      nextDueAt: string
      /** Present only when the cap truncated the window. */
      summary?: ChecklistOccurrenceSummary
    }

/**
 * Decide what one generation pass owes a single checklist task.
 *
 * ## Why a second pass generates nothing
 * A `generate: true` decision always carries a `nextDueAt` strictly after `now`.
 * Once the caller has moved the live row there, this task's deadline is in the
 * future, so the next pass stops at `'not-due'` before the grid is even walked.
 * That is what makes the cap safe as a PER-PASS bound: the occurrences it left
 * out are recorded by the summary row rather than left pending, so they are not
 * re-offered on the following pass. A pass that generates and then fails to move
 * the live row would break this, which is why a plan is only ever produced when
 * a future occurrence exists.
 *
 * ## The toggle gates the automatic pass, not the user
 * `settings.autoGenerate` is read straight through to the `'disabled'` skip. An
 * explicit "Generate now" is a user instruction, not an automatic pass, so its
 * caller passes `autoGenerate: true` regardless of the stored preference.
 */
export function checklistBackfillDecision(
  task: { dueAt?: string; recurrence?: ChecklistRecurrence; checked?: boolean },
  settings: ChecklistBackfillSettings,
  now = Date.now(),
): ChecklistBackfillDecision {
  if (!settings.autoGenerate) {
    return { generate: false, reason: 'disabled' }
  }
  if (task.checked === true) {
    return { generate: false, reason: 'completed' }
  }
  if (task.dueAt === undefined || task.recurrence === undefined) {
    return { generate: false, reason: 'no-schedule' }
  }
  const dueAt = normalizeChecklistDueAt(task.dueAt)
  const rule = normalizeChecklistRecurrence(task.recurrence)
  const dueTimestamp = dueAt ? Date.parse(dueAt) : Number.NaN
  if (!dueAt || !rule || !Number.isFinite(dueTimestamp) || !Number.isFinite(now)) {
    return { generate: false, reason: 'unresolvable' }
  }
  if (dueTimestamp > now) {
    return { generate: false, reason: 'not-due' }
  }
  const plan = checklistMissedOccurrencePlan(dueAt, rule, now, normalizeChecklistGenerateCap(settings.cap))
  if (!plan) {
    return { generate: false, reason: 'unresolvable' }
  }
  if (plan.truncated === 0) {
    return { generate: true, occurrences: plan.generate, nextDueAt: plan.nextDueAt }
  }
  if (!plan.oldestTruncatedAt || !plan.newestTruncatedAt) {
    return { generate: false, reason: 'unresolvable' }
  }
  return {
    generate: true,
    occurrences: plan.generate,
    nextDueAt: plan.nextDueAt,
    summary: {
      missedCount: plan.truncated,
      oldestMissedAt: plan.oldestTruncatedAt,
      newestMissedAt: plan.newestTruncatedAt,
    },
  }
}

function summaryDateFormatter(locale: string | undefined, timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone })
}

/**
 * The words the summary row carries.
 *
 * It says "not generated", which is true and complete, rather than "missed" or
 * "lost", which would claim the occurrences were destroyed. It states only the
 * two bounds it actually knows and never a due date — the row has no schedule,
 * and must not read as one. The cap is deliberately absent: the number that can
 * be CHANGED belongs where it can be changed, not in a row recording a fact.
 *
 * Returns `undefined` rather than a half-sentence when the summary cannot be
 * resolved, so a caller can decide not to write a row at all.
 */
export function checklistOccurrenceSummaryText(
  summary: ChecklistOccurrenceSummary,
  locale?: string,
  timeZone?: string,
): string | undefined {
  const oldest = normalizeChecklistDueAt(summary.oldestMissedAt)
  const newest = normalizeChecklistDueAt(summary.newestMissedAt)
  if (!Number.isSafeInteger(summary.missedCount) || summary.missedCount < 1 || !oldest || !newest) {
    return undefined
  }
  try {
    const format = summaryDateFormatter(locale, timeZone)
    if (summary.missedCount === 1) {
      return `1 earlier occurrence was not generated — ${format.format(new Date(oldest))}.`
    }
    return `${summary.missedCount} earlier occurrences were not generated — oldest ${format.format(
      new Date(oldest),
    )}, newest ${format.format(new Date(newest))}.`
  } catch {
    // An unsupported locale or zone must not take down a generation pass.
    return undefined
  }
}
