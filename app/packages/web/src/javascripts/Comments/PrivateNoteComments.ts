import { ContentType, PrefKey, SNNote, SNUserPrefs, DecryptedItemInterface, ItemContent } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { NoteComment, normalizeComment, MAX_NOTE_COMMENTS, utf8ByteLength, generateCommentId } from './comments'

import {
  PRIVATE_COMMENT_CONTENT_TYPE,
  MAX_PRIVATE_OPERATION_RECORDS,
  MAX_PRIVATE_OPERATION_CATALOG_BYTES,
  MAX_PRIVATE_TOMBSTONE_RECORDS,
  normalizePrivateCommentOperation,
  projectPrivateComments,
  privateCommentKey,
  validPrivateCommentList,
  PrivateCommentOperation,
  PrivateCommentChange,
  PrivateCommentProjection,
} from './PrivateCommentOperations'

// Literal also works while older generated SDK bundles are being rebuilt.
export const PRIVATE_NOTE_COMMENTS_KEY = 'privateNoteComments' as PrefKey.PrivateNoteComments
export const MAX_PRIVATE_COMMENT_BYTES = 256 * 1024
export const MAX_PRIVATE_COMMENT_NOTES = 256
type PrivateComments = { version: 1; ownerUuid: string; notes: Record<string, NoteComment[]> }
const queues = new WeakMap<WebApplication, Promise<unknown>>()

export function normalizePrivateComments(value: unknown, ownerUuid: string): PrivateComments | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Partial<PrivateComments>
  if (
    candidate.version !== 1 ||
    candidate.ownerUuid !== ownerUuid ||
    !candidate.notes ||
    typeof candidate.notes !== 'object' ||
    Array.isArray(candidate.notes)
  ) {
    return undefined
  }
  const entries = Object.entries(candidate.notes)
  let bytes: number
  try {
    bytes = utf8ByteLength(JSON.stringify(value))
  } catch {
    return undefined
  }
  if (entries.length > MAX_PRIVATE_COMMENT_NOTES || bytes > MAX_PRIVATE_COMMENT_BYTES) {
    return undefined
  }
  const notes: Record<string, NoteComment[]> = Object.create(null)
  for (const [uuid, comments] of entries) {
    if (!uuid || uuid.length > 128 || !Array.isArray(comments) || comments.length > MAX_NOTE_COMMENTS) {
      return undefined
    }
    const normalized = comments.map(normalizeComment)
    if (normalized.some((comment) => !comment || comment.authorUuid !== ownerUuid)) {
      return undefined
    }
    notes[uuid] = normalized as NoteComment[]
  }
  return { version: 1, ownerUuid, notes }
}

function personalPreferences(application: WebApplication): SNUserPrefs | undefined {
  const candidates = application.items.getItems<SNUserPrefs>(ContentType.TYPES.UserPrefs)
  return candidates.find(
    (item): item is SNUserPrefs =>
      item instanceof SNUserPrefs && !item.shared_vault_uuid && !item.key_system_identifier,
  )
}

type Catalog = {
  items: DecryptedItemInterface[]
  legacy: PrivateComments
  records: PrivateCommentOperation[]
  projection: PrivateCommentProjection
  bytes: number
  deletionBytes: number
  ordinaryCount: number
  deletionCount: number
}
const catalogCache = new WeakMap<
  WebApplication,
  { owner: string; raw: unknown; items: DecryptedItemInterface[]; catalog: Catalog }
>()
const parsedCache = new WeakMap<
  object,
  { owner: string; content: unknown; record?: PrivateCommentOperation; bytes: number }
>()

function readCatalog(application: WebApplication, owner: string): Catalog {
  if (
    (application.items.invalidItems ?? []).some(
      (item) =>
        item.content_type === PRIVATE_COMMENT_CONTENT_TYPE && !item.shared_vault_uuid && !item.key_system_identifier,
    )
  ) {
    throw new Error(
      'Private comments are still encrypted or unavailable. Wait for account decryption before editing them.',
    )
  }
  const raw = personalPreferences(application)?.getPref(PRIVATE_NOTE_COMMENTS_KEY)
  const items = application.items
    .getItems<DecryptedItemInterface>(PRIVATE_COMMENT_CONTENT_TYPE)
    .filter(
      (item) =>
        item.content_type === PRIVATE_COMMENT_CONTENT_TYPE && !item.shared_vault_uuid && !item.key_system_identifier,
    )
  // Recheck protection even for unchanged immutable objects.
  if (items.some((item) => !application.isAuthorizedToRenderItem(item))) {
    throw new Error('Private comments are locked.')
  }
  const cached = catalogCache.get(application)
  if (
    cached?.owner === owner &&
    cached.raw === raw &&
    cached.items.length === items.length &&
    items.every((item, i) => item === cached.items[i])
  ) {
    return cached.catalog
  }
  const legacy =
    raw === undefined ? { version: 1 as const, ownerUuid: owner, notes: {} } : normalizePrivateComments(raw, owner)
  if (!legacy) {
    throw new Error(
      'Private comments could not be read safely. Export your account data before repairing this preference.',
    )
  }
  if (items.length > MAX_PRIVATE_OPERATION_RECORDS + MAX_PRIVATE_TOMBSTONE_RECORDS) {
    throw new Error('Private comment storage exceeds its safe record limit. Export your account data before repair.')
  }
  const records: PrivateCommentOperation[] = []
  let bytes = 0,
    deletionBytes = 0,
    ordinaryCount = 0,
    deletionCount = 0
  for (const item of items) {
    let parsed = parsedCache.get(item)
    if (!parsed || parsed.owner !== owner || parsed.content !== item.content) {
      const record = normalizePrivateCommentOperation(item.content, owner)
      parsed = { owner, content: item.content, record, bytes: record ? utf8ByteLength(JSON.stringify(record)) : 0 }
      parsedCache.set(item, parsed)
    }
    if (!parsed.record) {
      throw new Error('Private comment history could not be read safely. Export your account data before repair.')
    }
    records.push(parsed.record)
    if (parsed.record.changes.every((change) => change.deleted)) {
      deletionCount += 1
      deletionBytes += parsed.bytes
    } else {
      ordinaryCount += 1
      bytes += parsed.bytes
    }
  }
  const projection = projectPrivateComments(legacy.notes, records)
  const catalog = { items, legacy, records, projection, bytes, deletionBytes, ordinaryCount, deletionCount }
  catalogCache.set(application, { owner, raw, items, catalog })
  return catalog
}

/** Publish an equivalent frontier before removing captured immutable source records. */
async function compactPrivateComments(application: WebApplication, owner: string, valid: () => boolean): Promise<void> {
  const catalog = readCatalog(application, owner)
  if (catalog.items.length < 2) {
    return
  }
  const chunks: PrivateCommentChange[][] = []
  const frontier = catalog.projection.frontier.map((change): PrivateCommentChange => {
    if (
      change.comment?.parentId &&
      catalog.projection.deleted.has(privateCommentKey(change.noteUuid, change.comment.parentId))
    ) {
      return {
        noteUuid: change.noteUuid,
        id: change.id,
        clock: Math.max(1, change.clock),
        eventId: change.eventId || generateCommentId(),
        deleted: true,
      }
    }
    return change
  })
  for (const deletionOnly of [false, true]) {
    let chunk: PrivateCommentChange[] = [],
      bytes = 0
    for (const change of frontier) {
      if (!!change.deleted !== deletionOnly) {
        continue
      }
      const size = utf8ByteLength(JSON.stringify(change))
      if (bytes + size > 256 * 1024 && chunk.length) {
        chunks.push(chunk)
        chunk = []
        bytes = 0
      }
      chunk.push(change)
      bytes += size
    }
    if (chunk.length) {
      chunks.push(chunk)
    }
  }
  // No cleanup unless there is a durable replacement, including deletion fences.
  if (!chunks.length || chunks.length > catalog.items.length) {
    return
  }
  const snapshots: DecryptedItemInterface[] = []
  for (const changes of chunks) {
    if (!valid()) {
      return
    }
    const operation = normalizePrivateCommentOperation(
      { version: 2, ownerUuid: owner, operationId: generateCommentId(), changes },
      owner,
    )
    if (!operation) {
      return
    }
    snapshots.push(
      await application.mutator.createItem(
        PRIVATE_COMMENT_CONTENT_TYPE,
        { ...operation, references: [] } as ItemContent,
        true,
      ),
    )
  }
  await application.sync.sync({ sourceDescription: 'Private comment compaction checkpoint' })
  if (
    !valid() ||
    snapshots.some((snapshot) => {
      const current = application.items.findItem(snapshot.uuid)
      return (
        !current ||
        current.dirty !== false ||
        current.shared_vault_uuid ||
        current.key_system_identifier ||
        !application.isAuthorizedToRenderItem(current) ||
        current.content_type !== PRIVATE_COMMENT_CONTENT_TYPE ||
        JSON.stringify(current.content) !== JSON.stringify(snapshot.content)
      )
    })
  ) {
    return
  }
  for (const source of catalog.items) {
    if (!valid()) {
      return
    }
    const current = application.items.findItem(source.uuid)
    if (
      current &&
      !current.shared_vault_uuid &&
      !current.key_system_identifier &&
      application.isAuthorizedToRenderItem(current) &&
      current.content_type === PRIVATE_COMMENT_CONTENT_TYPE &&
      JSON.stringify(current.content) === JSON.stringify(source.content)
    ) {
      await application.mutator.deleteItem(current)
    }
  }
  if (valid()) {
    await application.sync.sync({ sourceDescription: 'Private comment compacted history cleanup' })
  }
}

const readErrors = new WeakMap<WebApplication, string>()
export const privateCommentsReadError = (application: WebApplication): string | undefined => readErrors.get(application)

export function readPrivateNoteComments(application: WebApplication, noteUuid: string): NoteComment[] {
  const owner = application.sessions.getUser()?.uuid
  const note = application.items.findItem<SNNote>(noteUuid)
  readErrors.delete(application)
  if (!owner || !note || !application.isAuthorizedToRenderItem(note)) {
    return []
  }
  try {
    return readCatalog(application, owner).projection.notes.get(noteUuid) ?? []
  } catch {
    readErrors.set(
      application,
      'Private comment history could not be read safely. Keep this tab open and wait for decryption or restore access before editing comments.',
    )
    return []
  }
}

/** Personal encrypted operation items are never attached to a vault or a note's shared payload. */
export async function mutatePrivateNoteComments(
  application: WebApplication,
  noteUuid: string,
  update: (comments: NoteComment[]) => NoteComment[],
): Promise<void> {
  const user = application.sessions.getUser()
  const valid = (): boolean => {
    const note = application.items.findItem<SNNote>(noteUuid)
    return Boolean(
      user &&
      application.sessions.getUser() === user &&
      note &&
      !note.trashed &&
      !application.sessions.isCurrentSessionReadOnly() &&
      application.isAuthorizedToRenderItem(note),
    )
  }
  const work = (queues.get(application) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (!valid() || !application.sync.isDatabaseLoaded()) {
        throw new Error('Private comments are unavailable until your account data is loaded and unlocked.')
      }
      let catalog = readCatalog(application, user!.uuid)
      if (catalog.ordinaryCount >= 128) {
        await compactPrivateComments(application, user!.uuid, valid).catch(() => undefined)
        if (!valid()) {
          throw new Error('The account changed before this private comment could be saved.')
        }
        catalog = readCatalog(application, user!.uuid)
      }
      const previous = catalog.projection.notes.get(noteUuid) ?? []
      const next = update(previous.map((comment) => ({ ...comment })))
      if (!valid()) {
        throw new Error('The account changed before this private comment could be saved.')
      }
      if (
        !validPrivateCommentList(next, user!.uuid) ||
        (!catalog.projection.notes.has(noteUuid) &&
          catalog.projection.notes.size >= MAX_PRIVATE_COMMENT_NOTES &&
          next.length)
      ) {
        throw new Error(
          'Private comment storage is full. Delete older private comments or export them before adding more.',
        )
      }
      const changes = new Map<string, PrivateCommentChange>()
      // Copy every still-unrepresented legacy comment before leaving the singleton behind.
      // Imports use clock zero, so even a very old device cannot overwrite a native edit.
      for (const [legacyNote, comments] of Object.entries(catalog.legacy.notes)) {
        for (const comment of comments) {
          const key = privateCommentKey(legacyNote, comment.id)
          if (!catalog.projection.represented.has(key)) {
            changes.set(key, { noteUuid: legacyNote, id: comment.id, clock: 0, comment })
          }
        }
      }
      const before = new Map(previous.map((comment) => [comment.id, comment]))
      const after = new Map(next.map((comment) => [comment.id, comment]))
      const clock = catalog.projection.clock + 1
      for (const comment of next) {
        const key = privateCommentKey(noteUuid, comment.id)
        if (catalog.projection.deleted.has(key)) {
          throw new Error('This private comment was deleted. Add a new comment instead of restoring an old copy.')
        }
        if (JSON.stringify(before.get(comment.id)) !== JSON.stringify(comment)) {
          changes.set(key, { noteUuid, id: comment.id, clock, comment })
        }
      }
      for (const comment of previous) {
        if (!after.has(comment.id)) {
          changes.set(privateCommentKey(noteUuid, comment.id), { noteUuid, id: comment.id, clock, deleted: true })
        }
      }
      if (changes.size) {
        const operation = normalizePrivateCommentOperation(
          { version: 2, ownerUuid: user!.uuid, operationId: generateCommentId(), changes: [...changes.values()] },
          user!.uuid,
        )
        if (!operation) {
          throw new Error(
            'Private comment storage is full or this change is invalid. Export older comments before adding more.',
          )
        }
        const deletionOnly = operation.changes.every((change) => change.deleted)
        const newBytes = utf8ByteLength(JSON.stringify(operation))
        // Never discard deletion fences to make space. Deletions have a separate reserved budget.
        if (
          (deletionOnly
            ? catalog.deletionCount >= MAX_PRIVATE_TOMBSTONE_RECORDS
            : catalog.ordinaryCount >= MAX_PRIVATE_OPERATION_RECORDS) ||
          (deletionOnly ? catalog.deletionBytes : catalog.bytes) + newBytes > MAX_PRIVATE_OPERATION_CATALOG_BYTES
        ) {
          throw new Error(
            'Private comment storage is full. Export your account data before repair; deletion history cannot safely be discarded.',
          )
        }
        if (!valid()) {
          throw new Error('The account changed before this private comment could be saved.')
        }
        await application.mutator.createItem(
          PRIVATE_COMMENT_CONTENT_TYPE,
          { ...operation, references: [] } as ItemContent,
          true,
        )
      }
      if (!valid()) {
        throw new Error('The account changed before this private comment could be saved.')
      }
      // Surface failures; the immutable local operation remains available for retry.
      await application.sync.sync({ sourceDescription: 'Private note comment operations' })
      if (valid() && [...changes.values()].some((change) => change.deleted)) {
        await compactPrivateComments(application, user!.uuid, valid).catch(() => undefined)
      }
    })
  queues.set(application, work)
  try {
    await work
  } finally {
    if (queues.get(application) === work) {
      queues.delete(application)
    }
  }
}
