import { ListItemNode } from '@lexical/list'
import { $getRoot, $isElementNode, LexicalNode } from 'lexical'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from '../../TodoAggregate/superChecklistDocument'
import {
  $isChecklistItemNode,
  $getChecklistItemText,
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $getChecklistTodoId,
  $normalizeChecklistItemMetadata,
  $setChecklistSchedule,
  $setChecklistTodoId,
  normalizeChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'
import { normalizeChecklistDueAt } from './checklistDueDate'
import {
  advanceChecklistDueAt,
  checklistRecurrenceChoice,
  checklistRecurrencesEqual,
  createChecklistRecurrence,
  normalizeChecklistRecurrence,
} from './checklistRecurrence'

export type ChecklistEditorMutationResult = {
  matched: boolean
  changed: boolean
  todoId?: string
}

export type ChecklistScheduleSnapshot = {
  dueAt?: string
  recurrence?: ReturnType<typeof normalizeChecklistRecurrence>
}

export const CHECKLIST_COMPLETION_THROTTLE_MS = 750

/** Suppress one physical double-click/key-repeat from consuming two occurrences. */
export function canAttemptRecurringChecklistCompletion(
  previousAttemptAt: number | undefined,
  attemptedAt: number,
  throttleMs = CHECKLIST_COMPLETION_THROTTLE_MS,
  repeatedKeyboardEvent = false,
): boolean {
  return (
    !repeatedKeyboardEvent &&
    Number.isFinite(attemptedAt) &&
    (!Number.isFinite(previousAttemptAt) || attemptedAt - (previousAttemptAt as number) >= throttleMs)
  )
}

function $nodeLocator(node: LexicalNode): string {
  const path: number[] = []
  let current: LexicalNode | null = node
  while (current && current.getParent()) {
    path.push(current.getIndexWithinParent())
    current = current.getParent()
  }
  return path.reverse().join('.')
}

export function $getChecklistScheduleSnapshot(item: ListItemNode): ChecklistScheduleSnapshot {
  return {
    dueAt: $getChecklistDueAt(item),
    recurrence: $getChecklistRecurrence(item),
  }
}

/** Compare-and-set used by an open inline schedule draft against live Yjs state. */
export function $setChecklistItemScheduleIfCurrent(
  item: ListItemNode,
  expected: ChecklistScheduleSnapshot,
  dueAt: string | undefined,
  recurrence: unknown,
): ChecklistEditorMutationResult {
  const normalizedDueAt = dueAt === undefined ? undefined : normalizeChecklistDueAt(dueAt)
  const normalizedRecurrence = normalizeChecklistRecurrence(recurrence)
  if ((dueAt !== undefined && !normalizedDueAt) || (recurrence !== undefined && !normalizedRecurrence)) {
    return { matched: false, changed: false }
  }
  if (normalizedRecurrence && !normalizedDueAt) {
    return { matched: false, changed: false }
  }
  if (
    normalizeChecklistDueAt(expected.dueAt) !== $getChecklistDueAt(item) ||
    !checklistRecurrencesEqual(normalizeChecklistRecurrence(expected.recurrence), $getChecklistRecurrence(item))
  ) {
    return { matched: false, changed: false }
  }

  const changed =
    $getChecklistDueAt(item) !== normalizedDueAt ||
    !checklistRecurrencesEqual($getChecklistRecurrence(item), normalizedRecurrence) ||
    Boolean(normalizedRecurrence && item.getChecked())
  if (changed) {
    $setChecklistSchedule(item, normalizedDueAt, normalizedRecurrence)
  }
  return { matched: true, changed, todoId: $getChecklistTodoId(item) }
}

export function $getChecklistItems(): ListItemNode[] {
  const items: ListItemNode[] = []
  const stack = [...$getRoot().getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
    if ($isChecklistItemNode(node)) {
      items.push(node)
    }
  }
  return items
}

export type ChecklistCompletionOutcome = {
  /** The row's checkbox state or schedule actually changed. */
  changed: boolean
  /**
   * The row was recurring and rolled to its next occurrence instead of being
   * completed. Only an advance carries a subtree with it, so only an advance
   * may stand in for completing the rows beneath it.
   */
  advanced: boolean
}

/**
 * Apply a checkbox state without cloning recurring rows. Completing a recurring
 * item advances the same row to its next due occurrence and leaves it open;
 * reopening an ordinary/terminal item never rewinds its schedule.
 *
 * A caller completing several rows at once needs to tell the two outcomes
 * apart, so the result reports which one happened rather than leaving it to be
 * inferred from the node afterwards.
 */
export function $applyChecklistItemChecked(
  item: ListItemNode,
  checked: boolean,
  now = Date.now(),
): ChecklistCompletionOutcome {
  const wasChecked = Boolean(item.getChecked())
  if (!checked) {
    if (wasChecked) {
      item.setChecked(false)
      return { changed: true, advanced: false }
    }
    return { changed: false, advanced: false }
  }

  const dueAt = $getChecklistDueAt(item)
  const recurrence = $getChecklistRecurrence(item)
  if (dueAt && recurrence) {
    const nextDueAt = advanceChecklistDueAt(dueAt, recurrence, now)
    if (nextDueAt) {
      $setChecklistSchedule(item, nextDueAt, recurrence)
      if (wasChecked) {
        item.setChecked(false)
      }
      return { changed: true, advanced: true }
    }
    // A schedule at the supported calendar ceiling has no next occurrence.
    // Complete it normally and remove the exhausted recurrence contract.
    $setChecklistSchedule(item, dueAt, undefined)
  }

  if (!wasChecked) {
    item.setChecked(true)
    return { changed: true, advanced: false }
  }
  return { changed: recurrence !== undefined && dueAt !== undefined, advanced: false }
}

export function $setChecklistItemChecked(item: ListItemNode, checked: boolean, now = Date.now()): boolean {
  return $applyChecklistItemChecked(item, checked, now).changed
}

export function $toggleChecklistItemChecked(item: ListItemNode, now = Date.now()): boolean {
  return $setChecklistItemChecked(item, !item.getChecked(), now)
}

/** Apply a mutation inside the active Lexical/Yjs owner, failing closed on ambiguity. */
export function $applyChecklistEditorMutation(
  target: SuperChecklistTodoTarget,
  patch: SuperChecklistTodoPatch,
  now = Date.now(),
): ChecklistEditorMutationResult {
  const ensuredTodoId = patch.ensureTodoId === undefined ? undefined : normalizeChecklistTodoId(patch.ensureTodoId)
  if (patch.ensureTodoId !== undefined && !ensuredTodoId) {
    return { matched: false, changed: false }
  }
  const normalizedDueAt = typeof patch.dueAt === 'string' ? normalizeChecklistDueAt(patch.dueAt) : undefined
  if (typeof patch.dueAt === 'string' && !normalizedDueAt) {
    return { matched: false, changed: false }
  }
  const normalizedRecurrence =
    patch.recurrence && typeof patch.recurrence === 'object'
      ? normalizeChecklistRecurrence(patch.recurrence)
      : undefined
  if (patch.recurrence !== undefined && patch.recurrence !== null && !normalizedRecurrence) {
    return { matched: false, changed: false }
  }

  const items = $getChecklistItems()
  const matches = target.todoId
    ? items.filter((item) => $getChecklistTodoId(item) === target.todoId)
    : items.filter(
        (item) =>
          $nodeLocator(item) === target.locator &&
          $getChecklistItemText(item) === target.text &&
          Boolean(item.getChecked()) === target.checked &&
          $getChecklistDueAt(item) === normalizeChecklistDueAt(target.dueAt) &&
          checklistRecurrencesEqual($getChecklistRecurrence(item), normalizeChecklistRecurrence(target.recurrence)),
      )
  if (matches.length !== 1) {
    return { matched: false, changed: false }
  }

  const item = matches[0]
  const liveDueAt = $getChecklistDueAt(item)
  const liveRecurrence = $getChecklistRecurrence(item)
  const effectiveDueAt = patch.dueAt === undefined ? liveDueAt : patch.dueAt === null ? undefined : normalizedDueAt
  let implicitlyReanchoredRecurrence: typeof liveRecurrence
  if (
    patch.dueAt !== undefined &&
    patch.dueAt !== null &&
    normalizedDueAt &&
    patch.recurrence === undefined &&
    liveRecurrence &&
    normalizedDueAt !== liveDueAt
  ) {
    const choice = checklistRecurrenceChoice(liveRecurrence)
    implicitlyReanchoredRecurrence = choice
      ? createChecklistRecurrence(choice, normalizedDueAt, liveRecurrence.anchor.timeZone)
      : undefined
    if (!implicitlyReanchoredRecurrence) {
      return { matched: false, changed: false }
    }
  }
  const effectiveRecurrence =
    patch.dueAt === null && patch.recurrence === undefined
      ? undefined
      : patch.recurrence === undefined
        ? (implicitlyReanchoredRecurrence ?? liveRecurrence)
        : patch.recurrence === null
          ? undefined
          : normalizedRecurrence
  if (effectiveRecurrence && !effectiveDueAt) {
    return { matched: false, changed: false }
  }
  const scheduleChangedSinceTarget =
    normalizeChecklistDueAt(target.dueAt) !== liveDueAt ||
    !checklistRecurrencesEqual(normalizeChecklistRecurrence(target.recurrence), liveRecurrence)
  if (
    scheduleChangedSinceTarget &&
    (patch.dueAt !== undefined || patch.recurrence !== undefined || (patch.checked === true && effectiveRecurrence))
  ) {
    // The due instant and rule identify one recurring occurrence. A stale
    // completion must not advance a fresh occurrence, and a schedule editor
    // must not overwrite a newer local/remote schedule.
    return { matched: false, changed: false }
  }
  const liveTodoId = $getChecklistTodoId(item)
  if (liveTodoId && items.some((candidate) => candidate !== item && $getChecklistTodoId(candidate) === liveTodoId)) {
    // A normalized identity must itself be unique before a stale legacy row can
    // adopt it. Duplicate third-party IDs are never resolved by document order.
    return { matched: false, changed: false }
  }
  if (target.todoId && ensuredTodoId && liveTodoId !== ensuredTodoId) {
    // An ensure operation may fill a genuinely missing legacy identity, but it
    // must never replace a durable identity selected by an ID-bearing target.
    return { matched: false, changed: false }
  }
  const shouldAssignEnsuredId = !liveTodoId && Boolean(ensuredTodoId)
  if (
    shouldAssignEnsuredId &&
    items.some((candidate) => candidate !== item && $getChecklistTodoId(candidate) === ensuredTodoId)
  ) {
    return { matched: false, changed: false }
  }

  let changed = false
  if (shouldAssignEnsuredId && ensuredTodoId) {
    $setChecklistTodoId(item, ensuredTodoId)
    changed = true
  }
  changed = $normalizeChecklistItemMetadata() > 0 || changed

  if (
    (patch.dueAt !== undefined || patch.recurrence !== undefined || implicitlyReanchoredRecurrence) &&
    (liveDueAt !== effectiveDueAt ||
      !checklistRecurrencesEqual(liveRecurrence, effectiveRecurrence) ||
      Boolean(effectiveRecurrence && item.getChecked()))
  ) {
    $setChecklistSchedule(item, effectiveDueAt, effectiveRecurrence)
    changed = true
  }

  if (patch.checked !== undefined) {
    changed = $setChecklistItemChecked(item, patch.checked, now) || changed
  }

  return { matched: true, changed, todoId: $getChecklistTodoId(item) }
}
