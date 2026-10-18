import {
  NoteComment,
  normalizeComment,
  MAX_NOTE_COMMENTS,
  MAX_COMMENT_REPLIES_PER_THREAD,
  utf8ByteLength,
} from './comments'

export const PRIVATE_COMMENT_CONTENT_TYPE = 'SN|PrivateComment'
export const MAX_PRIVATE_OPERATION_BYTES = 512 * 1024
export const MAX_PRIVATE_OPERATION_RECORDS = 8_192
export const MAX_PRIVATE_OPERATION_CATALOG_BYTES = 32 * 1024 * 1024
// Content-free deletions remain admissible after the ordinary operation budget fills.
export const MAX_PRIVATE_TOMBSTONE_RECORDS = 65_536
export type PrivateCommentChange = {
  noteUuid: string
  id: string
  clock: number
  eventId?: string
  comment?: NoteComment
  deleted?: true
}
export type PrivateCommentOperation = {
  version: 2
  ownerUuid: string
  operationId: string
  changes: PrivateCommentChange[]
}
export type PrivateCommentProjection = {
  notes: Map<string, NoteComment[]>
  represented: Set<string>
  deleted: Set<string>
  clock: number
  frontier: PrivateCommentChange[]
}
export const privateCommentKey = (noteUuid: string, id: string): string => JSON.stringify([noteUuid, id])
const boundedId = (value: unknown, length = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= length

export function normalizePrivateCommentOperation(
  value: unknown,
  ownerUuid: string,
): PrivateCommentOperation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as PrivateCommentOperation
  if (
    raw.version !== 2 ||
    raw.ownerUuid !== ownerUuid ||
    !boundedId(raw.operationId) ||
    !Array.isArray(raw.changes) ||
    !raw.changes.length ||
    raw.changes.length > 65_536
  ) {
    return undefined
  }
  try {
    if (utf8ByteLength(JSON.stringify(value)) > MAX_PRIVATE_OPERATION_BYTES) {
      return undefined
    }
  } catch {
    return undefined
  }
  const seen = new Set<string>()
  const changes: PrivateCommentChange[] = []
  for (const entry of raw.changes) {
    if (
      !entry ||
      !boundedId(entry.noteUuid) ||
      !boundedId(entry.id, 257) ||
      !Number.isSafeInteger(entry.clock) ||
      entry.clock < 0 ||
      entry.clock >= Number.MAX_SAFE_INTEGER
    ) {
      return undefined
    }
    if (entry.eventId !== undefined && !(entry.eventId === '' && entry.clock === 0) && !boundedId(entry.eventId)) {
      return undefined
    }
    const eventId = entry.eventId ?? raw.operationId
    const key = privateCommentKey(entry.noteUuid, entry.id)
    if (seen.has(key)) {
      return undefined
    }
    seen.add(key)
    if (entry.deleted === true && entry.comment === undefined && entry.clock > 0) {
      changes.push({ noteUuid: entry.noteUuid, id: entry.id, clock: entry.clock, eventId, deleted: true })
    } else {
      const comment = normalizeComment(entry.comment)
      if (entry.deleted !== undefined || !comment || comment.id !== entry.id || comment.authorUuid !== ownerUuid) {
        return undefined
      }
      changes.push({ noteUuid: entry.noteUuid, id: entry.id, clock: entry.clock, eventId, comment })
    }
  }
  return { version: 2, ownerUuid, operationId: raw.operationId, changes }
}

/** Immutable records commute. Deletion wins permanently over offline edits; purge deletes only observed IDs. */
export function projectPrivateComments(
  legacy: Record<string, NoteComment[]>,
  records: readonly PrivateCommentOperation[],
): PrivateCommentProjection {
  const values = new Map<string, PrivateCommentChange>()
  const represented = new Set<string>()
  const deleted = new Set<string>()
  let clock = 0
  const consider = (change: PrivateCommentChange, operationId: string) => {
    const key = privateCommentKey(change.noteUuid, change.id)
    clock = Math.max(clock, change.clock)
    const eventId = change.eventId ?? operationId
    const previous = values.get(key)
    if (change.deleted) {
      deleted.add(key)
    }
    const wins =
      !previous ||
      (change.deleted && !previous.deleted) ||
      (!!change.deleted === !!previous.deleted &&
        (change.clock > previous.clock ||
          (change.clock === previous.clock &&
            (eventId > (previous.eventId ?? '') ||
              (eventId === (previous.eventId ?? '') &&
                JSON.stringify(change.comment) > JSON.stringify(previous.comment))))))
    if (wins) {
      values.set(key, { ...change, eventId })
    }
  }
  for (const [noteUuid, comments] of Object.entries(legacy)) {
    for (const comment of comments) {
      consider({ noteUuid, id: comment.id, clock: 0, comment }, '')
    }
  }
  for (const record of records) {
    for (const change of record.changes) {
      represented.add(privateCommentKey(change.noteUuid, change.id))
      consider(change, record.operationId)
    }
  }
  const notes = new Map<string, NoteComment[]>()
  for (const [key, change] of values) {
    if (deleted.has(key)) {
      continue
    }
    const comment = change.comment!
    // A concurrent reply cannot bring a deleted thread back to life.
    if (comment.parentId && deleted.has(privateCommentKey(change.noteUuid, comment.parentId))) {
      continue
    }
    const comments = notes.get(change.noteUuid) ?? []
    comments.push(comment)
    notes.set(change.noteUuid, comments)
  }
  for (const comments of notes.values()) {
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  return { notes, represented, deleted, clock, frontier: [...values.values()] }
}

export function validPrivateCommentList(comments: NoteComment[], ownerUuid: string): boolean {
  if (comments.length > MAX_NOTE_COMMENTS) {
    return false
  }
  const ids = new Set<string>()
  const replyCounts = new Map<string, number>()
  for (const value of comments) {
    const comment = normalizeComment(value)
    if (!comment || comment.authorUuid !== ownerUuid || ids.has(comment.id)) {
      return false
    }
    ids.add(comment.id)
    if (comment.parentId) {
      const count = (replyCounts.get(comment.parentId) ?? 0) + 1
      if (count > MAX_COMMENT_REPLIES_PER_THREAD) {
        return false
      }
      replyCounts.set(comment.parentId, count)
    }
  }
  return true
}

/** Removed/undecryptable items have no readable scope and must invalidate the view conservatively. */
export function privateCommentItemTouchesNote(item: { content?: unknown }, noteUuid: string): boolean {
  const changes = (item.content as { changes?: unknown } | undefined)?.changes
  return !Array.isArray(changes) || changes.some((change) => change?.noteUuid === noteUuid)
}
