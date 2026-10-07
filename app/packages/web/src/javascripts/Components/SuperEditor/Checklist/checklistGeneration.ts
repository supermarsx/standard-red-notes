/**
 * Standard Red Notes: write down the occurrences a recurring checklist task
 * actually owed.
 *
 * ## The defect this closes
 * `advanceChecklistDueAt` answers only "where does this task go next", against a
 * threshold of `max(dueAt, completedAt)`. Ticking a monthly task three months
 * late therefore produced ONE next occurrence and the three that were owed
 * vanished with no record, and a task nobody ever ticked sat overdue forever and
 * produced nothing at all. This module materializes the window as real rows, so
 * three months overdue becomes three tasks — literally what the user means by it.
 *
 * ## What a generated row is, and is not
 * A generated occurrence is a PLAIN DATED SIBLING: it carries a deadline and a
 * fresh identity, and deliberately **no recurrence rule**. One rule per logical
 * task is what keeps anything from compounding — a generated row that inherited
 * the rule would itself become overdue-and-recurring, would generate its own
 * occurrences on the next pass, and would also start competing with its parent
 * through `$propagateChecklistRecurrenceToDescendants`, whose idempotence
 * argument depends on exactly one rule being in play.
 *
 * Subtasks are **not** reproduced for a generated occurrence. Only the live row's
 * roll carries a subtree, the same way completing it by hand does
 * (`$propagateChecklistRecurrenceToDescendants`), because that is the one
 * occurrence the recurring task is actually on.
 *
 * ## Why a second pass generates nothing
 * A plan is only ever produced when a future occurrence exists, and this pass
 * always moves the live row onto it. Afterwards the live row's deadline is in the
 * future, so `checklistBackfillDecision` stops at `'not-due'` before the grid is
 * walked; the rows just written have no rule, so they stop at `'no-schedule'`;
 * and the summary row has neither, so it stops there too. That is what makes the
 * cap safe as a PER-PASS bound rather than a backlog that re-offers itself: what
 * the cap left out is RECORDED by the summary row, not left pending.
 */
import { $createListItemNode, $isListNode, ListItemNode } from '@lexical/list'
import { $createTextNode } from 'lexical'
import type { PrefKey } from '@standardnotes/snjs'
import {
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY,
  CHECKLIST_GENERATE_CAP_PREF_KEY,
  checklistBackfillDecision,
  checklistOccurrenceSummaryText,
  resolveChecklistBackfillSettings,
  type ChecklistBackfillSettings,
} from './checklistBackfill'
import {
  $getChecklistDescendantItems,
  $getChecklistDueAt,
  $getChecklistItemText,
  $getChecklistOccurrenceSummary,
  $getChecklistRecurrence,
  $getChecklistRowSubtreeEnd,
  $ensureChecklistTodoId,
  $findChecklistOccurrenceSummaryItem,
  $isChecklistItemNode,
  $isChecklistOccurrenceSummaryItem,
  $setChecklistOccurrenceSummary,
  $setChecklistSchedule,
  $setChecklistTodoId,
  CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
  createChecklistTodoId,
  $propagateChecklistRecurrenceToDescendants,
} from '../Lexical/Nodes/ChecklistItemNode'
import { $getChecklistItems } from './ChecklistEditorMutations'

/** What one generation pass did, in terms a caller can report to the user. */
export type ChecklistGenerationResult = {
  /** Recurring, dated, open tasks the pass considered. */
  examined: number
  /** Of those, how many owed something and were acted on. */
  tasks: number
  /** Occurrence rows materialized as plain dated siblings. */
  generated: number
  /** Summary records written or updated in place. */
  summaries: number
  /** Live rows moved onto their first future occurrence. */
  advanced: number
}

export const EMPTY_CHECKLIST_GENERATION_RESULT: ChecklistGenerationResult = {
  examined: 0,
  tasks: 0,
  generated: 0,
  summaries: 0,
  advanced: 0,
}

/** True when a pass changed the document, so a caller knows to persist. */
export function checklistGenerationChangedDocument(result: ChecklistGenerationResult): boolean {
  return result.generated > 0 || result.summaries > 0 || result.advanced > 0
}

function addResults(first: ChecklistGenerationResult, second: ChecklistGenerationResult): ChecklistGenerationResult {
  return {
    examined: first.examined + second.examined,
    tasks: first.tasks + second.tasks,
    generated: first.generated + second.generated,
    summaries: first.summaries + second.summaries,
    advanced: first.advanced + second.advanced,
  }
}

/**
 * The two synced preference keys, read as the string literals they actually are.
 *
 * `todoFilters.ts:76-87` has the full reasoning: web consumes `PrefKey`'s RUNTIME
 * value from the generated `snjs`/`models` bundle, and these two members are only
 * present there once that shared artifact is rebuilt — until then reading the
 * enum member yields `undefined`, the preference silently falls to its default
 * forever, and the setting looks like it does nothing. The literals come from
 * `checklistBackfill.ts` so there is one spelling of each in the tree; the cast
 * goes through `unknown` because web type-checks `@standardnotes/snjs` against a
 * `models/dist` artifact that predates both members, so the direct
 * `as PrefKey.ChecklistGenerateCap` form does not compile yet.
 *
 * Nothing here ever edits a `dist/` file to work around that: those are
 * deliberately non-committable build output, and a local edit to one would make
 * this build disagree with every other.
 */
export const CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF =
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY as unknown as PrefKey
export const CHECKLIST_GENERATE_CAP_PREF = CHECKLIST_GENERATE_CAP_PREF_KEY as unknown as PrefKey

/** Just enough of the application to read two preferences, so this stays testable. */
export type ChecklistBackfillPreferenceSource = {
  getPreference: (key: PrefKey) => unknown
}

/**
 * Resolve the two preferences into bounded settings.
 *
 * Both reads are defended because both are SYNCED: the value that arrives may
 * have been written by another device running different code, and the preference
 * store itself may not be ready on an early mount. The hardcoded defaults
 * (generate on, cap 12) are the ones that apply, exactly as
 * `checklistBackfill.ts` defines them — a throwing or absent store must not turn
 * a feature off silently.
 *
 * `forceGenerate` is for an explicit "Generate now": a user instruction is not an
 * automatic pass, so it runs even with the automatic toggle off. It deliberately
 * does NOT override the cap, which is a bound on work rather than a switch.
 */
export function readChecklistBackfillSettings(
  source: ChecklistBackfillPreferenceSource | undefined,
  forceGenerate = false,
): ChecklistBackfillSettings {
  let raw: { autoGenerate?: unknown; cap?: unknown } = {}
  try {
    raw = {
      autoGenerate: source?.getPreference(CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF),
      cap: source?.getPreference(CHECKLIST_GENERATE_CAP_PREF),
    }
  } catch {
    raw = {}
  }
  const settings = resolveChecklistBackfillSettings(raw)
  return forceGenerate ? { ...settings, autoGenerate: true } : settings
}

/** Replace a row's own text, leaving any nested sub-checklist beneath it alone. */
function $setChecklistItemText(item: ListItemNode, text: string): void {
  for (const child of item.getChildren()) {
    if (!$isListNode(child)) {
      child.remove()
    }
  }
  item.append($createTextNode(text))
}

/** A new sibling row, inserted directly after `after`, carrying `text`. */
function $insertChecklistRowAfter(after: ListItemNode, text: string): ListItemNode {
  const row = $createListItemNode(false)
  row.append($createTextNode(text))
  // `restoreSelection: false` — a pass that runs when a note is opened must not
  // move the caret the user has not placed yet.
  after.insertAfter(row, false)
  $setChecklistTodoId(row, createChecklistTodoId())
  return row
}

/**
 * Generate the occurrences `item` owes, in occurrence order, immediately after
 * `item` and everything indented under it.
 *
 * Returns a zero result for anything that owes nothing — not a recurring dated
 * task, already completed, not yet due, a schedule that cannot be resolved, or
 * the automatic toggle being off. Each of those is a named skip inside
 * `checklistBackfillDecision`; none of them is an error.
 *
 * `advancedDescendantKeys` is how a document-wide pass stays one occurrence for a
 * subtree. Rolling a recurring row forward already reschedules every task beneath
 * it, so a subtask the pass has just moved must not then be treated as its own
 * overdue candidate and generate a second window inside the subtree. Today those
 * subtasks all land strictly after `now`, so they would be skipped as `'not-due'`
 * anyway — but that is a property of another module's arithmetic, and a rule this
 * important should not depend on it. The set is READ to skip and WRITTEN to record,
 * exactly like the `advanced` set in `$setCheckedForItems`.
 */
export function $generateMissedChecklistOccurrencesForItem(
  item: ListItemNode,
  settings: ChecklistBackfillSettings,
  now = Date.now(),
  locale?: string,
  advancedDescendantKeys?: Set<string>,
): ChecklistGenerationResult {
  if (advancedDescendantKeys?.has(item.getKey())) {
    return EMPTY_CHECKLIST_GENERATION_RESULT
  }
  if ($isChecklistOccurrenceSummaryItem(item) || !$isChecklistItemNode(item)) {
    return EMPTY_CHECKLIST_GENERATION_RESULT
  }
  const dueAt = $getChecklistDueAt(item)
  const recurrence = $getChecklistRecurrence(item)
  if (!dueAt || !recurrence) {
    return EMPTY_CHECKLIST_GENERATION_RESULT
  }
  const examined = item.getChecked() ? 0 : 1
  const decision = checklistBackfillDecision({ dueAt, recurrence, checked: Boolean(item.getChecked()) }, settings, now)
  if (!decision.generate) {
    return { ...EMPTY_CHECKLIST_GENERATION_RESULT, examined }
  }

  const todoId = $ensureChecklistTodoId(item)
  const label = $getChecklistItemText(item)
  // AFTER the live row's whole subtree, not after the row. Lexical holds an
  // indented sub-checklist in a wrapper listitem that is the row's next
  // SIBLING, so a plain row inserted directly after `item` lands between the
  // row and its wrapper — and a row in that position owns the wrapper. The
  // user's subtasks would silently re-parent onto a generated occurrence, and
  // `item` would be left with no descendants at all (which is also why
  // "generated occurrences get no subtree of their own" has to be enforced
  // here rather than assumed). The generated occurrences therefore sit below
  // the subtree, still siblings of `item` at its own indent level.
  let anchorRow = $getChecklistRowSubtreeEnd(item)
  let generated = 0
  for (const occurrenceAt of decision.occurrences) {
    const row = $insertChecklistRowAfter(anchorRow, label)
    // No recurrence: one rule per logical task, so nothing compounds and the
    // descendant-propagation idempotence argument keeps exactly one rule to
    // reason about.
    $setChecklistSchedule(row, occurrenceAt, undefined)
    anchorRow = row
    generated += 1
  }

  let summaries = 0
  if (decision.summary) {
    // Found by its state key, so a pass updates the row it already wrote instead
    // of appending a second record every time.
    const existing = $findChecklistOccurrenceSummaryItem(todoId)
    const previous = existing ? $getChecklistOccurrenceSummary(existing) : undefined
    // A record is CUMULATIVE for its task. Each pass truncates a window that
    // starts strictly after the previous pass's new deadline, so the two sets are
    // always disjoint and the counts add. Overwriting with only this pass's
    // truncation would quietly forget everything an earlier pass recorded, and
    // could make the count go DOWN — which is also what makes "only reopen it if
    // the count grew" a meaningful rule. The bounds say which occurrences are the
    // oldest and newest NOT generated; they do not claim that everything between
    // them was skipped, and some of it was in fact written out as rows.
    const merged = previous
      ? {
          missedCount: Math.min(Number.MAX_SAFE_INTEGER, previous.missedCount + decision.summary.missedCount),
          oldestMissedAt:
            Date.parse(previous.oldestMissedAt) <= Date.parse(decision.summary.oldestMissedAt)
              ? previous.oldestMissedAt
              : decision.summary.oldestMissedAt,
          newestMissedAt:
            Date.parse(previous.newestMissedAt) >= Date.parse(decision.summary.newestMissedAt)
              ? previous.newestMissedAt
              : decision.summary.newestMissedAt,
        }
      : decision.summary
    // Stated in the rule's own zone, which is the zone the occurrences were
    // computed in, so the two bounds name the same days the task would have used.
    const text = checklistOccurrenceSummaryText(merged, locale, recurrence.anchor.timeZone)
    if (text) {
      const record = { version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION, ...merged, sourceTodoId: todoId }
      if (existing) {
        $setChecklistItemText(existing, text)
        if ($setChecklistOccurrenceSummary(existing, record)) {
          // Only reopen a record the user already dismissed when there is
          // genuinely more to see. Re-surfacing an unchanged record on every open
          // would train the user to ignore it.
          if (existing.getChecked() && (!previous || record.missedCount > previous.missedCount)) {
            existing.setChecked(false)
          }
          summaries += 1
        }
      } else {
        // After the generated rows: the record covers occurrences older than all
        // of them, and the rows the user can still act on come first.
        const row = $insertChecklistRowAfter(anchorRow, text)
        if ($setChecklistOccurrenceSummary(row, record)) {
          summaries += 1
        } else {
          row.remove()
        }
      }
    }
  }

  // The live row moves onto its first future occurrence, which is what makes the
  // pass idempotent, and carries its subtree with it exactly as completing it by
  // hand would. Generated occurrences get no subtree of their own.
  $setChecklistSchedule(item, decision.nextDueAt, recurrence)
  $propagateChecklistRecurrenceToDescendants(item, decision.nextDueAt, recurrence, now)
  if (advancedDescendantKeys) {
    for (const descendant of $getChecklistDescendantItems(item)) {
      advancedDescendantKeys.add(descendant.getKey())
    }
  }

  return { examined, tasks: 1, generated, summaries, advanced: 1 }
}

/**
 * Run one generation pass over the whole document.
 *
 * MUST be called inside an `editor.update()`, so the entire pass is one history
 * entry: a user who did not want it undoes it once, and a note is never left with
 * half a window written.
 *
 * The task list is snapshotted before anything is inserted, so the rows this
 * pass writes are never themselves examined by it. They would be skipped anyway
 * — no rule, no schedule — but relying on that would make the loop's termination
 * an accident of another module's behaviour.
 *
 * `$getChecklistItems` returns document order, so an ancestor is always processed
 * before the tasks beneath it. That is what lets one roll stand in for a whole
 * subtree: by the time a subtask is reached, the pass already knows its ancestor
 * carried it forward.
 */
export function $generateMissedChecklistOccurrences(
  settings: ChecklistBackfillSettings,
  now = Date.now(),
  locale?: string,
): ChecklistGenerationResult {
  let result = EMPTY_CHECKLIST_GENERATION_RESULT
  const advancedDescendantKeys = new Set<string>()
  for (const item of $getChecklistItems()) {
    result = addResults(
      result,
      $generateMissedChecklistOccurrencesForItem(item, settings, now, locale, advancedDescendantKeys),
    )
  }
  return result
}
