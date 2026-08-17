/**
 * Device-local, account-scoped assistant transcript storage.
 *
 * Transcript text lives in the application's Default key-value domain. For a
 * signed-in application that domain is root-key wrapped before it reaches disk;
 * raw localStorage is used only for a content-free deletion tombstone so a
 * stale docked/pop-out writer cannot resurrect a deleted conversation.
 */

import { assistantWorkspaceRetention } from './assistantWorkspaceRetention'

export type PersistedAssistantToolAuthorizationDecision = 'allow' | 'deny'
export type PersistedAssistantToolAuthorizationSource = 'policy' | 'safety-review' | 'user-once' | 'user-chat'
export type PersistedAssistantToolActivityOutcome = 'succeeded' | 'failed' | 'denied' | 'interrupted'

export type PersistedAssistantToolAuthorization = {
  decision: PersistedAssistantToolAuthorizationDecision
  source: PersistedAssistantToolAuthorizationSource
}

/** Display/audit data only. Tool arguments, results, and secret material must never be added here. */
export type PersistedAssistantToolActivity = {
  id: string
  name: string
  label: string
  authorization?: PersistedAssistantToolAuthorization
  outcome: PersistedAssistantToolActivityOutcome
}

export type PersistedAssistantMessage = {
  kind: 'user' | 'assistant' | 'error'
  id: string
  text: string
  steered?: boolean
  activities?: PersistedAssistantToolActivity[]
}

export interface AssistantChatHistoryStorage {
  getValue<T>(key: string): T
  setValue(key: string, value: unknown): void
  setValueAndAwaitPersist?(key: string, value: unknown): Promise<void>
  removeValue(key: string): Promise<void>
}

export const ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX = 'AssistantChatHistory:v1'
export const ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX = 'assistant-chat-history:v1'
export const ASSISTANT_CHAT_HISTORY_DELETION_KEY_PREFIX = 'assistant-chat-history-deleted:v1'
export const ASSISTANT_CHAT_HISTORY_CHECKPOINT_DELAY_MS = 1_500

export type AssistantChatHistoryCheckpoint = {
  /** Mark the transcript dirty and schedule one bounded streaming checkpoint. */
  schedule: () => void
  /** Persist the latest transcript immediately, cancelling a pending checkpoint. */
  flush: () => Promise<void>
}

/**
 * Coalesce rapid streaming updates without weakening explicit durability points.
 * Writes are serialized so a slow encrypted-store update cannot be overlapped by
 * the next checkpoint.
 */
export function createAssistantChatHistoryCheckpoint(
  write: () => Promise<void>,
  delayMs = ASSISTANT_CHAT_HISTORY_CHECKPOINT_DELAY_MS,
): AssistantChatHistoryCheckpoint {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  let writeChain = Promise.resolve()

  const clearScheduled = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
  }

  const enqueueDirtyWrite = (): Promise<void> => {
    if (!dirty) {
      return writeChain
    }
    dirty = false
    const next = writeChain.then(write)
    // Keep later checkpoints usable after a best-effort persistence failure,
    // while still returning the real rejection to an explicit flush caller.
    writeChain = next.catch(() => undefined)
    return next
  }

  return {
    schedule: () => {
      dirty = true
      if (timeout !== undefined) {
        return
      }
      timeout = setTimeout(
        () => {
          timeout = undefined
          void enqueueDirtyWrite().catch(() => undefined)
        },
        Math.max(1, delayMs),
      )
    },
    flush: () => {
      dirty = true
      clearScheduled()
      return enqueueDirtyWrite()
    },
  }
}

const CURRENT_VERSION = 2
const LEGACY_VERSION = 1
const MAX_MESSAGES = 80
const MAX_MESSAGE_CHARS = 8_000
const MAX_TOTAL_CHARS = 80_000
const MAX_ACTIVITIES_PER_MESSAGE = 8
const MAX_ACTIVITIES_PER_TRANSCRIPT = 64
const MAX_AUDIT_BYTES = 16 * 1_024
const MAX_ACTIVITY_ID_CHARS = 128
const MAX_ACTIVITY_NAME_CHARS = 64
const MAX_ACTIVITY_LABEL_CHARS = 120
const MAX_DENIED_TOOL_NAMES = 64

type StoredHistoryV2 = {
  version: typeof CURRENT_VERSION
  messages: PersistedAssistantMessage[]
  deniedToolNames?: string[]
  deleted?: false
}
type DeletedHistoryV2 = { version: typeof CURRENT_VERSION; messages: []; deleted: true }

const encodedIdentity = (accountScope: string, tabId: string) =>
  `${encodeURIComponent(accountScope)}:${encodeURIComponent(tabId)}`

export const assistantChatHistoryStorageKey = (accountScope: string, tabId: string) =>
  `${ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX}:${encodedIdentity(accountScope, tabId)}`

export const assistantChatHistoryLegacyStorageKey = (accountScope: string, tabId: string) =>
  `${ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX}:${encodedIdentity(accountScope, tabId)}`

export const assistantChatHistoryDeletionKey = (accountScope: string, tabId: string) =>
  `${ASSISTANT_CHAT_HISTORY_DELETION_KEY_PREFIX}:${encodedIdentity(accountScope, tabId)}`

const isAuthorizationDecision = (value: unknown): value is PersistedAssistantToolAuthorizationDecision =>
  value === 'allow' || value === 'deny'

const isAuthorizationSource = (value: unknown): value is PersistedAssistantToolAuthorizationSource =>
  value === 'policy' || value === 'safety-review' || value === 'user-once' || value === 'user-chat'

const isTerminalOutcome = (value: unknown): value is PersistedAssistantToolActivityOutcome =>
  value === 'succeeded' || value === 'failed' || value === 'denied' || value === 'interrupted'

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })

const approximateUtf8Bytes = (value: string) =>
  Array.from(value).reduce((bytes, character) => {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x7f) {
      return bytes + 1
    }
    if (codePoint <= 0x7ff) {
      return bytes + 2
    }
    return bytes + (codePoint <= 0xffff ? 3 : 4)
  }, 0)

const sanitizeActivity = (value: unknown): PersistedAssistantToolActivity | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const activity = value as Record<string, unknown>
  if (
    typeof activity.id !== 'string' ||
    activity.id.length === 0 ||
    activity.id.length > MAX_ACTIVITY_ID_CHARS ||
    hasControlCharacters(activity.id) ||
    typeof activity.name !== 'string' ||
    activity.name.length > MAX_ACTIVITY_NAME_CHARS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(activity.name) ||
    typeof activity.label !== 'string' ||
    activity.label.trim().length === 0 ||
    activity.label.length > MAX_ACTIVITY_LABEL_CHARS ||
    hasControlCharacters(activity.label)
  ) {
    return undefined
  }

  let authorization: PersistedAssistantToolAuthorization | undefined
  if (typeof activity.authorization === 'object' && activity.authorization !== null) {
    const candidate = activity.authorization as Record<string, unknown>
    if (isAuthorizationDecision(candidate.decision) && isAuthorizationSource(candidate.source)) {
      authorization = { decision: candidate.decision, source: candidate.source }
    }
  }

  let outcome: PersistedAssistantToolActivityOutcome
  if (typeof activity.outcome === 'undefined' || activity.outcome === 'pending') {
    outcome = 'interrupted'
  } else if (isTerminalOutcome(activity.outcome)) {
    outcome = activity.outcome
  } else {
    return undefined
  }

  return {
    id: activity.id,
    name: activity.name,
    label: activity.label,
    ...(authorization ? { authorization } : {}),
    outcome,
  }
}

const sanitizeMessage = (value: unknown, includeActivities: boolean): PersistedAssistantMessage | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const message = value as Record<string, unknown>
  if (
    (message.kind !== 'user' && message.kind !== 'assistant' && message.kind !== 'error') ||
    typeof message.id !== 'string' ||
    typeof message.text !== 'string' ||
    (typeof message.steered !== 'undefined' && typeof message.steered !== 'boolean')
  ) {
    return undefined
  }

  const activities =
    includeActivities && Array.isArray(message.activities)
      ? message.activities
          .map(sanitizeActivity)
          .filter((activity) => activity !== undefined)
          .slice(-MAX_ACTIVITIES_PER_MESSAGE)
      : []

  return {
    kind: message.kind,
    id: message.id,
    text: message.text.slice(0, MAX_MESSAGE_CHARS),
    ...(typeof message.steered === 'boolean' ? { steered: message.steered } : {}),
    ...(activities.length > 0 ? { activities } : {}),
  }
}

const cap = (messages: unknown[], includeActivities: boolean): PersistedAssistantMessage[] => {
  const bounded = messages
    .map((message) => sanitizeMessage(message, includeActivities))
    .filter((message) => message !== undefined)
    .slice(-MAX_MESSAGES)

  let totalText = bounded.reduce((sum, message) => sum + message.text.length, 0)
  while (bounded.length > 0 && totalText > MAX_TOTAL_CHARS) {
    totalText -= bounded.shift()!.text.length
  }

  let activityCount = 0
  let auditBytes = 0
  for (let messageIndex = bounded.length - 1; messageIndex >= 0; messageIndex--) {
    const activities = bounded[messageIndex].activities
    if (!activities) {
      continue
    }

    const retained: PersistedAssistantToolActivity[] = []
    for (let activityIndex = activities.length - 1; activityIndex >= 0; activityIndex--) {
      const activity = activities[activityIndex]
      const activityBytes = approximateUtf8Bytes(JSON.stringify(activity))
      if (activityCount >= MAX_ACTIVITIES_PER_TRANSCRIPT || auditBytes + activityBytes > MAX_AUDIT_BYTES) {
        continue
      }
      retained.unshift(activity)
      activityCount++
      auditBytes += activityBytes
    }
    if (retained.length > 0) {
      bounded[messageIndex].activities = retained
    } else {
      delete bounded[messageIndex].activities
    }
  }

  return bounded
}

const sanitizeDeniedToolNames = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_DENIED_TOOL_NAMES) {
    return undefined
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > MAX_ACTIVITY_NAME_CHARS ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(candidate) ||
      seen.has(candidate)
    ) {
      return undefined
    }
    seen.add(candidate)
    names.push(candidate)
  }
  return names
}

type ParsedHistory = {
  messages: PersistedAssistantMessage[]
  deniedToolNames: string[]
}

const parseStoredHistory = (value: unknown): ParsedHistory | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.deleted === true || !Array.isArray(record.messages)) {
    return undefined
  }
  if (record.version === LEGACY_VERSION) {
    return { messages: cap(record.messages, false), deniedToolNames: [] }
  }
  if (record.version === CURRENT_VERSION) {
    const deniedToolNames = sanitizeDeniedToolNames(record.deniedToolNames)
    if (!deniedToolNames) {
      return undefined
    }
    return { messages: cap(record.messages, true), deniedToolNames }
  }
  return undefined
}

export type AssistantChatHistoryReadResult =
  | { status: 'found'; messages: PersistedAssistantMessage[]; deniedToolNames: string[] }
  | { status: 'missing' }
  | { status: 'error' }

const hasDeletionTombstone = (accountScope: string, tabId: string): boolean => {
  try {
    return localStorage.getItem(assistantChatHistoryDeletionKey(accountScope, tabId)) === '1'
  } catch {
    // If localStorage is unavailable, the encrypted-storage deletion marker is
    // still authoritative; callers inspect it before returning content.
    return false
  }
}

export function readAssistantChatHistoryResult(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
): AssistantChatHistoryReadResult {
  if (assistantWorkspaceRetention.isRetired(accountScope) || hasDeletionTombstone(accountScope, tabId)) {
    return { status: 'missing' }
  }

  let stored: unknown
  try {
    stored = storage.getValue<unknown>(assistantChatHistoryStorageKey(accountScope, tabId))
  } catch {
    return { status: 'error' }
  }
  if (typeof stored === 'object' && stored !== null && (stored as Record<string, unknown>).deleted === true) {
    return { status: 'missing' }
  }
  const parsedStored = parseStoredHistory(stored)
  if (parsedStored) {
    return { status: 'found', ...parsedStored }
  }
  if (stored !== undefined && stored !== null) {
    return { status: 'error' }
  }

  // Migrate the short-lived plaintext implementation without silently losing
  // a user's chats. The legacy value is removed as soon as it validates.
  try {
    const legacyKey = assistantChatHistoryLegacyStorageKey(accountScope, tabId)
    const raw = localStorage.getItem(legacyKey)
    if (!raw) {
      return { status: 'missing' }
    }
    const parsed = parseStoredHistory(JSON.parse(raw) as unknown)
    if (!parsed) {
      return { status: 'error' }
    }
    storage.setValue(assistantChatHistoryStorageKey(accountScope, tabId), {
      version: CURRENT_VERSION,
      messages: parsed.messages,
    } satisfies StoredHistoryV2)
    localStorage.removeItem(legacyKey)
    return { status: 'found', ...parsed }
  } catch {
    return { status: 'error' }
  }
}

export function readAssistantChatHistory(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
): PersistedAssistantMessage[] {
  const result = readAssistantChatHistoryResult(storage, accountScope, tabId)
  return result.status === 'found' ? result.messages : []
}

export async function persistAssistantChatHistory(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
  messages: PersistedAssistantMessage[],
  deniedToolNames: string[] = [],
): Promise<void> {
  try {
    if (storage.setValueAndAwaitPersist) {
      await persistAssistantChatHistoryStrict(storage, accountScope, tabId, messages, deniedToolNames)
    } else if (!assistantWorkspaceRetention.isRetired(accountScope) && !hasDeletionTombstone(accountScope, tabId)) {
      const sanitizedDeniedToolNames = sanitizeDeniedToolNames(deniedToolNames)
      if (!sanitizedDeniedToolNames) {
        return
      }
      storage.setValue(assistantChatHistoryStorageKey(accountScope, tabId), {
        version: CURRENT_VERSION,
        messages: cap(messages, true),
        ...(sanitizedDeniedToolNames.length > 0 ? { deniedToolNames: sanitizedDeniedToolNames } : {}),
      } satisfies StoredHistoryV2)
    }
  } catch {
    // History is a convenience; unavailable/quota-limited storage must not
    // affect callers that intentionally request best-effort persistence.
  }
}

export async function persistAssistantChatHistoryStrict(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
  messages: PersistedAssistantMessage[],
  deniedToolNames: string[] = [],
): Promise<void> {
  if (assistantWorkspaceRetention.isRetired(accountScope) || hasDeletionTombstone(accountScope, tabId)) {
    return
  }
  if (!storage.setValueAndAwaitPersist) {
    throw new Error('Assistant history storage does not support durable persistence.')
  }
  const sanitizedDeniedToolNames = sanitizeDeniedToolNames(deniedToolNames)
  if (!sanitizedDeniedToolNames) {
    throw new Error('Assistant history contains invalid denied tool policy data.')
  }
  const key = assistantChatHistoryStorageKey(accountScope, tabId)
  const value = {
    version: CURRENT_VERSION,
    messages: cap(messages, true),
    ...(sanitizedDeniedToolNames.length > 0 ? { deniedToolNames: sanitizedDeniedToolNames } : {}),
  } satisfies StoredHistoryV2
  await storage.setValueAndAwaitPersist(key, value)
  // A deletion may have won while this writer was awaiting durable
  // persistence. Remove the stale bytes as well as leaving the tombstone in
  // place, so the transcript is neither readable nor retained.
  if (assistantWorkspaceRetention.isRetired(accountScope) || hasDeletionTombstone(accountScope, tabId)) {
    await storage.removeValue(key)
  }
}

export async function deleteAssistantChatHistory(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
): Promise<boolean> {
  const key = assistantChatHistoryStorageKey(accountScope, tabId)

  // This must happen before any asynchronous persistence. It is deliberately
  // content-free and durable so an already in-flight writer remains unreadable.
  try {
    localStorage.setItem(assistantChatHistoryDeletionKey(accountScope, tabId), '1')
    localStorage.removeItem(assistantChatHistoryLegacyStorageKey(accountScope, tabId))
  } catch {
    // Best-effort; the application-storage deletion marker remains authoritative.
  }

  try {
    // Overwrite decrypted in-memory content before the asynchronous removal.
    const deleted = { version: CURRENT_VERSION, messages: [], deleted: true } satisfies DeletedHistoryV2
    if (storage.setValueAndAwaitPersist) {
      await storage.setValueAndAwaitPersist(key, deleted)
    } else {
      storage.setValue(key, deleted)
    }
  } catch {
    // The synchronous cross-window tombstone above still prevents resurrection.
  }
  try {
    await storage.removeValue(key)
    return true
  } catch {
    // The overwritten deletion marker intentionally remains when disk removal
    // fails, so no transcript content can reappear. The caller still retains
    // this ID in the cleanup manifest until physical removal succeeds.
    return false
  }
}

/** Remove the content-free cross-window fence after the owning claim retires all writers. */
export function clearAssistantChatHistoryDeletionTombstone(accountScope: string, tabId: string): void {
  try {
    localStorage.removeItem(assistantChatHistoryDeletionKey(accountScope, tabId))
  } catch {
    // Physical encrypted removal already succeeded. A content-free fence may
    // remain until a later cleanup, but deleting a chat must never reject its UI.
  }
}

/** Strictly remove one retired workspace transcript while its lifetime lock is held. */
export async function deleteAssistantChatHistoryStrict(
  storage: AssistantChatHistoryStorage,
  accountScope: string,
  tabId: string,
): Promise<void> {
  await storage.removeValue(assistantChatHistoryStorageKey(accountScope, tabId))
  localStorage.removeItem(assistantChatHistoryLegacyStorageKey(accountScope, tabId))
  localStorage.removeItem(assistantChatHistoryDeletionKey(accountScope, tabId))
}
