import { AssistantContextScope } from './assistantContext'

export const ASSISTANT_DATA_EXPOSURE_NOTICE_KEY = 'assistant-data-exposure-notice-dismissed'
export const ASSISTANT_CONTEXT_SCOPE_KEY = 'assistant-context-scope'

const scopedKey = (base: string, accountScope: string) => `${base}:${encodeURIComponent(accountScope)}`

export type AssistantNoticeDismissal = 'once' | '15-days' | 'never'
const REMINDER_DELAY_MS = 15 * 24 * 60 * 60 * 1_000

const readReminderAt = (stored: string | null): number | undefined => {
  if (!stored || stored === 'true') {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(stored)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const { mode, remindAt } = value as Record<string, unknown>
    return mode === '15-days' &&
      typeof remindAt === 'number' &&
      Number.isSafeInteger(remindAt) &&
      remindAt > 0 &&
      remindAt <= 8_640_000_000_000_000
      ? remindAt
      : undefined
  } catch {
    return undefined
  }
}

/** The UI may schedule a refresh when this device-local reminder expires. */
export const readAssistantNoticeReminderAt = (accountScope: string): number | undefined => {
  try {
    return readReminderAt(localStorage.getItem(scopedKey(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY, accountScope)))
  } catch {
    return undefined
  }
}

export const readAssistantNoticeDismissed = (accountScope: string): boolean => {
  try {
    const stored = localStorage.getItem(scopedKey(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY, accountScope))
    return stored === 'true' || (readReminderAt(stored) ?? 0) > Date.now()
  } catch {
    return false
  }
}

export const persistAssistantNoticeDismissed = (
  accountScope: string,
  mode: AssistantNoticeDismissal = 'never',
): void => {
  try {
    const key = scopedKey(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY, accountScope)
    if (mode === 'once') {
      localStorage.removeItem(key)
    } else if (mode === '15-days') {
      localStorage.setItem(key, JSON.stringify({ mode, remindAt: Date.now() + REMINDER_DELAY_MS }))
    } else if (mode === 'never') {
      // Preserve acknowledgement from older builds and the original helper API.
      localStorage.setItem(key, 'true')
    }
  } catch {
    // Best-effort device-local acknowledgement.
  }
}

const isContextScope = (value: string | null): value is AssistantContextScope =>
  value === 'current-note' ||
  value === 'open-notes' ||
  value === 'all-notes' ||
  value === 'topic' ||
  value === 'collection'

export const readAssistantContextScope = (accountScope: string): AssistantContextScope => {
  try {
    const stored = localStorage.getItem(scopedKey(ASSISTANT_CONTEXT_SCOPE_KEY, accountScope))
    return isContextScope(stored) ? stored : 'current-note'
  } catch {
    return 'current-note'
  }
}

export const persistAssistantContextScope = (accountScope: string, scope: AssistantContextScope): void => {
  try {
    localStorage.setItem(scopedKey(ASSISTANT_CONTEXT_SCOPE_KEY, accountScope), scope)
  } catch {
    // Best-effort device-local selection.
  }
}
