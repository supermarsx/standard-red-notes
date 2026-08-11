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
export const NoteCommentMutationsKey = 'commentMutations' as unknown as AppDataField
export const NoteCommentActorClocksKey = 'commentActorClocks' as unknown as AppDataField
export const MAX_COMMENT_MUTATION_ID_LENGTH = 128
export const MAX_COMMENT_ID_LENGTH = MAX_COMMENT_MUTATION_ID_LENGTH * 2 + 1
export const MAX_COMMENT_AUTHOR_NAME_LENGTH = 256
export const MAX_COMMENT_TEXT_LENGTH = 8 * 1024
export const MAX_COMMENT_CREATED_AT_LENGTH = 64
export const MAX_COMMENT_ANCHOR_BLOCK_KEY_LENGTH = 128
export const MAX_COMMENT_ANCHOR_SNIPPET_LENGTH = 512
export const MAX_COMMENT_MENTIONS = 64
export const MAX_NOTE_COMMENTS = 256
export const MAX_COMMENT_REPLIES_PER_THREAD = 64
export const MAX_NOTE_COMMENTS_JSON_BYTES = 512 * 1024
export const MAX_COMMENT_MUTATION_RECORDS = 2_048
export const COMMENT_AUTHORSHIP_VERSION = 1 as const
export const COMMENT_MUTATION_AUTHORSHIP_VERSION = 1 as const
export const MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH = 256
export const MAX_COMMENT_SIGNATURE_LENGTH = 256
export const MAX_COMMENT_ACTOR_CLOCKS = 256
export const MAX_COMMENT_MUTATIONS_JSON_BYTES = 2 * 1024 * 1024
export const MAX_COMMENT_ACTOR_CLOCKS_JSON_BYTES = 512 * 1024
/**
 * Large enough for a genuinely busy thread deletion while keeping a valid-key
 * peer from turning one authenticated relay frame into unbounded appData/O(n)
 * work. Oversized mutations are rejected as a unit, never truncated.
 */
export const MAX_COMMENT_MUTATION_AFFECTED_IDS = 256

export type CommentMutationStamp = {
  /** Per-authenticated-actor counter; deterministic tie-breakers handle concurrent devices. */
  counter: number
  /** Authenticated by the mutation attestation before it is trusted. */
  actorUuid: string
  eventId: string
}

export type CommentAuthorshipAttestation = {
  version: typeof COMMENT_AUTHORSHIP_VERSION
  signingPublicKey: string
  signature: string
}

export type CommentMutationAuthorshipAttestation = {
  version: typeof COMMENT_MUTATION_AUTHORSHIP_VERSION
  signingPublicKey: string
  /** Signature over the complete note-bound mutation envelope. */
  signature: string
  /** Compact signature over the note-bound actor clock stamp. */
  clockSignature: string
}

export type CommentMutationClockProof = {
  version: typeof COMMENT_MUTATION_AUTHORSHIP_VERSION
  stamp: CommentMutationStamp
  signingPublicKey: string
  signature: string
}

export type NoteCommentActorClock = {
  actorUuid: string
  highWater: CommentMutationClockProof
  /** Highest signed event compacted out of the per-target ledger for this actor. */
  replayFloor?: CommentMutationClockProof
}

export type NoteCommentMutationRecord = {
  commentId: string
  operation: 'upsert' | 'remove' | 'resolve'
  stamp: CommentMutationStamp
  /** A parent removal also tombstones the replies it removed. */
  affectedCommentIds: string[]
  /** Present only for an authenticated resolve mutation. */
  resolved?: boolean
  /** Missing only on pre-v3 local ledgers; never trusted for ordering. */
  authorship?: CommentMutationAuthorshipAttestation
}

export type AuthenticatedNoteCommentMutationRecord = NoteCommentMutationRecord & {
  authorship: CommentMutationAuthorshipAttestation
}
export type UnsignedNoteCommentMutationRecord = Omit<NoteCommentMutationRecord, 'authorship'>

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
  /**
   * Untrusted display snapshot retained for legacy compatibility. Renderers use
   * the locally trusted contact name after verifying `authorship` instead.
   */
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
  /** Detached Ed25519 proof over this comment's immutable fields + note UUID. */
  authorship?: CommentAuthorshipAttestation
}

/* -------------------------------------------------------------------------- */
/* Validation / normalization (never throw on missing/legacy/malformed data)  */
/* -------------------------------------------------------------------------- */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maximumLength
}

function isBoundedMutationId(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_COMMENT_MUTATION_ID_LENGTH)
}

function isBoundedCommentId(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_COMMENT_ID_LENGTH)
}

export function isAuthorNamespacedCommentId(commentId: string, authorUuid: string): boolean {
  const prefix = `${authorUuid}:`
  const suffix = commentId.startsWith(prefix) ? commentId.slice(prefix.length) : ''
  return isBoundedMutationId(authorUuid) && isBoundedMutationId(suffix) && commentId.length <= MAX_COMMENT_ID_LENGTH
}

function normalizeCommentAuthorship(value: unknown): CommentAuthorshipAttestation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== COMMENT_AUTHORSHIP_VERSION ||
    !isBoundedNonEmptyString(candidate.signingPublicKey, MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH) ||
    !isBoundedNonEmptyString(candidate.signature, MAX_COMMENT_SIGNATURE_LENGTH)
  ) {
    return undefined
  }
  return {
    version: COMMENT_AUTHORSHIP_VERSION,
    signingPublicKey: candidate.signingPublicKey,
    signature: candidate.signature,
  }
}

function normalizeCommentMutationAuthorship(value: unknown): CommentMutationAuthorshipAttestation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== COMMENT_MUTATION_AUTHORSHIP_VERSION ||
    !isBoundedNonEmptyString(candidate.signingPublicKey, MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH) ||
    !isBoundedNonEmptyString(candidate.signature, MAX_COMMENT_SIGNATURE_LENGTH) ||
    !isBoundedNonEmptyString(candidate.clockSignature, MAX_COMMENT_SIGNATURE_LENGTH)
  ) {
    return undefined
  }
  return {
    version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
    signingPublicKey: candidate.signingPublicKey,
    signature: candidate.signature,
    clockSignature: candidate.clockSignature,
  }
}

export function normalizeCommentMutationClockProof(value: unknown): CommentMutationClockProof | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const stamp = normalizeCommentMutationStamp(candidate.stamp)
  if (
    candidate.version !== COMMENT_MUTATION_AUTHORSHIP_VERSION ||
    !stamp ||
    !isBoundedNonEmptyString(candidate.signingPublicKey, MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH) ||
    !isBoundedNonEmptyString(candidate.signature, MAX_COMMENT_SIGNATURE_LENGTH)
  ) {
    return undefined
  }
  return {
    version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
    stamp,
    signingPublicKey: candidate.signingPublicKey,
    signature: candidate.signature,
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** Runtime-independent ECMAScript UTF-16 code-unit ordering for replicas. */
export function compareUtf16Strings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function normalizeAnchor(value: unknown): CommentAnchor | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'super' && isBoundedNonEmptyString(candidate.blockKey, MAX_COMMENT_ANCHOR_BLOCK_KEY_LENGTH)) {
    const anchor: SuperCommentAnchor = { kind: 'super', blockKey: candidate.blockKey }
    if (isBoundedNonEmptyString(candidate.snippet, MAX_COMMENT_ANCHOR_SNIPPET_LENGTH)) {
      anchor.snippet = candidate.snippet
    } else if (candidate.snippet !== undefined) {
      return undefined
    }
    return anchor
  }
  if (candidate.kind === 'plain') {
    const start = Number(candidate.start)
    const end = Number(candidate.end)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return undefined
    }
    const anchor: PlainCommentAnchor = { kind: 'plain', start, end }
    if (isBoundedNonEmptyString(candidate.snippet, MAX_COMMENT_ANCHOR_SNIPPET_LENGTH)) {
      anchor.snippet = candidate.snippet
    } else if (candidate.snippet !== undefined) {
      return undefined
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
  if (!isBoundedCommentId(candidate.id) || !isBoundedMutationId(candidate.authorUuid)) {
    return null
  }
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  if (text.length > MAX_COMMENT_TEXT_LENGTH) {
    return null
  }
  if (
    candidate.authorName !== undefined &&
    !isBoundedNonEmptyString(candidate.authorName, MAX_COMMENT_AUTHOR_NAME_LENGTH)
  ) {
    return null
  }
  if (typeof candidate.createdAt === 'string' && candidate.createdAt.length > MAX_COMMENT_CREATED_AT_LENGTH) {
    return null
  }
  const parsedCreatedAt = typeof candidate.createdAt === 'string' ? Date.parse(candidate.createdAt) : Number.NaN
  const canonicalCreatedAt = Number.isNaN(parsedCreatedAt) ? undefined : new Date(parsedCreatedAt).toISOString()
  const comment: NoteComment = {
    id: candidate.id,
    authorUuid: candidate.authorUuid,
    authorName: isNonEmptyString(candidate.authorName) ? candidate.authorName : candidate.authorUuid,
    text,
    // Only accept the exact, UTC ISO representation emitted by toISOString.
    // Date.parse accepts implementation-dependent legacy/ambiguous formats;
    // comparing the normalized value to the input makes those converge to the
    // deterministic epoch fallback in every runtime.
    createdAt:
      canonicalCreatedAt !== undefined && canonicalCreatedAt === candidate.createdAt
        ? canonicalCreatedAt
        : new Date(0).toISOString(),
  }
  const anchor = normalizeAnchor(candidate.anchor)
  if (candidate.anchor !== undefined && !anchor) {
    return null
  }
  if (anchor) {
    comment.anchor = anchor
  }
  if (isBoundedMutationId(candidate.parentId)) {
    comment.parentId = candidate.parentId
  } else if (candidate.parentId !== undefined) {
    return null
  }
  if (candidate.resolved === true) {
    comment.resolved = true
  }
  if (Array.isArray(candidate.mentions)) {
    if (
      candidate.mentions.length > MAX_COMMENT_MENTIONS ||
      candidate.mentions.some((mention) => !isBoundedMutationId(mention))
    ) {
      return null
    }
    const mentions = [...new Set(candidate.mentions as string[])].sort(compareUtf16Strings)
    if (mentions.length > 0) {
      comment.mentions = mentions
    }
  }
  if (candidate.authorship !== undefined) {
    const authorship = normalizeCommentAuthorship(candidate.authorship)
    if (!authorship || !isAuthorNamespacedCommentId(comment.id, comment.authorUuid)) {
      return null
    }
    comment.authorship = authorship
  }
  return comment
}

/**
 * Read the comments stored on a note. Always returns a fresh array; tolerates a
 * missing/legacy value (undefined) and filters out malformed entries. Never throws.
 */
export function getBoundedNoteComments(note: SNNote): NoteComment[] | undefined {
  const raw = note.getAppDomainValue<unknown>(NoteCommentsKey)
  if (raw === undefined) {
    return []
  }
  // Reserve one independent bounded tranche for cryptographically
  // unverifiable comments. Contact/key-chain data can be temporarily absent;
  // that quarantine must neither be destroyed nor consume the trusted writer's
  // normal thread budget.
  if (!Array.isArray(raw) || raw.length > MAX_NOTE_COMMENTS * 2) {
    return undefined
  }
  const result: NoteComment[] = []
  for (const entry of raw) {
    const normalized = normalizeComment(entry)
    if (normalized) {
      result.push(normalized)
    }
  }
  const repliesByParent = new Map<string, number>()
  let encodedBytes = 2
  for (const comment of result) {
    encodedBytes += utf8ByteLength(JSON.stringify(comment)) + 1
    if (encodedBytes > MAX_NOTE_COMMENTS_JSON_BYTES * 2) {
      return undefined
    }
    if (comment.parentId) {
      const replies = (repliesByParent.get(comment.parentId) ?? 0) + 1
      if (replies > MAX_COMMENT_REPLIES_PER_THREAD * 2) {
        return undefined
      }
      repliesByParent.set(comment.parentId, replies)
    }
  }
  return sortCommentsByCreatedAt(result)
}

export function commentCollectionFitsBudgets(comments: NoteComment[]): boolean {
  const note = {
    getAppDomainValue: () => comments,
  } as unknown as SNNote
  const normalized = getBoundedNoteComments(note)
  if (normalized === undefined || normalized.length !== comments.length || normalized.length > MAX_NOTE_COMMENTS) {
    return false
  }
  if (new Set(normalized.map((comment) => comment.id)).size !== normalized.length) {
    return false
  }
  const repliesByParent = new Map<string, number>()
  let encodedBytes = 2
  for (const comment of normalized) {
    encodedBytes += utf8ByteLength(JSON.stringify(comment)) + 1
    if (encodedBytes > MAX_NOTE_COMMENTS_JSON_BYTES) {
      return false
    }
    if (comment.parentId) {
      const replies = (repliesByParent.get(comment.parentId) ?? 0) + 1
      if (replies > MAX_COMMENT_REPLIES_PER_THREAD) {
        return false
      }
      repliesByParent.set(comment.parentId, replies)
    }
  }
  return true
}

export function getNoteComments(note: SNNote): NoteComment[] {
  return getBoundedNoteComments(note) ?? []
}

export function compareCommentMutationStamps(a: CommentMutationStamp, b: CommentMutationStamp): number {
  if (a.counter !== b.counter) {
    return a.counter - b.counter
  }
  // Locale collation is runtime-dependent and therefore cannot be used for a
  // replicated ordering decision. Relational string comparison is the
  // deterministic UTF-16 code-unit ordering defined by ECMAScript.
  const actor = compareUtf16Strings(a.actorUuid, b.actorUuid)
  return actor !== 0 ? actor : compareUtf16Strings(a.eventId, b.eventId)
}

export function normalizeCommentMutationStamp(value: unknown): CommentMutationStamp | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const stamp = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(stamp.counter) ||
    (stamp.counter as number) <= 0 ||
    !isBoundedMutationId(stamp.actorUuid) ||
    !isBoundedMutationId(stamp.eventId)
  ) {
    return undefined
  }
  return {
    counter: stamp.counter as number,
    actorUuid: stamp.actorUuid,
    eventId: stamp.eventId,
  }
}

export function normalizeCommentMutationRecord(value: unknown): NoteCommentMutationRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const stamp = normalizeCommentMutationStamp(candidate.stamp)
  if (
    !isBoundedCommentId(candidate.commentId) ||
    (candidate.operation !== 'upsert' && candidate.operation !== 'remove' && candidate.operation !== 'resolve') ||
    !stamp ||
    !Array.isArray(candidate.affectedCommentIds)
  ) {
    return null
  }
  if (
    candidate.affectedCommentIds.length === 0 ||
    candidate.affectedCommentIds.length > MAX_COMMENT_MUTATION_AFFECTED_IDS ||
    candidate.affectedCommentIds.some((commentId) => !isBoundedCommentId(commentId))
  ) {
    return null
  }
  const affectedCommentIds = [...new Set(candidate.affectedCommentIds as string[])].sort(compareUtf16Strings)
  if (affectedCommentIds.length === 0 || !affectedCommentIds.includes(candidate.commentId)) {
    return null
  }
  if (
    (candidate.operation === 'resolve' && typeof candidate.resolved !== 'boolean') ||
    (candidate.operation !== 'resolve' && candidate.resolved !== undefined)
  ) {
    return null
  }
  const result: NoteCommentMutationRecord = {
    commentId: candidate.commentId,
    operation: candidate.operation,
    stamp: {
      counter: stamp.counter,
      actorUuid: stamp.actorUuid,
      eventId: stamp.eventId,
    },
    affectedCommentIds,
  }
  if (candidate.operation === 'resolve') {
    result.resolved = candidate.resolved as boolean
  }
  if (candidate.authorship !== undefined) {
    const authorship = normalizeCommentMutationAuthorship(candidate.authorship)
    if (!authorship) {
      return null
    }
    result.authorship = authorship
  }
  return result
}

function commentMutationEventKey(mutation: NoteCommentMutationRecord): string {
  return `${mutation.stamp.actorUuid}\u0000${mutation.stamp.counter}\u0000${mutation.stamp.eventId}`
}

function encodedCollectionBytes(values: unknown[]): number {
  return utf8ByteLength(JSON.stringify(values))
}

/** Bounded full signed-event ledger; unsigned pre-v3 entries remain quarantinable. */
export function getBoundedNoteCommentMutationRecords(note: SNNote): NoteCommentMutationRecord[] | undefined {
  const raw = note.getAppDomainValue<unknown>(NoteCommentMutationsKey)
  if (raw === undefined) {
    return []
  }
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_COMMENT_MUTATION_RECORDS * 2 ||
    encodedCollectionBytes(raw) > MAX_COMMENT_MUTATIONS_JSON_BYTES * 2
  ) {
    return undefined
  }
  const result: NoteCommentMutationRecord[] = []
  for (const entry of raw) {
    const normalized = normalizeCommentMutationRecord(entry)
    if (!normalized) {
      return undefined
    }
    result.push(normalized)
  }
  return result.sort((a, b) => compareUtf16Strings(commentMutationEventKey(a), commentMutationEventKey(b)))
}

export function commentMutationRecordsFitBudgets(mutations: NoteCommentMutationRecord[]): boolean {
  const note = {
    getAppDomainValue: () => mutations,
  } as unknown as SNNote
  const normalized = getBoundedNoteCommentMutationRecords(note)
  return (
    normalized !== undefined &&
    normalized.length === mutations.length &&
    normalized.length <= MAX_COMMENT_MUTATION_RECORDS &&
    encodedCollectionBytes(normalized) <= MAX_COMMENT_MUTATIONS_JSON_BYTES
  )
}

export function getNoteCommentMutationRecords(note: SNNote): NoteCommentMutationRecord[] {
  return getBoundedNoteCommentMutationRecords(note) ?? []
}

export function clockProofFromMutation(mutation: NoteCommentMutationRecord): CommentMutationClockProof | undefined {
  if (!mutation.authorship) {
    return undefined
  }
  return {
    version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
    stamp: mutation.stamp,
    signingPublicKey: mutation.authorship.signingPublicKey,
    signature: mutation.authorship.clockSignature,
  }
}

export function getBoundedNoteCommentActorClocks(note: SNNote): NoteCommentActorClock[] | undefined {
  const raw = note.getAppDomainValue<unknown>(NoteCommentActorClocksKey)
  if (raw === undefined) {
    return []
  }
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_COMMENT_ACTOR_CLOCKS * 2 ||
    encodedCollectionBytes(raw) > MAX_COMMENT_ACTOR_CLOCKS_JSON_BYTES * 2
  ) {
    return undefined
  }
  const result: NoteCommentActorClock[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) {
      return undefined
    }
    const candidate = value as Record<string, unknown>
    const highWater = normalizeCommentMutationClockProof(candidate.highWater)
    const replayFloor =
      candidate.replayFloor === undefined ? undefined : normalizeCommentMutationClockProof(candidate.replayFloor)
    if (
      !isBoundedMutationId(candidate.actorUuid) ||
      !highWater ||
      highWater.stamp.actorUuid !== candidate.actorUuid ||
      (candidate.replayFloor !== undefined && !replayFloor) ||
      (replayFloor &&
        (replayFloor.stamp.actorUuid !== candidate.actorUuid ||
          compareCommentMutationStamps(replayFloor.stamp, highWater.stamp) > 0))
    ) {
      return undefined
    }
    result.push({
      actorUuid: candidate.actorUuid,
      highWater,
      ...(replayFloor ? { replayFloor } : {}),
    })
  }
  return result.sort((left, right) => compareUtf16Strings(left.actorUuid, right.actorUuid))
}

export function commentActorClocksFitBudgets(clocks: NoteCommentActorClock[]): boolean {
  const note = { getAppDomainValue: () => clocks } as unknown as SNNote
  const normalized = getBoundedNoteCommentActorClocks(note)
  return (
    normalized !== undefined &&
    normalized.length === clocks.length &&
    normalized.length <= MAX_COMMENT_ACTOR_CLOCKS &&
    encodedCollectionBytes(normalized) <= MAX_COMMENT_ACTOR_CLOCKS_JSON_BYTES
  )
}

/**
 * Bound long-lived per-target history without reopening captured-event replay.
 * Removed events advance only their authenticated actor's compact replay floor;
 * another actor's counter can therefore never exhaust the whole note.
 */
export function compactCommentMutationRecords(
  comments: NoteComment[],
  mutations: NoteCommentMutationRecord[],
  clocks: NoteCommentActorClock[],
): { mutations: NoteCommentMutationRecord[]; clocks: NoteCommentActorClock[] } | undefined {
  const byEvent = new Map<string, NoteCommentMutationRecord>()
  for (const value of mutations) {
    const mutation = normalizeCommentMutationRecord(value)
    if (!mutation?.authorship) {
      return undefined
    }
    const key = commentMutationEventKey(mutation)
    const existing = byEvent.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(mutation)) {
      return undefined
    }
    byEvent.set(key, mutation)
  }

  const clockByActor = new Map<string, NoteCommentActorClock>()
  for (const value of clocks) {
    const normalized = getBoundedNoteCommentActorClocks({ getAppDomainValue: () => [value] } as unknown as SNNote)?.[0]
    if (!normalized || clockByActor.has(normalized.actorUuid)) {
      return undefined
    }
    clockByActor.set(normalized.actorUuid, normalized)
  }

  const advanceReplayFloor = (mutation: NoteCommentMutationRecord): boolean => {
    const clock = clockByActor.get(mutation.stamp.actorUuid)
    const proof = clockProofFromMutation(mutation)
    if (!clock || !proof || compareCommentMutationStamps(clock.highWater.stamp, mutation.stamp) < 0) {
      return false
    }
    if (!clock.replayFloor || compareCommentMutationStamps(proof.stamp, clock.replayFloor.stamp) > 0) {
      clockByActor.set(clock.actorUuid, { ...clock, replayFloor: proof })
    }
    return true
  }

  const latestEventByTarget = new Map<string, string>()
  for (const [key, mutation] of byEvent) {
    for (const target of mutation.affectedCommentIds) {
      const existingKey = latestEventByTarget.get(target)
      const existing = existingKey ? byEvent.get(existingKey) : undefined
      if (!existing || compareCommentMutationStamps(mutation.stamp, existing.stamp) > 0) {
        latestEventByTarget.set(target, key)
      }
    }
  }
  const requiredKeys = new Set(latestEventByTarget.values())
  const earliestRequiredByActor = new Map<string, NoteCommentMutationRecord>()
  for (const key of requiredKeys) {
    const mutation = byEvent.get(key)
    if (!mutation) {
      return undefined
    }
    const earliest = earliestRequiredByActor.get(mutation.stamp.actorUuid)
    if (!earliest || compareCommentMutationStamps(mutation.stamp, earliest.stamp) < 0) {
      earliestRequiredByActor.set(mutation.stamp.actorUuid, mutation)
    }
  }
  for (const [key, mutation] of [...byEvent]) {
    const earliestRequired = earliestRequiredByActor.get(mutation.stamp.actorUuid)
    // An actor replay floor is global to that actor. Never compact an obsolete
    // event past an older retained per-target event: after reload the floor
    // would correctly reject the old event as a replay, but the target ledger
    // would then silently lose its current high-water record.
    if (
      !requiredKeys.has(key) &&
      (!earliestRequired || compareCommentMutationStamps(mutation.stamp, earliestRequired.stamp) < 0)
    ) {
      if (!advanceReplayFloor(mutation)) {
        return undefined
      }
      byEvent.delete(key)
    }
  }

  let records = [...byEvent.values()]
  if (records.length > MAX_COMMENT_MUTATION_RECORDS) {
    const liveIds = new Set(comments.map((comment) => comment.id))
    const removable = records
      .filter(
        (record) =>
          record.affectedCommentIds.every((commentId) => !liveIds.has(commentId)) &&
          // Never expose an older retained event for a deleted target by
          // compacting only its latest tombstone.
          !records.some(
            (other) =>
              commentMutationEventKey(other) !== commentMutationEventKey(record) &&
              other.affectedCommentIds.some((commentId) => record.affectedCommentIds.includes(commentId)),
          ),
      )
      .sort((first, second) => compareCommentMutationStamps(first.stamp, second.stamp))
    const removeCount = records.length - MAX_COMMENT_MUTATION_RECORDS
    const removedKeys = new Set<string>()
    for (const record of removable) {
      if (removedKeys.size >= removeCount) {
        break
      }
      const blockedByRetainedActorPrefix = records.some(
        (other) =>
          other.stamp.actorUuid === record.stamp.actorUuid &&
          compareCommentMutationStamps(other.stamp, record.stamp) < 0 &&
          !removedKeys.has(commentMutationEventKey(other)),
      )
      if (blockedByRetainedActorPrefix) {
        continue
      }
      if (!advanceReplayFloor(record)) {
        return undefined
      }
      removedKeys.add(commentMutationEventKey(record))
    }
    if (removedKeys.size < removeCount) {
      return undefined
    }
    records = records.filter((record) => !removedKeys.has(commentMutationEventKey(record)))
  }

  const nextClocks = [...clockByActor.values()].sort((left, right) =>
    compareUtf16Strings(left.actorUuid, right.actorUuid),
  )
  if (!commentMutationRecordsFitBudgets(records) || !commentActorClocksFitBudgets(nextClocks)) {
    return undefined
  }
  records.sort((a, b) => compareUtf16Strings(commentMutationEventKey(a), commentMutationEventKey(b)))
  return { mutations: records, clocks: nextClocks }
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

export function sortCommentsByCreatedAt<Comment extends NoteComment>(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    const av = Number.isNaN(at) ? 0 : at
    const bv = Number.isNaN(bt) ? 0 : bt
    return av - bv || compareUtf16Strings(a.id, b.id)
  })
}

/**
 * Group a flat comment list into top-level comments (no parentId) each paired
 * with its direct replies, both ordered oldest-first. Orphaned replies (whose
 * parent was deleted) are surfaced as top-level so they are never lost.
 */
export function buildCommentThreads<Comment extends NoteComment>(
  comments: Comment[],
): Array<{ comment: Comment; replies: Comment[] }> {
  const sorted = sortCommentsByCreatedAt(comments)
  const byId = new Set(sorted.map((c) => c.id))
  const repliesByParent = new Map<string, Comment[]>()
  const roots: Comment[] = []
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
export function generateCommentId(authorUuid?: string): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  let nonce: string
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    nonce = cryptoObj.randomUUID()
  } else {
    idCounter += 1
    nonce = `comment-${Date.now().toString(36)}-${idCounter.toString(36)}`
  }
  return authorUuid ? `${authorUuid}:${nonce}` : nonce
}
