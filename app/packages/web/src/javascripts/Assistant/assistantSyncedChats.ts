import { base64Url, sha256, utf8Bytes } from '@/DavSync/hash/sha256'
import {
  ASSISTANT_COMPOSER_FIELDS,
  normalizeAssistantChatComposerState,
  type AssistantChatComposerPatch,
  type AssistantChatComposerState,
} from './assistantChatComposerState'
/** Account-private chat records travel through the ordinary E2E encrypted item/socket sync pipeline. */
import { DecryptedItemInterface, DecryptedItemMutator, ItemContent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { PersistedAssistantMessage, sanitizeAssistantChatMessages } from './assistantChatHistory'
import type { AssistantWorkTabKind, ChatTab } from './chatTabs'
import { AssistantConversationMode, isAssistantConversationMode } from './conversationModes'

/** Closed diagnostics: never expose exception text, note contents or provider credentials. */
export const ASSISTANT_CHAT_STORAGE_MESSAGES = {
  QUOTA_EXCEEDED: 'Browser storage is full. Free some disk space, then retry saving this chat.',
  STORAGE_UNAVAILABLE: 'Synced chats are unavailable until this account is loaded and unlocked.',
  HISTORY_NOT_READY: 'Chat history is still loading. Wait for it to finish, then retry.',
  HISTORY_INVALID: 'Chat checkpoint did not pass encrypted storage validation.',
  SESSION_CHANGED: 'The account changed before this chat could be saved.',
  OWNERSHIP_LOST: 'This chat no longer owns its save checkpoint. Retry after chat ownership is re-established.',
  ATTACHMENT_LIMIT: 'The chat attachments exceed the supported encrypted storage limit.',
  WRITE_FAILED: 'The chat checkpoint could not be saved. Your current messages remain in this tab.',
  UNKNOWN_FAILURE: 'The chat checkpoint could not be completed. Your current messages remain in this tab.',
  SYNC_FAILED:
    'The encrypted chat checkpoint could not complete syncing. Your current messages remain in this tab. Check your connection and retry.',
  READ_ONLY: 'This session cannot save synced chats.',
  CHAT_TRASHED: 'This chat is in the trash. Restore it before continuing.',
  CHAT_DELETED: 'This chat was deleted on another device.',
  CHAT_LIMIT: 'The active chat limit has been reached. Move an older chat to Trash to free a slot.',
  WRITER_LIMIT: 'This chat has reached its writer limit. Start a new chat to continue.',
  RECORD_SIZE_LIMIT: 'This encrypted chat record is too large. Shorten the chat or start a new one.',
  STORAGE_RECORD_LIMIT: 'Encrypted chat storage has reached its record limit. Purge older chats to free space.',
  STORAGE_SIZE_LIMIT:
    'Encrypted chat storage has reached its size limit. Purge older chats or shorten this chat to free space.',
  STORAGE_BUDGET:
    'The encrypted chat storage budget is full. Open History to inspect storage usage and permanently delete unwanted chats or clean deleted records.',
  INVALID_CHAT: 'Invalid synced chat identity.',
  WRITER_UNAVAILABLE: 'This browser cannot coordinate encrypted chat writers safely.',
  CHECKPOINT_MISSING: 'The chat checkpoint disappeared before saving.',
} as const
export type AssistantChatStorageFailureCode = keyof typeof ASSISTANT_CHAT_STORAGE_MESSAGES
export const ASSISTANT_CHAT_STORAGE_FAILURE_CODES = Object.keys(
  ASSISTANT_CHAT_STORAGE_MESSAGES,
) as readonly AssistantChatStorageFailureCode[]
export const ASSISTANT_CHAT_STORAGE_FAILURE_STAGES = [
  'read',
  'validate',
  'write',
  'checkpoint',
  'writer',
  'access',
] as const
export type AssistantChatStorageFailureStage = (typeof ASSISTANT_CHAT_STORAGE_FAILURE_STAGES)[number]
export const ASSISTANT_CHAT_STORAGE_FAILURE_CAUSES = [
  'TypeError',
  'InvalidStateError',
  'AbortError',
  'SecurityError',
  'quota',
  'unknown',
] as const
export type AssistantChatStorageFailureCause = (typeof ASSISTANT_CHAT_STORAGE_FAILURE_CAUSES)[number]
export type AssistantChatStorageFailure = {
  cause?: AssistantChatStorageFailureCause
  code: AssistantChatStorageFailureCode
  stage: AssistantChatStorageFailureStage
  message: string
}
export class AssistantChatStorageError extends Error {
  constructor(
    readonly code: AssistantChatStorageFailureCode,
    readonly stage: AssistantChatStorageFailureStage,
    readonly cause?: AssistantChatStorageFailureCause,
  ) {
    super(ASSISTANT_CHAT_STORAGE_MESSAGES[code])
    this.name = 'AssistantChatStorageError'
  }
}
const storageCause = (error: unknown): AssistantChatStorageFailureCause => {
  const name =
    error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)
      ? error.name
      : undefined
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'quota'
  }
  return name === 'TypeError' || name === 'InvalidStateError' || name === 'AbortError' || name === 'SecurityError'
    ? name
    : 'unknown'
}
const isQuotaFailure = (error: unknown): boolean => storageCause(error) === 'quota'
export function getAssistantChatStorageFailure(error: unknown): AssistantChatStorageFailure {
  const known =
    error instanceof AssistantChatStorageError &&
    Object.hasOwn(ASSISTANT_CHAT_STORAGE_MESSAGES, error.code) &&
    ASSISTANT_CHAT_STORAGE_FAILURE_STAGES.includes(error.stage)
      ? error
      : new AssistantChatStorageError(
          isQuotaFailure(error) ? 'QUOTA_EXCEEDED' : 'UNKNOWN_FAILURE',
          'checkpoint',
          storageCause(error),
        )
  return {
    code: known.code,
    stage: known.stage,
    message: ASSISTANT_CHAT_STORAGE_MESSAGES[known.code],
    ...(known.cause && ASSISTANT_CHAT_STORAGE_FAILURE_CAUSES.includes(known.cause) ? { cause: known.cause } : {}),
  }
}
function storageFailure(error: unknown, stage: AssistantChatStorageFailureStage): AssistantChatStorageError {
  return error instanceof AssistantChatStorageError
    ? error
    : new AssistantChatStorageError(
        isQuotaFailure(error) ? 'QUOTA_EXCEEDED' : stage === 'checkpoint' ? 'SYNC_FAILED' : 'WRITE_FAILED',
        stage,
        storageCause(error),
      )
}

export const ASSISTANT_CHAT_CONTENT_TYPE = 'SN|AssistantChat'
export const ASSISTANT_CHAT_TRASH_RETENTION_DAYS = 30
const MAX_TRASH_PRUNE_ROOMS = 25
export const MAX_SYNCED_CHATS = 1000
export const MAX_CHAT_WRITERS = 64
export const MAX_SYNCED_CHAT_RECORDS = 8192
export const MAX_SYNCED_CHAT_BYTES = 256 * 1024 * 1024
/** Raw JSON fingerprints are optional acceleration, never a limit on readable history. */
export const MAX_SYNCED_CHAT_FINGERPRINT_BYTES = 16 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_ENTRIES = 80
/** Programmatic admission budget; values may be lowered without hiding existing history. */
export type AssistantChatStorageBudget = { chats: number; records: number; serializedUnits: number }
export const DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET: Readonly<AssistantChatStorageBudget> = Object.freeze({
  chats: MAX_SYNCED_CHATS,
  records: MAX_SYNCED_CHAT_RECORDS,
  serializedUnits: MAX_SYNCED_CHAT_BYTES,
})
function validateStorageBudget(overrides: Partial<AssistantChatStorageBudget>): Readonly<AssistantChatStorageBudget> {
  const budget = { ...DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET, ...overrides }
  for (const key of Object.keys(DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET) as Array<keyof AssistantChatStorageBudget>) {
    if (
      !Number.isSafeInteger(budget[key]) ||
      budget[key] <= 0 ||
      budget[key] > DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET[key]
    ) {
      throw new RangeError('Invalid assistant chat storage budget.')
    }
  }
  return Object.freeze(budget)
}

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export type SyncedChatEntry = {
  message: PersistedAssistantMessage
  parentId: string | null
  at: number
  revision: number
}
export type SyncedChatRecord = {
  version: 1
  ownerUuid: string
  chatId: string
  kind: 'writer' | 'deleted' | 'lifecycle'
  state?: 'active' | 'trashed'
  writerId: string
  revision: number
  updatedAt: number
  composer?: AssistantChatComposerState
  metadataUpdatedAt?: number
  title?: string
  userRenamed?: boolean
  tabKind?: AssistantWorkTabKind
  conversationMode?: AssistantConversationMode
  /** Mode intent is independent of manually chosen title precedence. */
  conversationModeUpdatedAt?: number
  entries?: SyncedChatEntry[]
  deniedToolNames?: string[]
  removedMessageIds?: string[]
}
export type SyncedChat = {
  composer?: AssistantChatComposerState
  trashed?: boolean
  tab: ChatTab
  messages: PersistedAssistantMessage[]
  deniedToolNames: string[]
}
const snapshotFingerprints = new WeakMap<SyncedChat, string>()
const snapshotFingerprint = (chat: SyncedChat): string => {
  let fingerprint = snapshotFingerprints.get(chat)
  if (fingerprint === undefined) {
    fingerprint = JSON.stringify(chat)
    snapshotFingerprints.set(chat, fingerprint)
  }
  return fingerprint
}

/** Parsed chat snapshots are immutable. Reuse unchanged readers after catalog refreshes. */
export function reconcileSyncedChatSnapshots(previous: SyncedChat[], next: readonly SyncedChat[]): SyncedChat[] {
  const byId = new Map(previous.map((chat) => [chat.tab.id, chat]))
  const reconciled = next.map((chat) => {
    const old = byId.get(chat.tab.id)
    return old && (old === chat || snapshotFingerprint(old) === snapshotFingerprint(chat)) ? old : chat
  })
  return reconciled.length === previous.length && reconciled.every((chat, index) => chat === previous[index])
    ? previous
    : reconciled
}
export type AssistantSharedChatBinding = {
  ready: boolean
  history?: SyncedChat
  refresh(): Promise<SyncedChat | undefined>
  checkpointComposer?(patch: AssistantChatComposerPatch): Promise<SyncedChat | void>
  removeMessage?(messageId: string): Promise<void>
  checkpoint(messages: PersistedAssistantMessage[], deniedToolNames: string[]): Promise<SyncedChat | void>
}
type Parsed = { uuid: string; record: SyncedChatRecord }

/** Keep an exact, bounded fingerprint; record clocks alone cannot prove content equality. */
function serializeSyncedChatContent(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  try {
    const serialized = JSON.stringify(value)
    return serialized.length <= MAX_RECORD_BYTES ? serialized : undefined
  } catch {
    return undefined
  }
}

/** Closed schema; no provider credentials, arbitrary tool arguments or results cross this boundary. */
export function normalizeSyncedChatRecord(value: unknown, ownerUuid: string): SyncedChatRecord | undefined {
  return serializeSyncedChatContent(value) === undefined ? undefined : normalizeSerializedChatContent(value, ownerUuid)
}

/** Called only after the raw content passed the bounded JSON serialization check. */
function normalizeSerializedChatContent(value: unknown, ownerUuid: string): SyncedChatRecord | undefined {
  const raw = value as Partial<SyncedChatRecord>
  if (
    raw.version !== 1 ||
    raw.ownerUuid !== ownerUuid ||
    !id(raw.chatId) ||
    !id(raw.writerId) ||
    !counter(raw.revision) ||
    !counter(raw.updatedAt) ||
    !['writer', 'deleted', 'lifecycle'].includes(raw.kind ?? '')
  ) {
    return undefined
  }
  const base = {
    version: 1 as const,
    ownerUuid,
    chatId: raw.chatId,
    writerId: raw.writerId,
    revision: raw.revision,
    updatedAt: raw.updatedAt,
  }
  if (raw.kind === 'lifecycle') {
    return raw.state === 'active' || raw.state === 'trashed'
      ? { ...base, kind: 'lifecycle', state: raw.state }
      : undefined
  }
  if (raw.kind === 'deleted') {
    return { ...base, kind: 'deleted' }
  }
  if (
    !Array.isArray(raw.entries) ||
    raw.entries.length > MAX_ENTRIES ||
    typeof raw.title !== 'string' ||
    raw.title.length > 40 ||
    !['chat', 'research', 'deep-research'].includes(raw.tabKind ?? 'chat') ||
    (raw.conversationMode !== undefined && !isAssistantConversationMode(raw.conversationMode)) ||
    (raw.conversationModeUpdatedAt !== undefined && !counter(raw.conversationModeUpdatedAt))
  ) {
    return undefined
  }
  const composer = raw.composer === undefined ? undefined : normalizeAssistantChatComposerState(raw.composer)
  if (raw.composer !== undefined && !composer) {
    return undefined
  }
  const entries: SyncedChatEntry[] = []
  const seen = new Set<string>()
  for (const candidate of raw.entries) {
    if (
      !candidate ||
      !counter(candidate.at) ||
      !counter(candidate.revision) ||
      (candidate.parentId !== null && !id(candidate.parentId))
    ) {
      return undefined
    }
    const message = sanitizeAssistantChatMessages([candidate.message])[0]
    if (!message || !id(message.id) || seen.has(message.id)) {
      return undefined
    }
    seen.add(message.id)
    entries.push({ message, at: candidate.at, revision: candidate.revision, parentId: candidate.parentId })
  }
  const deniedToolNames = raw.deniedToolNames ?? []
  if (
    !Array.isArray(deniedToolNames) ||
    deniedToolNames.length > 64 ||
    deniedToolNames.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(name))
  ) {
    return undefined
  }
  const removedMessageIds = raw.removedMessageIds ?? []
  if (
    !Array.isArray(removedMessageIds) ||
    removedMessageIds.length > 2048 ||
    removedMessageIds.some((value) => !id(value))
  ) {
    return undefined
  }
  return {
    ...base,
    kind: 'writer',
    ...(composer ? { composer } : {}),
    metadataUpdatedAt: counter(raw.metadataUpdatedAt) ? raw.metadataUpdatedAt : raw.updatedAt,
    title: raw.title.trim() || 'New chat',
    userRenamed: raw.userRenamed === true,
    tabKind: raw.tabKind ?? 'chat',
    ...(raw.conversationMode !== undefined
      ? {
          conversationMode: raw.conversationMode,
          conversationModeUpdatedAt:
            raw.conversationModeUpdatedAt ?? (counter(raw.metadataUpdatedAt) ? raw.metadataUpdatedAt : raw.updatedAt),
        }
      : {}),
    entries,
    deniedToolNames: [...new Set(deniedToolNames)],
    removedMessageIds: [...new Set(removedMessageIds)],
  }
}

const rank = (left: Parsed, right: Parsed): number =>
  left.record.updatedAt - right.record.updatedAt ||
  left.record.revision - right.record.revision ||
  left.uuid.localeCompare(right.uuid)

const selectMetadata = (writers: Parsed[]): Parsed | undefined => {
  writers = writers.filter(({ record }) => record.kind === 'writer')
  const manual = writers.filter(({ record }) => record.userRenamed)
  return [...(manual.length ? manual : writers)]
    .sort(
      (a, b) =>
        (a.record.metadataUpdatedAt ?? a.record.updatedAt) - (b.record.metadataUpdatedAt ?? b.record.updatedAt) ||
        rank(a, b),
    )
    .at(-1)
}

const selectConversationMode = (writers: Parsed[]): SyncedChatRecord | undefined => {
  return [...writers]
    .filter(({ record }) => record.conversationMode !== undefined)
    .sort(
      (a, b) =>
        (a.record.conversationModeUpdatedAt ?? a.record.metadataUpdatedAt ?? a.record.updatedAt) -
          (b.record.conversationModeUpdatedAt ?? b.record.metadataUpdatedAt ?? b.record.updatedAt) || rank(a, b),
    )
    .at(-1)?.record
}

/** Writer-owned entries merge by stable message ID; tombstones dominate every late checkpoint. */
function latestChatLifecycle(group: Parsed[]): Parsed | undefined {
  const latest = group
    .filter(({ record }) => record.kind === 'lifecycle')
    .sort(
      (a, b) =>
        a.record.revision - b.record.revision ||
        Number(a.record.state === 'trashed') - Number(b.record.state === 'trashed') ||
        rank(a, b),
    )
    .at(-1)
  return latest
}
function isChatTrashed(group: Parsed[]): boolean {
  return latestChatLifecycle(group)?.record.state === 'trashed'
}
function activeBudgetRecords(records: Parsed[]): Parsed[] {
  const inactive = new Set(records.filter(({ record }) => record.kind === 'deleted').map(({ record }) => record.chatId))
  const groups = new Map<string, Parsed[]>()
  for (const parsed of records) {
    const group = groups.get(parsed.record.chatId) ?? []
    group.push(parsed)
    groups.set(parsed.record.chatId, group)
  }
  for (const [chatId, group] of groups) {
    if (isChatTrashed(group)) {
      inactive.add(chatId)
    }
  }
  return records.filter(({ record }) => !inactive.has(record.chatId))
}
function serializedRecordUnits(
  records: Parsed[],
  measure: (record: Parsed) => number = (record) => JSON.stringify(record).length,
): number {
  return 2 + Math.max(0, records.length - 1) + records.reduce((sum, record) => sum + measure(record), 0)
}
function mergeComposer(records: Parsed[]): AssistantChatComposerState {
  const composer: AssistantChatComposerState = {}
  for (const field of ASSISTANT_COMPOSER_FIELDS) {
    const winner = records
      .filter(({ record }) => record.kind === 'writer' && record.composer?.[field])
      .sort(
        (a, b) =>
          a.record.composer![field]!.updatedAt - b.record.composer![field]!.updatedAt ||
          a.record.writerId.localeCompare(b.record.writerId) ||
          a.uuid.localeCompare(b.uuid),
      )
      .at(-1)
    if (winner) {
      Object.assign(composer, { [field]: winner.record.composer![field] })
    }
  }
  return composer
}

export function mergeSyncedChats(records: Parsed[], includeTrashed = false): SyncedChat[] {
  const groups = new Map<string, Parsed[]>()
  for (const entry of records) {
    const list = groups.get(entry.record.chatId) ?? []
    list.push(entry)
    groups.set(entry.record.chatId, list)
  }
  const chats: SyncedChat[] = []
  for (const [chatId, group] of groups) {
    if (group.some(({ record }) => record.kind === 'deleted')) {
      continue
    }
    const trashed = isChatTrashed(group)
    if (trashed && !includeTrashed) {
      continue
    }
    const byWriter = new Map<string, Parsed>()
    for (const candidate of group) {
      const previous = byWriter.get(candidate.record.writerId)
      if (
        candidate.record.kind === 'writer' &&
        (!previous ||
          candidate.record.revision > previous.record.revision ||
          (candidate.record.revision === previous.record.revision && rank(candidate, previous) > 0))
      ) {
        byWriter.set(candidate.record.writerId, candidate)
      }
    }
    const writers = [...byWriter.values()].sort(rank)
    const removed = new Set(writers.flatMap(({ record }) => record.removedMessageIds ?? []))
    const metadata = selectMetadata(writers)?.record
    const modeMetadata = selectConversationMode(writers)
    const mode = modeMetadata?.conversationMode
    if (!metadata) {
      continue
    }
    const byId = new Map<string, { entry: SyncedChatEntry; writer: Parsed }>()
    for (const writer of writers) {
      for (const entry of writer.record.entries ?? []) {
        if (removed.has(entry.message.id)) {
          continue
        }
        const previous = byId.get(entry.message.id)
        if (
          !previous ||
          (previous.writer.record.writerId === writer.record.writerId
            ? entry.revision > previous.entry.revision ||
              (entry.revision === previous.entry.revision && rank(writer, previous.writer) > 0)
            : writer.record.writerId.localeCompare(previous.writer.record.writerId) < 0)
        ) {
          byId.set(entry.message.id, { entry, writer })
        }
      }
    }
    // Parent links keep the prompt ahead of its answer even with device clock skew.
    // Cycles/unavailable parents fall back to deterministic bounded ordering.
    const pending = [...byId.values()].sort(
      (a, b) => a.entry.at - b.entry.at || a.entry.message.id.localeCompare(b.entry.message.id),
    )
    const ordered: PersistedAssistantMessage[] = []
    const emitted = new Set<string>()
    while (pending.length) {
      let index = pending.findIndex(
        ({ entry }) => entry.parentId === null || !byId.has(entry.parentId) || emitted.has(entry.parentId),
      )
      if (index < 0) {
        index = 0
      }
      const [{ entry }] = pending.splice(index, 1)
      ordered.push(entry.message)
      emitted.add(entry.message.id)
    }
    const composer = mergeComposer(writers)
    chats.push({
      ...(Object.keys(composer).length ? { composer } : {}),
      ...(trashed ? { trashed: true } : {}),
      tab: {
        id: chatId,
        title: metadata.title ?? 'New chat',
        userRenamed: metadata.userRenamed === true,
        kind: metadata.tabKind ?? 'chat',
        ...(mode !== undefined
          ? {
              conversationMode: mode,
              conversationModeUpdatedAt:
                modeMetadata?.conversationModeUpdatedAt ?? modeMetadata?.metadataUpdatedAt ?? modeMetadata?.updatedAt,
            }
          : {}),
        lastActiveAt: Math.max(...writers.map(({ record }) => record.updatedAt)),
      },
      messages: sanitizeAssistantChatMessages(ordered),
      deniedToolNames: [...new Set(writers.flatMap(({ record }) => record.deniedToolNames ?? []))].sort().slice(0, 64),
    })
  }
  return chats.sort((a, b) => (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0) || a.tab.id.localeCompare(b.tab.id))
}

/** A concrete store has one writer identity; other documents never replace its entries. */
const WRITER_STORAGE_PREFIX = 'assistant-chat-writer:v1:'
/** Content-free per-window identity survives reload; Web Locks below detect cloned sessionStorage. */
export function getAssistantChatWriterId(accountScope: string): string {
  try {
    const key = `${WRITER_STORAGE_PREFIX}${accountScope}`
    const saved = sessionStorage.getItem(key)
    if (id(saved)) {
      return saved
    }
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export class AssistantSyncedChats {
  private active = true
  private queue = Promise.resolve()
  private readonly parsedRecords = new Map<
    string,
    { content: unknown; serializedContent: string | undefined; parsed: Parsed | undefined; serializedLength: number }
  >()
  private previousRecords: Parsed[] = []
  private fingerprintBytes = 0
  private previousChats: SyncedChat[] = []
  private previousActiveChats: SyncedChat[] = []
  private mergedGroups = new Map<string, { records: Parsed[]; chat: SyncedChat | undefined }>()
  private catalogSerializedLength = 2
  private readonly budget: Readonly<AssistantChatStorageBudget>
  private readonly ownerUuid: string
  private _writerId: string
  private composerWriterId?: string
  private identityClaimed: boolean
  private releaseIdentity?: () => void
  get writerId(): string {
    return this._writerId
  }
  constructor(
    private readonly application: WebApplication,
    writerId?: string,
    budget: Partial<AssistantChatStorageBudget> = {},
  ) {
    this.budget = validateStorageBudget(budget)
    this.ownerUuid = application.sessions.getUser()?.uuid ?? ''
    this._writerId = writerId ?? getAssistantChatWriterId(this.ownerUuid)
    this.identityClaimed = writerId !== undefined
    if (!id(this.writerId) || !id(this.ownerUuid)) {
      throw new Error('A signed-in account is required for synced chats.')
    }
  }
  dispose(): void {
    this.active = false
    this.clearReadCache()
    this.releaseIdentity?.()
  }
  private clearReadCache(): void {
    this.parsedRecords.clear()
    this.fingerprintBytes = 0
    this.previousRecords = []
    this.previousChats = []
    this.previousActiveChats = []
    this.mergedGroups.clear()
    this.catalogSerializedLength = 2
  }
  private async claimIdentity(): Promise<void> {
    if (this.identityClaimed) {
      return
    }
    if (!navigator.locks) {
      throw new AssistantChatStorageError('WRITER_UNAVAILABLE', 'writer')
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let ready!: (acquired: boolean) => void
      const acquired = new Promise<boolean>((resolve) => {
        ready = resolve
      })
      let release!: () => void
      const lifetime = new Promise<void>((resolve) => {
        release = resolve
      })
      let requestFailed = false
      let requestCause: AssistantChatStorageFailureCause = 'unknown'
      void Promise.resolve()
        .then(() =>
          navigator.locks.request(
            `assistant-chat-writer:${this.ownerUuid}:${this.writerId}`,
            { mode: 'exclusive', ifAvailable: true },
            async (lock) => {
              ready(Boolean(lock))
              if (lock) {
                await lifetime
              }
            },
          ),
        )
        .catch((error: unknown) => {
          requestCause = storageCause(error)
          requestFailed = true
          ready(false)
        })
      if (await acquired) {
        if (!this.current()) {
          release()
          throw new AssistantChatStorageError('SESSION_CHANGED', 'writer')
        }
        this.releaseIdentity = release
        this.identityClaimed = true
        return
      }
      if (requestFailed) {
        throw new AssistantChatStorageError('WRITER_UNAVAILABLE', 'writer', requestCause)
      }
      // Browser duplication copies sessionStorage. The loser rotates before any item write.
      this._writerId = crypto.randomUUID()
      try {
        sessionStorage.setItem(`${WRITER_STORAGE_PREFIX}${this.ownerUuid}`, this.writerId)
      } catch {
        /* Session persistence is optional; writer admission is authoritative. */
      }
    }
    throw new AssistantChatStorageError('OWNERSHIP_LOST', 'writer')
  }
  private current(): boolean {
    return this.active && this.application.sessions.getUser()?.uuid === this.ownerUuid
  }
  private async assertAvailable(): Promise<void> {
    if (
      !this.current() ||
      !this.application.sync.isDatabaseLoaded() ||
      (await this.application.protections.isLocked()) ||
      !this.current()
    ) {
      this.clearReadCache()
      throw new AssistantChatStorageError('STORAGE_UNAVAILABLE', 'access')
    }
  }
  private records(): Parsed[] {
    const seen = new Set<string>()
    const records = this.application.items
      .getItems<DecryptedItemInterface>(ASSISTANT_CHAT_CONTENT_TYPE)
      .flatMap((item) => {
        // Admission is deliberately rechecked even for an unchanged immutable payload.
        if (item.shared_vault_uuid || item.key_system_identifier || !this.application.isAuthorizedToRenderItem(item)) {
          return []
        }
        seen.add(item.uuid)
        let cached = this.parsedRecords.get(item.uuid)
        if (!cached || cached.content !== item.content) {
          // Sync acknowledgements also reconstruct payloads and copy content.
          // Equal raw content can reuse its validated transcript; equal revision
          // clocks cannot, since a remote writer may send different contents.
          const serializedContent = serializeSyncedChatContent(item.content)
          if (cached && serializedContent !== undefined && cached.serializedContent === serializedContent) {
            cached.content = item.content
          } else {
            const record =
              serializedContent === undefined ? undefined : normalizeSerializedChatContent(item.content, this.ownerUuid)
            const parsed = record ? { uuid: item.uuid, record } : undefined
            this.fingerprintBytes -= (cached?.serializedContent?.length ?? 0) * 2
            // Decrypted records already own their content. Do not duplicate an
            // unbounded imported catalog (or invalid records) as JSON strings.
            // Count UTF-16 bytes conservatively; cache misses still read normally.
            const retainFingerprint =
              parsed !== undefined &&
              serializedContent !== undefined &&
              this.fingerprintBytes + serializedContent.length * 2 <= MAX_SYNCED_CHAT_FINGERPRINT_BYTES
            const fingerprint = retainFingerprint ? serializedContent : undefined
            this.fingerprintBytes += (fingerprint?.length ?? 0) * 2
            cached = {
              content: item.content,
              serializedContent: fingerprint,
              parsed,
              serializedLength: parsed ? JSON.stringify(parsed).length : 0,
            }
          }
          this.parsedRecords.set(item.uuid, cached)
        }
        return cached.parsed ? [cached.parsed] : []
      })
    for (const uuid of this.parsedRecords.keys()) {
      if (!seen.has(uuid)) {
        this.fingerprintBytes -= (this.parsedRecords.get(uuid)?.serializedContent?.length ?? 0) * 2
        this.parsedRecords.delete(uuid)
      }
    }
    // Exactly JSON.stringify(records).length: brackets, commas and each serialized
    // {uuid,record}. Keep the existing UTF-16 length budget, not a different byte unit.
    this.catalogSerializedLength =
      2 +
      Math.max(0, records.length - 1) +
      records.reduce((sum, parsed) => sum + this.parsedRecords.get(parsed.uuid)!.serializedLength, 0)
    return records
  }
  async read(options?: { includeTrashed?: boolean }): Promise<SyncedChat[]> {
    await this.assertAvailable()
    const records = this.records()
    if (
      records.length !== this.previousRecords.length ||
      records.some((record, index) => record !== this.previousRecords[index])
    ) {
      this.previousRecords = records
      const groups = new Map<string, Parsed[]>()
      for (const parsed of records) {
        const group = groups.get(parsed.record.chatId) ?? []
        group.push(parsed)
        groups.set(parsed.record.chatId, group)
      }
      const mergedGroups = new Map<string, { records: Parsed[]; chat: SyncedChat | undefined }>()
      const chats: SyncedChat[] = []
      for (const [chatId, group] of groups) {
        let cached = this.mergedGroups.get(chatId)
        if (
          !cached ||
          cached.records.length !== group.length ||
          group.some((record, index) => record !== cached!.records[index])
        ) {
          cached = { records: group, chat: mergeSyncedChats(group, true)[0] }
        }
        mergedGroups.set(chatId, cached)
        if (cached.chat) {
          chats.push(cached.chat)
        }
      }
      this.mergedGroups = mergedGroups
      this.previousChats = chats.sort(
        (a, b) => (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0) || a.tab.id.localeCompare(b.tab.id),
      )
    }
    this.previousActiveChats = reconcileSyncedChatSnapshots(
      this.previousActiveChats,
      this.previousChats.filter((chat) => !chat.trashed),
    )
    return options?.includeTrashed ? this.previousChats : this.previousActiveChats
  }
  subscribe(listener: () => void): () => void {
    return this.application.items.addObserver(ASSISTANT_CHAT_CONTENT_TYPE, () => {
      if (this.current()) {
        listener()
      }
    })
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.queue.catch(() => undefined).then(operation)
    this.queue = pending
    return pending
  }
  /** Metadata and locally authored messages only. Run admission is a separate server lease. */
  checkpointComposer(chatId: string, patch: AssistantChatComposerPatch, tab?: ChatTab): Promise<void> {
    return this.save(
      tab && tab.id === chatId ? tab : { id: chatId, title: 'New chat', userRenamed: false },
      undefined,
      [],
      patch,
    )
  }

  save(
    tab: ChatTab,
    messages: PersistedAssistantMessage[] | undefined,
    deniedToolNames: string[] = [],
    composerPatch?: AssistantChatComposerPatch,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      await this.claimIdentity()
      if (this.application.sessions.isCurrentSessionReadOnly()) {
        throw new AssistantChatStorageError('READ_ONLY', 'validate')
      }
      if (!id(tab.id)) {
        throw new AssistantChatStorageError('INVALID_CHAT', 'validate')
      }
      const records = this.records(),
        group = records.filter(({ record }) => record.chatId === tab.id)
      if (group.some(({ record }) => record.kind === 'deleted')) {
        throw new AssistantChatStorageError('CHAT_DELETED', 'validate')
      }
      if (isChatTrashed(group)) {
        throw new AssistantChatStorageError('CHAT_TRASHED', 'validate')
      }
      // A tiny dedicated record avoids rewriting the transcript on every draft keystroke.
      // It consumes one additional writer slot and shares the claimed session identity.
      const writeIdentity =
        composerPatch === undefined
          ? this.writerId
          : (this.composerWriterId ??= `composer-${base64Url(sha256(utf8Bytes(`assistant-composer-v1:${this.writerId}`)))}`)
      const own = group
        .filter(({ record }) => record.kind === 'writer' && record.writerId === writeIdentity)
        .sort((a, b) => a.record.revision - b.record.revision || rank(a, b))
        .at(-1)
      if (
        !own &&
        new Set(group.filter(({ record }) => record.kind === 'writer').map(({ record }) => record.writerId)).size >=
          MAX_CHAT_WRITERS
      ) {
        throw new AssistantChatStorageError('WRITER_LIMIT', 'validate')
      }
      if (
        !group.some(({ record }) => record.kind === 'writer') &&
        mergeSyncedChats(records).length >= this.budget.chats
      ) {
        throw new AssistantChatStorageError('CHAT_LIMIT', 'validate')
      }
      const revision = (own?.record.revision ?? 0) + 1,
        updatedAt = Date.now()
      const ownership = new Map<string, string>()
      for (const { record } of group) {
        for (const entry of record.entries ?? []) {
          if (!ownership.has(entry.message.id) || record.writerId.localeCompare(ownership.get(entry.message.id)!) < 0) {
            ownership.set(entry.message.id, record.writerId)
          }
        }
      }
      const removed = new Set(group.flatMap(({ record }) => record.removedMessageIds ?? []))
      const previous = new Map((own?.record.entries ?? []).map((entry) => [entry.message.id, entry]))
      let parentId: string | null = null
      const entries: SyncedChatEntry[] = messages === undefined ? [...(own?.record.entries ?? [])] : []
      for (const message of sanitizeAssistantChatMessages(messages ?? [])) {
        if (removed.has(message.id)) {
          continue
        }
        if (!ownership.has(message.id) || ownership.get(message.id) === this.writerId) {
          entries.push({ message, parentId, at: previous.get(message.id)?.at ?? updatedAt + entries.length, revision })
        }
        parentId = message.id
      }
      const inheritedMetadata = selectMetadata(group)?.record
      const inheritedMode = selectConversationMode(group)
      const inheritedModeClock =
        inheritedMode?.conversationModeUpdatedAt ?? inheritedMode?.metadataUpdatedAt ?? inheritedMode?.updatedAt ?? 0
      const modeChanged =
        composerPatch === undefined &&
        messages === undefined &&
        tab.conversationMode !== undefined &&
        tab.conversationMode !== inheritedMode?.conversationMode &&
        (tab.conversationModeUpdatedAt === undefined || tab.conversationModeUpdatedAt >= inheritedModeClock)
      const conversationMode = modeChanged
        ? tab.conversationMode
        : (inheritedMode?.conversationMode ?? tab.conversationMode)
      const metadataChanged =
        composerPatch === undefined && messages === undefined && !(inheritedMetadata?.userRenamed && !tab.userRenamed)
      const metadata = metadataChanged
        ? tab
        : inheritedMetadata
          ? {
              title: inheritedMetadata.title ?? tab.title,
              userRenamed: inheritedMetadata.userRenamed === true,
              kind: inheritedMetadata.tabKind,
            }
          : tab
      const composer = { ...(own?.record.composer ?? {}) }
      if (composerPatch !== undefined) {
        const inheritedComposer = mergeComposer(group)
        for (const field of ASSISTANT_COMPOSER_FIELDS) {
          if (composerPatch[field] !== undefined) {
            Object.assign(composer, {
              [field]: {
                value: composerPatch[field],
                updatedAt: Math.max(updatedAt, (inheritedComposer[field]?.updatedAt ?? 0) + 1),
              },
            })
          }
        }
      }
      const candidate = {
        version: 1,
        ownerUuid: this.ownerUuid,
        chatId: tab.id,
        kind: 'writer',
        ...(Object.keys(composer).length ? { composer } : {}),
        removedMessageIds: own?.record.removedMessageIds ?? [],
        writerId: writeIdentity,
        revision,
        updatedAt,
        metadataUpdatedAt: metadataChanged
          ? updatedAt
          : (inheritedMetadata?.metadataUpdatedAt ?? inheritedMetadata?.updatedAt ?? updatedAt),
        title: metadata.title.slice(0, 40),
        userRenamed: metadata.userRenamed,
        tabKind: metadata.kind ?? 'chat',
        ...(conversationMode !== undefined
          ? {
              conversationMode,
              conversationModeUpdatedAt: modeChanged
                ? Math.max(tab.conversationModeUpdatedAt ?? updatedAt, inheritedModeClock + 1)
                : (inheritedMode?.conversationModeUpdatedAt ??
                  inheritedMode?.metadataUpdatedAt ??
                  inheritedMode?.updatedAt ??
                  updatedAt),
            }
          : {}),
        entries,
        deniedToolNames: messages === undefined ? (own?.record.deniedToolNames ?? deniedToolNames) : deniedToolNames,
      }
      if (JSON.stringify(candidate).length > MAX_RECORD_BYTES) {
        throw new AssistantChatStorageError('RECORD_SIZE_LIMIT', 'validate')
      }
      const record = normalizeSerializedChatContent(candidate, this.ownerUuid)
      if (!record) {
        throw new AssistantChatStorageError('HISTORY_INVALID', 'validate')
      }
      this.assertProjectedBudget(this.records(), own?.uuid, record)
      await this.write(own?.uuid, record)
    })
  }
  removeMessage(chatId: string, messageId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      await this.claimIdentity()
      if (!id(chatId) || !id(messageId) || this.application.sessions.isCurrentSessionReadOnly()) {
        throw new Error('This message cannot be removed in the current session.')
      }
      const group = this.records().filter(({ record }) => record.chatId === chatId)
      if (group.some(({ record }) => record.kind === 'deleted')) {
        throw new AssistantChatStorageError('CHAT_DELETED', 'validate')
      }
      if (isChatTrashed(group)) {
        throw new AssistantChatStorageError('CHAT_TRASHED', 'validate')
      }
      const merged = mergeSyncedChats(group)[0]
      if (!merged) {
        return
      }
      const own = group
        .filter(({ record }) => record.kind === 'writer' && record.writerId === this.writerId)
        .sort((a, b) => a.record.revision - b.record.revision || rank(a, b))
        .at(-1)
      const removedMessageIds = [...new Set([...(own?.record.removedMessageIds ?? []), messageId])]
      const record = normalizeSyncedChatRecord(
        {
          version: 1,
          ownerUuid: this.ownerUuid,
          chatId,
          kind: 'writer',
          writerId: this.writerId,
          revision: (own?.record.revision ?? 0) + 1,
          updatedAt: Date.now(),
          metadataUpdatedAt: selectMetadata(group)?.record.metadataUpdatedAt ?? selectMetadata(group)?.record.updatedAt,
          title: merged.tab.title,
          userRenamed: merged.tab.userRenamed,
          tabKind: merged.tab.kind,
          ...(merged.tab.conversationMode !== undefined
            ? {
                conversationMode: merged.tab.conversationMode,
                conversationModeUpdatedAt:
                  selectConversationMode(group)?.conversationModeUpdatedAt ??
                  selectConversationMode(group)?.metadataUpdatedAt ??
                  selectConversationMode(group)?.updatedAt,
              }
            : {}),
          ...(own?.record.composer ? { composer: own.record.composer } : {}),
          entries: (own?.record.entries ?? []).filter((entry) => entry.message.id !== messageId),
          deniedToolNames: own?.record.deniedToolNames ?? [],
          removedMessageIds,
        },
        this.ownerUuid,
      )
      if (!record) {
        throw new Error('This chat has reached its deletion limit. Delete the chat to remove its remaining messages.')
      }
      this.assertProjectedBudget(this.records(), own?.uuid, record)
      await this.write(own?.uuid, record)
    })
  }
  private measureRecord = (parsed: Parsed): number => {
    const cached = this.parsedRecords.get(parsed.uuid)
    return cached?.parsed === parsed ? cached.serializedLength : JSON.stringify(parsed).length
  }
  private assertProjectedBudget(records: Parsed[], uuid: string | undefined, record: SyncedChatRecord): void {
    const before = activeBudgetRecords(records)
    const after = activeBudgetRecords([
      ...records.filter((item) => item.uuid !== uuid),
      { uuid: uuid ?? '00000000-0000-0000-0000-000000000000', record },
    ])
    const previousChats = new Set(
      before.filter(({ record }) => record.kind === 'writer').map(({ record }) => record.chatId),
    ).size
    const projectedChats = new Set(
      after.filter(({ record }) => record.kind === 'writer').map(({ record }) => record.chatId),
    ).size
    if (projectedChats > this.budget.chats && projectedChats > previousChats) {
      throw new AssistantChatStorageError('CHAT_LIMIT', 'validate')
    }
    const writerCount = before.filter(({ record }) => record.kind === 'writer').length
    const projectedCount = after.filter(({ record }) => record.kind === 'writer').length
    if (projectedCount > this.budget.records && projectedCount > writerCount) {
      throw new AssistantChatStorageError('STORAGE_RECORD_LIMIT', 'validate')
    }
    const previousUnits = serializedRecordUnits(before, this.measureRecord),
      projectedUnits = serializedRecordUnits(after, this.measureRecord)
    if (projectedUnits > this.budget.serializedUnits && projectedUnits > previousUnits) {
      throw new AssistantChatStorageError('STORAGE_SIZE_LIMIT', 'validate')
    }
  }
  async getStorageStats(): Promise<AssistantChatStorageStats> {
    await this.assertAvailable()
    const records = this.records()
    const groups = new Map<string, Parsed[]>()
    for (const item of records) {
      const group = groups.get(item.record.chatId) ?? []
      group.push(item)
      groups.set(item.record.chatId, group)
    }
    let deletedSerializedUnits = 0,
      trashedSerializedUnits = 0
    let deletedResidualRecords = 0
    let activeChats = 0,
      trashedChats = 0,
      deletedChats = 0
    for (const group of groups.values()) {
      if (group.some(({ record }) => record.kind === 'deleted')) {
        deletedChats++
        deletedSerializedUnits += serializedRecordUnits(group, this.measureRecord) - 2
        deletedResidualRecords += group.filter(({ record }) => record.kind !== 'deleted').length
      } else if (isChatTrashed(group)) {
        trashedChats++
        trashedSerializedUnits += serializedRecordUnits(group, this.measureRecord) - 2
      } else if (group.some(({ record }) => record.kind === 'writer')) {
        activeChats++
      }
    }
    return {
      activeChats,
      budgetedWriterRecords: activeBudgetRecords(records).filter(({ record }) => record.kind === 'writer').length,
      budgetedSerializedUnits: serializedRecordUnits(activeBudgetRecords(records), this.measureRecord),
      deletedSerializedUnits,
      trashedSerializedUnits,
      trashRetentionDays: ASSISTANT_CHAT_TRASH_RETENTION_DAYS,
      deletedResidualRecords,
      trashedChats,
      deletedChats,
      writerRecords: records.filter(({ record }) => record.kind === 'writer').length,
      lifecycleRecords: records.filter(({ record }) => record.kind === 'lifecycle').length,
      invalidRecords: [...this.parsedRecords.values()].filter((value) => !value.parsed).length,
      serializedUnits: this.catalogSerializedLength,
      limits: {
        chats: this.budget.chats,
        writersPerChat: MAX_CHAT_WRITERS,
        records: this.budget.records,
        serializedUnits: this.budget.serializedUnits,
        recordUnits: MAX_RECORD_BYTES,
      },
    }
  }
  trash(chatId: string): Promise<void> {
    return this.setTrashState(chatId, 'trashed')
  }
  restore(chatId: string): Promise<void> {
    return this.setTrashState(chatId, 'active')
  }
  private setTrashState(chatId: string, state: 'active' | 'trashed'): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      await this.claimIdentity()
      if (this.application.sessions.isCurrentSessionReadOnly()) {
        throw new AssistantChatStorageError('READ_ONLY', 'validate')
      }
      if (!id(chatId)) {
        throw new AssistantChatStorageError('INVALID_CHAT', 'validate')
      }
      const group = this.records().filter(({ record }) => record.chatId === chatId)
      if (group.some(({ record }) => record.kind === 'deleted')) {
        throw new AssistantChatStorageError('CHAT_DELETED', 'validate')
      }
      if (!group.some(({ record }) => record.kind === 'writer') || isChatTrashed(group) === (state === 'trashed')) {
        return
      }
      const lifecycle = group.filter(({ record }) => record.kind === 'lifecycle')
      const revision = Math.max(0, ...lifecycle.map(({ record }) => record.revision)) + 1
      if (!counter(revision)) {
        throw new AssistantChatStorageError('HISTORY_INVALID', 'validate')
      }
      const own = lifecycle
        .filter(({ record }) => record.writerId === this.writerId)
        .sort(rank)
        .at(-1)
      // Tiny content-free control records are admitted even over budget so users can recover.
      const control: SyncedChatRecord = {
        version: 1,
        ownerUuid: this.ownerUuid,
        chatId,
        kind: 'lifecycle',
        state,
        writerId: this.writerId,
        revision,
        updatedAt: Date.now(),
      }
      if (state === 'active') {
        this.assertProjectedBudget(this.records(), own?.uuid, control)
      }
      await this.write(own?.uuid, control)
    })
  }
  private isExpiredTrash(group: Parsed[], cutoff: number): boolean {
    const winner = latestChatLifecycle(group)
    if (winner?.record.state !== 'trashed') {
      return false
    }
    const item = this.application.items.findItem<DecryptedItemInterface>(winner.uuid)
    const serverTime = item?.serverUpdatedAtTimestamp
    return Boolean(
      item &&
      !item.dirty &&
      typeof serverTime === 'number' &&
      Number.isFinite(serverTime) &&
      serverTime > 0 &&
      Math.max(winner.record.updatedAt, serverTime) <= cutoff,
    )
  }
  /** Explicit bounded maintenance; reads and diagnostics never delete history. */
  async pruneExpiredTrash(): Promise<void> {
    await this.assertAvailable()
    const cutoff = Date.now() - ASSISTANT_CHAT_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const groups = new Map<string, Parsed[]>()
    for (const parsed of this.records()) {
      const group = groups.get(parsed.record.chatId) ?? []
      group.push(parsed)
      groups.set(parsed.record.chatId, group)
    }
    const eligible = [...groups]
      .filter(
        ([, group]) =>
          this.isExpiredTrash(group, cutoff) ||
          (group.some(({ record }) => record.kind === 'deleted') &&
            group.some(({ record }) => record.kind !== 'deleted')),
      )
      .slice(0, MAX_TRASH_PRUNE_ROOMS)
    if (!eligible.length) {
      return
    }
    let failure: unknown
    try {
      for (const [chatId] of eligible) {
        await this.purge(chatId, true, cutoff, true)
      }
    } catch (error) {
      failure = error
    }
    if (this.current()) {
      try {
        await this.application.sync.sync({ sourceDescription: 'Assistant expired trash cleanup' })
      } catch (error) {
        failure ??= storageFailure(error, 'checkpoint')
      }
    }
    if (failure) {
      throw failure
    }
  }
  async emptyTrash(): Promise<void> {
    await this.assertAvailable()
    const records = this.records()
    const groups = new Map<string, Parsed[]>()
    for (const parsed of records) {
      const group = groups.get(parsed.record.chatId) ?? []
      group.push(parsed)
      groups.set(parsed.record.chatId, group)
    }
    for (const [chatId, group] of groups) {
      if (
        isChatTrashed(group) ||
        (group.some(({ record }) => record.kind === 'deleted') && group.some(({ record }) => record.kind !== 'deleted'))
      ) {
        await this.purge(chatId, true)
      }
    }
  }
  updateMetadata(tab: ChatTab): Promise<void> {
    return this.save(tab, undefined)
  }
  purgeTrashed(chatId: string): Promise<void> {
    return this.purge(chatId, true)
  }
  delete(chatId: string): Promise<void> {
    return this.purge(chatId, false)
  }
  private purge(chatId: string, onlyTrashed: boolean, expiryCutoff?: number, deferSync = false): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      if (!id(chatId) || this.application.sessions.isCurrentSessionReadOnly()) {
        throw new Error('This chat cannot be deleted in the current session.')
      }
      const group = this.records().filter(({ record }) => record.chatId === chatId)
      const marker = group.find(({ record }) => record.kind === 'deleted')
      if (onlyTrashed && !marker && !isChatTrashed(group)) {
        return
      }
      if (!marker && expiryCutoff !== undefined && !this.isExpiredTrash(group, expiryCutoff)) {
        return
      }
      if (!marker) {
        await this.write(
          undefined,
          {
            version: 1,
            ownerUuid: this.ownerUuid,
            chatId,
            kind: 'deleted',
            writerId: this.writerId,
            revision: 1,
            updatedAt: Date.now(),
          },
          !deferSync,
        )
      }
      // Tombstone remains encrypted and content-free. Delete transcript-bearing records.
      for (const { uuid, record } of group) {
        if (record.kind === 'deleted') {
          continue
        }
        if (!this.current()) {
          return
        }
        const item = this.application.items.findItem(uuid)
        if (item) {
          try {
            await this.application.mutator.deleteItem(item)
          } catch (error) {
            throw storageFailure(error, 'write')
          }
        }
      }
      if (this.current() && !deferSync) {
        try {
          await this.application.sync.sync({ sourceDescription: 'Assistant chat deletion' })
        } catch (error) {
          throw storageFailure(error, 'checkpoint')
        }
      }
    })
  }
  private async write(uuid: string | undefined, record: SyncedChatRecord, sync = true): Promise<void> {
    if (!this.current()) {
      throw new AssistantChatStorageError('SESSION_CHANGED', 'write')
    }
    const content = { ...record, references: [] } as ItemContent
    try {
      if (uuid) {
        const item = this.application.items.findItem<DecryptedItemInterface>(uuid)
        if (!item) {
          throw new AssistantChatStorageError('CHECKPOINT_MISSING', 'write')
        }
        await this.application.mutator.changeItem<DecryptedItemMutator>(item, (mutator) => {
          if (!this.current()) {
            throw new AssistantChatStorageError('SESSION_CHANGED', 'write')
          }
          mutator.setCustomContent(content)
        })
      } else {
        await this.application.mutator.createItem(ASSISTANT_CHAT_CONTENT_TYPE, content, true)
      }
    } catch (error) {
      throw storageFailure(error, 'write')
    }
    if (!this.current()) {
      throw new AssistantChatStorageError('SESSION_CHANGED', 'write')
    }
    if (!sync) {
      return
    }
    try {
      await this.application.sync.sync({ sourceDescription: 'Assistant encrypted chat checkpoint' })
    } catch (error) {
      throw storageFailure(error, 'checkpoint')
    }
  }
}

export type AssistantChatStorageStats = {
  budgetedWriterRecords: number
  budgetedSerializedUnits: number
  deletedSerializedUnits: number
  trashedSerializedUnits: number
  trashRetentionDays: number
  deletedResidualRecords: number
  activeChats: number
  trashedChats: number
  deletedChats: number
  writerRecords: number
  lifecycleRecords: number
  invalidRecords: number
  serializedUnits: number
  limits: { chats: number; writersPerChat: number; records: number; serializedUnits: number; recordUnits: number }
}
/** Account-gated aggregate only; never returns identifiers or transcript content. */
export async function readAssistantChatStorageStats(
  application: WebApplication,
  accountScope: string,
): Promise<AssistantChatStorageStats | undefined> {
  const userUuid = application.sessions.getUser()?.uuid
  if (!userUuid || `account:${userUuid}` !== accountScope) {
    return undefined
  }
  const store = new AssistantSyncedChats(application, 'storage-diagnostics')
  try {
    return await store.getStorageStats()
  } catch {
    return undefined
  } finally {
    store.dispose()
  }
}
