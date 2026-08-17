import { AssistantContextScope } from './assistantContext'

export const ASSISTANT_DATA_EXPOSURE_NOTICE_KEY = 'assistant-data-exposure-notice-dismissed'
export const ASSISTANT_CONTEXT_SCOPE_KEY = 'assistant-context-scope'

const scopedKey = (base: string, accountScope: string) => `${base}:${encodeURIComponent(accountScope)}`

export const readAssistantNoticeDismissed = (accountScope: string): boolean => {
  try {
    return localStorage.getItem(scopedKey(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY, accountScope)) === 'true'
  } catch {
    return false
  }
}

export const persistAssistantNoticeDismissed = (accountScope: string): void => {
  try {
    localStorage.setItem(scopedKey(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY, accountScope), 'true')
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
