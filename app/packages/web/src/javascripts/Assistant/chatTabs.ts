/**
 * Chat-tab modeling and persistence for the Assistant view.
 *
 * Tab titles can be derived from private prompt text, so metadata lives in the
 * application's encrypted device-local key-value domain alongside transcripts.
 */

import { assistantWorkspaceRetention } from './assistantWorkspaceRetention'

export type ChatTab = {
  id: string
  title: string
  /**
   * True once the user has manually renamed the tab. Auto-naming (from the first
   * user message) must never overwrite a user-chosen title.
   */
  userRenamed: boolean
}

export interface AssistantChatTabsStorage {
  getValue<T>(key: string): T
  setValue(key: string, value: unknown): void
  setValueAndAwaitPersist?(key: string, value: unknown): Promise<void>
  removeValue?(key: string): Promise<void>
}

export const DEFAULT_TAB_TITLE = 'New chat'
export const ASSISTANT_CHAT_TABS_STORAGE_KEY_PREFIX = 'AssistantChatTabs:v1'
export const ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX = 'assistant-chat-tabs:v1'
export const ASSISTANT_CHAT_TABS_LEGACY_UNSCOPED_KEY = 'assistant-chat-tabs'
export const ASSISTANT_BROWSING_CONTEXT_ID_KEY = 'assistant-browsing-context-id:v1'

function newBrowsingContextId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/**
 * Return one content-free, device-local workspace ID that survives a full app
 * or browser restart. The retention lifetime lock remains the writer-authority
 * boundary: if another live document already owns this workspace, the newcomer
 * is deliberately transient instead of sharing or racing encrypted transcripts.
 */
export function getAssistantBrowsingContextId(storage?: Pick<Storage, 'getItem' | 'setItem'>): string {
  try {
    const target = storage ?? globalThis.localStorage
    const existing = target.getItem(ASSISTANT_BROWSING_CONTEXT_ID_KEY)
    const validExisting = existing && /^[A-Za-z0-9-]{8,128}$/.test(existing)
    if (validExisting) {
      return existing
    }
    const created = newBrowsingContextId()
    target.setItem(ASSISTANT_BROWSING_CONTEXT_ID_KEY, created)
    return created
  } catch {
    // Storage-disabled documents cannot safely promise cross-restart history;
    // retention also makes them transient because its coordination store fails.
    return newBrowsingContextId()
  }
}

/**
 * Docked and popped-out assistants are independent live workspaces. Keeping
 * their storage scopes distinct prevents two mounted views from racing over the
 * same transcript while still letting the dock continue in the background.
 */
export function assistantChatWorkspaceScope(
  accountScope: string,
  standalone: boolean,
  browsingContextId?: string,
): string {
  const context = browsingContextId?.replace(/[^A-Za-z0-9-]/g, '').slice(0, 128)
  return `${accountScope}:${standalone ? 'window' : 'dock'}${context ? `:${context}` : ''}`
}

export const assistantChatTabsStorageKey = (accountScope: string) =>
  `${ASSISTANT_CHAT_TABS_STORAGE_KEY_PREFIX}:${encodeURIComponent(accountScope)}`
export const assistantChatTabsLegacyStorageKey = (accountScope: string) =>
  `${ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX}:${encodeURIComponent(accountScope)}`

const MAX_TITLE_WORDS = 6
const MAX_TITLE_LENGTH = 40
const MAX_TAB_ID_LENGTH = 128
export const MAX_CHAT_TABS = 20
const VERSION = 1

type StoredChatTabs = { version: typeof VERSION; tabs: ChatTab[] }
export type PersistedTabsReadResult = { status: 'found'; tabs: ChatTab[] } | { status: 'missing' } | { status: 'error' }

export function normalizeChatTabTitle(rawTitle: string): string {
  const title = rawTitle.trim().slice(0, MAX_TITLE_LENGTH)
  return title || DEFAULT_TAB_TITLE
}

/**
 * Derive a short, human-readable tab title from the first user message.
 *
 * Local heuristic (no API call): take the first ~6 meaningful words of the first
 * line, strip surrounding punctuation, capitalize the first letter, and append an
 * ellipsis when the message was longer than what we kept. Always works offline and
 * is deterministic, so it is the default auto-naming strategy. Returns the default
 * title for empty/whitespace-only input.
 */
export function deriveTitleFromMessage(text: string): string {
  const firstLine = (text ?? '').split('\n').find((line) => line.trim().length > 0) ?? ''
  const trimmed = firstLine.trim()
  if (!trimmed) {
    return DEFAULT_TAB_TITLE
  }

  const words = trimmed.split(/\s+/)
  const kept = words.slice(0, MAX_TITLE_WORDS)
  let title = kept.join(' ')

  // Strip leading/trailing punctuation that reads poorly as a label.
  title = title.replace(/^[\s"'`*#>\-–—:.,;!?(){}[\]]+/, '').replace(/[\s"'`*:.,;!?(){}[\]]+$/, '')

  if (!title) {
    return DEFAULT_TAB_TITLE
  }

  // Capitalize the first letter for a tidier label.
  title = title.charAt(0).toUpperCase() + title.slice(1)

  const truncatedByLength = title.length > MAX_TITLE_LENGTH
  title = normalizeChatTabTitle(title)

  const truncated = words.length > kept.length || truncatedByLength
  return truncated ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title
}

const isChatTab = (value: unknown): value is ChatTab => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tab = value as Record<string, unknown>
  return (
    typeof tab.id === 'string' &&
    tab.id.length > 0 &&
    tab.id.length <= MAX_TAB_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(tab.id) &&
    typeof tab.title === 'string' &&
    tab.title.length <= MAX_TITLE_LENGTH &&
    typeof tab.userRenamed === 'boolean'
  )
}

const capTabs = (tabs: ChatTab[]): ChatTab[] => {
  const seen = new Set<string>()
  const bounded: ChatTab[] = []
  for (const tab of tabs) {
    if (seen.has(tab.id) || bounded.length >= MAX_CHAT_TABS) {
      continue
    }
    seen.add(tab.id)
    bounded.push({ ...tab, title: normalizeChatTabTitle(tab.title) })
  }
  return bounded
}

const parseTabs = (value: unknown): ChatTab[] | null => {
  const candidate =
    typeof value === 'object' && value !== null && (value as Record<string, unknown>).version === VERSION
      ? (value as Record<string, unknown>).tabs
      : value
  if (!Array.isArray(candidate)) {
    return null
  }
  if (candidate.some((tab) => !isChatTab(tab))) {
    return null
  }
  const tabs = capTabs(candidate)
  return tabs.length > 0 ? tabs : null
}

/** Read encrypted metadata without conflating absence with corruption or storage failure. */
export function readPersistedTabsResult(
  storage: AssistantChatTabsStorage,
  accountScope: string,
): PersistedTabsReadResult {
  if (assistantWorkspaceRetention.isRetired(accountScope)) {
    return { status: 'error' }
  }
  let stored: StoredChatTabs | undefined
  try {
    stored = storage.getValue<StoredChatTabs | undefined>(assistantChatTabsStorageKey(accountScope))
  } catch {
    return { status: 'error' }
  }
  const parsedStored = parseTabs(stored)
  if (parsedStored) {
    return { status: 'found', tabs: parsedStored }
  }
  if (stored !== undefined && stored !== null) {
    return { status: 'error' }
  }

  try {
    const legacyKey = assistantChatTabsLegacyStorageKey(accountScope)
    const raw = localStorage.getItem(legacyKey)
    if (raw) {
      const migrated = parseTabs(JSON.parse(raw) as unknown)
      if (migrated) {
        storage.setValue(assistantChatTabsStorageKey(accountScope), {
          version: VERSION,
          tabs: migrated,
        } satisfies StoredChatTabs)
        localStorage.removeItem(legacyKey)
        // The original unscoped format cannot be attributed safely to an
        // account. Remove it instead of risking cross-account title disclosure.
        localStorage.removeItem(ASSISTANT_CHAT_TABS_LEGACY_UNSCOPED_KEY)
        return { status: 'found', tabs: migrated }
      }
      return { status: 'error' }
    }
    localStorage.removeItem(ASSISTANT_CHAT_TABS_LEGACY_UNSCOPED_KEY)
    return { status: 'missing' }
  } catch {
    return { status: 'error' }
  }
}

/** Compatibility wrapper for callers that intentionally do not distinguish errors. */
export function readPersistedTabs(storage: AssistantChatTabsStorage, accountScope: string): ChatTab[] | null {
  const result = readPersistedTabsResult(storage, accountScope)
  return result.status === 'found' ? result.tabs : null
}

/** Persist encrypted tab metadata. Best-effort; active chats do not depend on it. */
export async function persistTabs(
  storage: AssistantChatTabsStorage,
  accountScope: string,
  tabs: ChatTab[],
): Promise<void> {
  try {
    if (storage.setValueAndAwaitPersist) {
      await persistTabsStrict(storage, accountScope, tabs)
    } else {
      storage.setValue(assistantChatTabsStorageKey(accountScope), {
        version: VERSION,
        tabs: capTabs(tabs),
      } satisfies StoredChatTabs)
    }
  } catch {
    // Application storage can be unavailable during early launch.
  }
}

/** Persist tab metadata durably and surface failures to retention callers. */
export async function persistTabsStrict(
  storage: AssistantChatTabsStorage,
  accountScope: string,
  tabs: ChatTab[],
): Promise<void> {
  if (assistantWorkspaceRetention.isRetired(accountScope)) {
    throw new Error('Assistant workspace was retired before tab persistence.')
  }
  const key = assistantChatTabsStorageKey(accountScope)
  const value = { version: VERSION, tabs: capTabs(tabs) } satisfies StoredChatTabs
  if (!storage.setValueAndAwaitPersist) {
    throw new Error('Assistant tab storage does not support durable persistence.')
  }
  await storage.setValueAndAwaitPersist(key, value)
  if (assistantWorkspaceRetention.isRetired(accountScope)) {
    if (!storage.removeValue) {
      throw new Error('Assistant tab storage does not support stale-write cleanup.')
    }
    await storage.removeValue(key)
    throw new Error('Assistant workspace was retired during tab persistence.')
  }
}

/** Remove the exact encrypted workspace metadata. Cleanup callers handle errors. */
export async function deletePersistedTabsStrict(
  storage: AssistantChatTabsStorage,
  accountScope: string,
): Promise<void> {
  if (!storage.removeValue) {
    throw new Error('Assistant tab storage does not support durable deletion.')
  }
  await storage.removeValue(assistantChatTabsStorageKey(accountScope))
  localStorage.removeItem(assistantChatTabsLegacyStorageKey(accountScope))
}
