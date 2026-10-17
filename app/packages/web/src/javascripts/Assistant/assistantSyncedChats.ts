/** Account-private chat records travel through the ordinary E2E encrypted item/socket sync pipeline. */
import { DecryptedItemInterface, DecryptedItemMutator, ItemContent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { PersistedAssistantMessage, sanitizeAssistantChatMessages } from './assistantChatHistory'
import type { AssistantWorkTabKind, ChatTab } from './chatTabs'
import { AssistantConversationMode, isAssistantConversationMode } from './conversationModes'

export const ASSISTANT_CHAT_CONTENT_TYPE = 'SN|AssistantChat'
export const MAX_SYNCED_CHATS = 100
export const MAX_CHAT_WRITERS = 64
export const MAX_SYNCED_CHAT_RECORDS = 512
export const MAX_SYNCED_CHAT_BYTES = 16 * 1024 * 1024
/** Raw JSON fingerprints are optional acceleration, never a limit on readable history. */
export const MAX_SYNCED_CHAT_FINGERPRINT_BYTES = 16 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_ENTRIES = 80
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
  kind: 'writer' | 'deleted'
  writerId: string
  revision: number
  updatedAt: number
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
export type SyncedChat = { tab: ChatTab; messages: PersistedAssistantMessage[]; deniedToolNames: string[] }
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
    !['writer', 'deleted'].includes(raw.kind ?? '')
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
export function mergeSyncedChats(records: Parsed[]): SyncedChat[] {
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
    chats.push({
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
  return chats
    .sort((a, b) => (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0) || a.tab.id.localeCompare(b.tab.id))
    .slice(0, MAX_SYNCED_CHATS)
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
  private mergedGroups = new Map<string, { records: Parsed[]; chat: SyncedChat | undefined }>()
  private catalogSerializedLength = 2
  private readonly ownerUuid: string
  private _writerId: string
  private identityClaimed: boolean
  private releaseIdentity?: () => void
  get writerId(): string {
    return this._writerId
  }
  constructor(
    private readonly application: WebApplication,
    writerId?: string,
  ) {
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
    this.mergedGroups.clear()
    this.catalogSerializedLength = 2
  }
  private async claimIdentity(): Promise<void> {
    if (this.identityClaimed) {
      return
    }
    if (!navigator.locks) {
      throw new Error('This browser cannot coordinate encrypted chat writers safely.')
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
      void navigator.locks
        .request(
          `assistant-chat-writer:${this.ownerUuid}:${this.writerId}`,
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            ready(Boolean(lock))
            if (lock) {
              await lifetime
            }
          },
        )
        .catch(() => ready(false))
      if (await acquired) {
        if (!this.current()) {
          release()
          throw new Error('The account changed before chat writer admission.')
        }
        this.releaseIdentity = release
        this.identityClaimed = true
        return
      }
      // Browser duplication copies sessionStorage. The loser rotates before any item write.
      this._writerId = crypto.randomUUID()
      try {
        sessionStorage.setItem(`${WRITER_STORAGE_PREFIX}${this.ownerUuid}`, this.writerId)
      } catch {
        /* Session persistence is optional; writer admission is authoritative. */
      }
    }
    throw new Error('Another view owns this chat writer identity. Try again.')
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
      throw new Error('Synced chats are unavailable until this account is loaded and unlocked.')
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
  async read(): Promise<SyncedChat[]> {
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
          cached = { records: group, chat: mergeSyncedChats(group)[0] }
        }
        mergedGroups.set(chatId, cached)
        if (cached.chat) {
          chats.push(cached.chat)
        }
      }
      this.mergedGroups = mergedGroups
      this.previousChats = chats
        .sort((a, b) => (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0) || a.tab.id.localeCompare(b.tab.id))
        .slice(0, MAX_SYNCED_CHATS)
    }
    return this.previousChats
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
  save(tab: ChatTab, messages: PersistedAssistantMessage[] | undefined, deniedToolNames: string[] = []): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      await this.claimIdentity()
      if (this.application.sessions.isCurrentSessionReadOnly()) {
        throw new Error('This session cannot save synced chats.')
      }
      if (!id(tab.id)) {
        throw new Error('Invalid synced chat identity.')
      }
      const records = this.records(),
        group = records.filter(({ record }) => record.chatId === tab.id)
      if (group.some(({ record }) => record.kind === 'deleted')) {
        throw new Error('This chat was deleted on another device.')
      }
      const own = group
        .filter(({ record }) => record.writerId === this.writerId)
        .sort((a, b) => a.record.revision - b.record.revision || rank(a, b))
        .at(-1)
      if (!own && new Set(group.map(({ record }) => record.writerId)).size >= MAX_CHAT_WRITERS) {
        throw new Error('This chat has reached its writer limit. Start a new chat to continue.')
      }
      if (!group.length && mergeSyncedChats(records).length >= MAX_SYNCED_CHATS) {
        throw new Error('Synced chat storage is full. Delete an older chat first.')
      }
      if (
        (!own && records.filter(({ record }) => record.kind === 'writer').length >= MAX_SYNCED_CHAT_RECORDS) ||
        this.catalogSerializedLength >= MAX_SYNCED_CHAT_BYTES
      ) {
        throw new Error(
          'The encrypted chat storage budget is full, including retained deletion markers. Export or start with a different account before adding more history.',
        )
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
        messages === undefined &&
        tab.conversationMode !== undefined &&
        tab.conversationMode !== inheritedMode?.conversationMode &&
        (tab.conversationModeUpdatedAt === undefined || tab.conversationModeUpdatedAt >= inheritedModeClock)
      const conversationMode = modeChanged
        ? tab.conversationMode
        : (inheritedMode?.conversationMode ?? tab.conversationMode)
      const metadataChanged = messages === undefined && !(inheritedMetadata?.userRenamed && !tab.userRenamed)
      const metadata = metadataChanged
        ? tab
        : inheritedMetadata
          ? {
              title: inheritedMetadata.title ?? tab.title,
              userRenamed: inheritedMetadata.userRenamed === true,
              kind: inheritedMetadata.tabKind,
            }
          : tab
      const record = normalizeSyncedChatRecord(
        {
          version: 1,
          ownerUuid: this.ownerUuid,
          chatId: tab.id,
          kind: 'writer',
          removedMessageIds: own?.record.removedMessageIds ?? [],
          writerId: this.writerId,
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
        },
        this.ownerUuid,
      )
      if (!record) {
        throw new Error('Chat checkpoint did not pass encrypted storage validation.')
      }
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
        throw new Error('This chat was deleted on another device.')
      }
      const merged = mergeSyncedChats(group)[0]
      if (!merged) {
        return
      }
      const own = group
        .filter(({ record }) => record.writerId === this.writerId)
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
          entries: (own?.record.entries ?? []).filter((entry) => entry.message.id !== messageId),
          deniedToolNames: own?.record.deniedToolNames ?? [],
          removedMessageIds,
        },
        this.ownerUuid,
      )
      if (!record) {
        throw new Error('This chat has reached its deletion limit. Delete the chat to remove its remaining messages.')
      }
      await this.write(own?.uuid, record)
    })
  }
  updateMetadata(tab: ChatTab): Promise<void> {
    return this.save(tab, undefined)
  }
  delete(chatId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAvailable()
      if (!id(chatId) || this.application.sessions.isCurrentSessionReadOnly()) {
        throw new Error('This chat cannot be deleted in the current session.')
      }
      const group = this.records().filter(({ record }) => record.chatId === chatId)
      if (group.some(({ record }) => record.kind === 'deleted')) {
        return
      }
      await this.write(undefined, {
        version: 1,
        ownerUuid: this.ownerUuid,
        chatId,
        kind: 'deleted',
        writerId: this.writerId,
        revision: 1,
        updatedAt: Date.now(),
      })
      // Tombstone remains encrypted and content-free. Delete transcript-bearing records.
      for (const { uuid } of group) {
        if (!this.current()) {
          return
        }
        const item = this.application.items.findItem(uuid)
        if (item) {
          await this.application.mutator.deleteItem(item)
        }
      }
      if (this.current()) {
        await this.application.sync.sync({ sourceDescription: 'Assistant chat deletion' })
      }
    })
  }
  private async write(uuid: string | undefined, record: SyncedChatRecord): Promise<void> {
    if (!this.current()) {
      throw new Error('The account changed before this chat could be saved.')
    }
    const content = { ...record, references: [] } as ItemContent
    if (uuid) {
      const item = this.application.items.findItem<DecryptedItemInterface>(uuid)
      if (!item) {
        throw new Error('The chat checkpoint disappeared before saving.')
      }
      await this.application.mutator.changeItem<DecryptedItemMutator>(item, (mutator) => {
        if (!this.current()) {
          throw new Error('The account changed before saving.')
        }
        mutator.setCustomContent(content)
      })
    } else {
      await this.application.mutator.createItem(ASSISTANT_CHAT_CONTENT_TYPE, content, true)
    }
    if (!this.current()) {
      throw new Error('The account changed while this chat was saving.')
    }
    await this.application.sync.sync({ sourceDescription: 'Assistant encrypted chat checkpoint' })
  }
}
