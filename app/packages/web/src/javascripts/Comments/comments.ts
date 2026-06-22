import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: per-note inline comments + @mentions.
 *
 * ## Where comments are stored (and why)
 * A note's comments live in the note's encrypted `appData` bag under a single
 * `comments` key (an array) — the EXACT mechanism the fork already uses for
 * `bookmarks`, `reminders`, `heroHeader` and the per-note appearance colors. We
 * persist via `mutator.setAppDataItem` and read via `getAppDomainValue`.
 *
 * Preferred over a dedicated comment item type because:
 *  - It is already END-TO-END ENCRYPTED: appData rides inside the note's
 *    encrypted content, so the server (and the realtime relay) never see comment
 *    text. A separate item type would also be E2E, but would need its own
 *    linking/lifecycle plumbing and more surface area for a first version.
 *  - It syncs with the note over the normal HTTP sync (offline-safe) and is tied
 *    to the note's lifecycle (delete the note, the thread goes too).
 *  - ZERO models/server changes: `comments` is not in the published
 *    `AppDataField` enum (which lives in the models package we must not touch),
 *    so we cast our string key to `AppDataField` at the storage boundary, exactly
 *    like the bookmark/reminder/hero helpers do.
 *
 * Trade-off: because every comment lives in the note payload, a very large thread
 * grows the note. For a first version that is acceptable; a follow-up could move
 * to a dedicated `Comment` content type once volume warrants it (the read/write
 * API here is intentionally narrow so that swap stays localized).
 *
 * ## Anchoring (first version vs follow-up)
 * Each comment may carry an optional `anchor` describing WHERE in the note it
 * points. For a first version we model two anchor kinds but only fully wire the
 * note-level (no anchor) and a `super` block-id anchor that the CommentsPlugin
 * captures from the current Lexical selection's top-level block key. Plaintext
 * range anchoring is modeled for forward-compat but is best-effort. See
 * CommentsPlugin for how inline anchoring would extend (decorate the anchored
 * block, scroll-to on click).
 */

export const NoteCommentsKey = 'comments' as unknown as AppDataField

/** Anchor pointing at a top-level block inside a Super (Lexical) note. */
export type SuperCommentAnchor = {
  kind: 'super'
  /** Lexical node key of the anchored top-level block at capture time. */
  blockKey: string
  /** Short snippet of the block's text, shown as context + used to relocate. */
  snippet?: string
}

/** Anchor pointing at a character range inside a plaintext note (best-effort). */
export type PlainCommentAnchor = {
  kind: 'plain'
  /** Start character offset into the note text at capture time (drifts on edit). */
  start: number
  /** End character offset into the note text at capture time. */
  end: number
  /** Short surrounding text used to re-locate the spot if offsets drifted. */
  snippet?: string
}

export type CommentAnchor = SuperCommentAnchor | PlainCommentAnchor

/** A single comment in a note's thread. */
export type NoteComment = {
  /** Stable id (also used as the realtime de-dupe / parent key). */
  id: string
  /** Account uuid of the author. */
  authorUuid: string
  /** Display name/email captured at write time (best-effort; may be stale). */
  authorName: string
  /** Comment body. May contain @mention tokens (see mentions.ts). */
  text: string
  /** ISO 8601 creation time. */
  createdAt: string
  /** Optional anchor for an inline comment; absent = note-level comment. */
  anchor?: CommentAnchor
  /** Optional parent comment id for threaded replies. */
  parentId?: string
  /** Whether the comment/thread has been resolved. */
  resolved?: boolean
  /** Account uuids @mentioned in `text` (denormalized for fast notify checks). */
  mentions?: string[]
}

/* -------------------------------------------------------------------------- */
/* Validation / normalization (never throw on missing/legacy/malformed data)  */
/* -------------------------------------------------------------------------- */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeAnchor(value: unknown): CommentAnchor | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'super' && isNonEmptyString(candidate.blockKey)) {
    const anchor: SuperCommentAnchor = { kind: 'super', blockKey: candidate.blockKey }
    if (isNonEmptyString(candidate.snippet)) {
      anchor.snippet = candidate.snippet
    }
    return anchor
  }
  if (candidate.kind === 'plain') {
    const start = Number(candidate.start)
    const end = Number(candidate.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return undefined
    }
    const anchor: PlainCommentAnchor = { kind: 'plain', start: Math.floor(start), end: Math.floor(end) }
    if (isNonEmptyString(candidate.snippet)) {
      anchor.snippet = candidate.snippet
    }
    return anchor
  }
  return undefined
}

/** Coerce a stored/received comment into a valid one, or null. Never throws. */
export function normalizeComment(value: unknown): NoteComment | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.authorUuid)) {
    return null
  }
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  const comment: NoteComment = {
    id: candidate.id,
    authorUuid: candidate.authorUuid,
    authorName: isNonEmptyString(candidate.authorName) ? candidate.authorName : candidate.authorUuid,
    text,
    createdAt:
      typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
        ? candidate.createdAt
        : new Date(0).toISOString(),
  }
  const anchor = normalizeAnchor(candidate.anchor)
  if (anchor) {
    comment.anchor = anchor
  }
  if (isNonEmptyString(candidate.parentId)) {
    comment.parentId = candidate.parentId
  }
  if (candidate.resolved === true) {
    comment.resolved = true
  }
  if (Array.isArray(candidate.mentions)) {
    const mentions = candidate.mentions.filter(isNonEmptyString)
    if (mentions.length > 0) {
      comment.mentions = mentions
    }
  }
  return comment
}

/**
 * Read the comments stored on a note. Always returns a fresh array; tolerates a
 * missing/legacy value (undefined) and filters out malformed entries. Never throws.
 */
export function getNoteComments(note: SNNote): NoteComment[] {
  const raw = note.getAppDomainValue<unknown>(NoteCommentsKey)
  if (!Array.isArray(raw)) {
    return []
  }
  const result: NoteComment[] = []
  for (const entry of raw) {
    const normalized = normalizeComment(entry)
    if (normalized) {
      result.push(normalized)
    }
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Pure list operations                                                       */
/* -------------------------------------------------------------------------- */

/** Pure: add `comment` (new id) or replace the one with the same id. */
export function upsertComment(comments: NoteComment[], comment: NoteComment): NoteComment[] {
  const next = comments.filter((existing) => existing.id !== comment.id)
  next.push({ ...comment })
  return sortCommentsByCreatedAt(next)
}

/** Pure: remove a comment by id AND any replies whose parentId is that id. */
export function removeComment(comments: NoteComment[], id: string): NoteComment[] {
  return comments.filter((comment) => comment.id !== id && comment.parentId !== id)
}

/** Pure: set/clear the `resolved` flag on a comment by id. */
export function setCommentResolved(comments: NoteComment[], id: string, resolved: boolean): NoteComment[] {
  return comments.map((comment) => {
    if (comment.id !== id) {
      return comment
    }
    const next: NoteComment = { ...comment }
    if (resolved) {
      next.resolved = true
    } else {
      delete next.resolved
    }
    return next
  })
}

export function sortCommentsByCreatedAt(comments: NoteComment[]): NoteComment[] {
  return [...comments].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    const av = Number.isNaN(at) ? 0 : at
    const bv = Number.isNaN(bt) ? 0 : bt
    return av - bv
  })
}

/**
 * Group a flat comment list into top-level comments (no parentId) each paired
 * with its direct replies, both ordered oldest-first. Orphaned replies (whose
 * parent was deleted) are surfaced as top-level so they are never lost.
 */
export function buildCommentThreads(
  comments: NoteComment[],
): Array<{ comment: NoteComment; replies: NoteComment[] }> {
  const sorted = sortCommentsByCreatedAt(comments)
  const byId = new Set(sorted.map((c) => c.id))
  const repliesByParent = new Map<string, NoteComment[]>()
  const roots: NoteComment[] = []
  for (const comment of sorted) {
    if (comment.parentId && byId.has(comment.parentId)) {
      const list = repliesByParent.get(comment.parentId) ?? []
      list.push(comment)
      repliesByParent.set(comment.parentId, list)
    } else {
      roots.push(comment)
    }
  }
  return roots.map((comment) => ({ comment, replies: repliesByParent.get(comment.id) ?? [] }))
}

let idCounter = 0

/** Generate a reasonably-unique comment id (crypto.randomUUID when available). */
export function generateCommentId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  idCounter += 1
  return `comment-${Date.now().toString(36)}-${idCounter.toString(36)}`
}
