// Local, unsynced quick-action shortcuts. These live in localStorage rather than a
// synced PrefKey because adding a PrefKey would require touching @standardnotes/models
// (off-limits for this web-only change). They are device-local UI shortcuts: a small,
// user-configurable row of fast actions shown above the notes list.

import { VectorIconNameOrEmoji } from '@standardnotes/snjs'

const STORAGE_KEY = 'standardnotes.quickActions.v1'

/**
 * The kinds of fast actions a shortcut can perform.
 * - `open-note`: open one specific note (by uuid).
 * - `recent-in`: open the most recently modified note inside a tag/folder (by uuid).
 * - `new-note-in`: create a brand new note assigned to a tag/folder, then open it.
 * - `go-to`: navigate to a tag / folder / smart view (by uuid).
 */
export type QuickActionType = 'open-note' | 'recent-in' | 'new-note-in' | 'go-to'

export interface QuickAction {
  /** Stable id for React keys + reorder/remove. */
  id: string
  type: QuickActionType
  /** uuid of the target note (open-note) or tag/folder/smart-view (the rest). */
  targetUuid: string
  /** Optional user label override. When empty we derive a label from the target. */
  label?: string
  /** Optional icon override. When empty we derive an icon from the action type/target. */
  icon?: VectorIconNameOrEmoji
}

export const QUICK_ACTION_TYPES: QuickActionType[] = ['new-note-in', 'recent-in', 'open-note', 'go-to']

/**
 * Default shipped shortcuts. We intentionally ship NONE: we cannot fabricate a
 * "diary" tag or assume any note exists, and an empty bar collapses to a single
 * unobtrusive "add a quick action" affordance. The user builds their own.
 */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = []

const VALID_TYPES = new Set<QuickActionType>(QUICK_ACTION_TYPES)

function isQuickAction(value: unknown): value is QuickAction {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.type === 'string' &&
    VALID_TYPES.has(candidate.type as QuickActionType) &&
    typeof candidate.targetUuid === 'string' &&
    candidate.targetUuid.length > 0 &&
    (candidate.label === undefined || typeof candidate.label === 'string') &&
    (candidate.icon === undefined || typeof candidate.icon === 'string')
  )
}

export function loadQuickActions(): QuickAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return [...DEFAULT_QUICK_ACTIONS]
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_QUICK_ACTIONS]
    }
    return parsed.filter(isQuickAction)
  } catch {
    return [...DEFAULT_QUICK_ACTIONS]
  }
}

export function saveQuickActions(actions: QuickAction[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(actions.filter(isQuickAction)))
  } catch {
    /* storage may be unavailable (private mode); shortcuts simply won't persist */
  }
}

/** Create a reasonably-unique id without pulling in a uuid dependency. */
export function createQuickActionId(): string {
  return `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
