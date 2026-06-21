import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: in-note bookmarks / markers (forum #3733 "Note Markers").
 *
 * A bookmark marks a spot WITHIN a note so the user can jump back to it. Each
 * bookmark is nicknamable / iconable / colorizable like a tag, and is listed in a
 * searchable "Bookmarks" sidebar section. Clicking one opens the note and scrolls
 * to the marked spot.
 *
 * ## Where bookmarks are stored (and why)
 * A note's bookmarks live in the note's encrypted `appData` bag under a single
 * `bookmarks` key (an array) — the EXACT mechanism used for `reminders`,
 * `heroHeader`, and the per-note appearance colors. We persist via
 * `setAppDataItem` and read via `getAppDomainValue`.
 *
 * Preferred over a separate store because:
 *  - It syncs end-to-end with the note (a bookmark set on one device shows on
 *    every device).
 *  - It is tied to the note's lifecycle (delete the note, the bookmarks go too).
 *  - It needs ZERO models/server changes: `bookmarks` is not in the published
 *    `AppDataField` enum (which lives in the models package we must not touch),
 *    so we cast our string key to `AppDataField` at the storage boundary, exactly
 *    like the reminder/hero/appearance helpers do — `setAppDataItem` /
 *    `getAppDomainValue` accept any string key.
 *
 * ## Position capture (be pragmatic + honest about drift)
 * The `anchor` captures WHERE in the note the bookmark points:
 *  - `super`: the stable id of an inline anchor DecoratorNode inserted into the
 *    Lexical document at the cursor. Because the anchor is part of the document it
 *    MOVES with edits — this is robust. Jumping finds the rendered element by its
 *    stable DOM id and scrolls it into view. `nodeKey` is a best-effort cache of
 *    the Lexical node key at capture time (keys are not stable across reloads, so
 *    the `bookmarkId` is the source of truth).
 *  - `plain`: a character `offset` into the plaintext PLUS a short surrounding
 *    `snippet`. Plaintext offsets are BEST-EFFORT and DRIFT when the note is
 *    edited above the mark; {@link relocateBySnippet} re-finds the spot via the
 *    snippet when the raw offset no longer matches.
 *  - Both carry a coarse `scrollTop` fallback so we can at least restore the
 *    approximate scroll position when a precise anchor can't be resolved.
 */

export const NoteBookmarksKey = 'bookmarks' as unknown as AppDataField

/** Anchor for a bookmark inside a Super (Lexical) note: a stable inline node id. */
export type SuperBookmarkAnchor = {
  kind: 'super'
  /** Stable id stored on the inline anchor node; the source of truth for jumping. */
  bookmarkId: string
  /** Best-effort Lexical node key at capture time (not stable across reloads). */
  nodeKey?: string
  /** Coarse scroll position (px) of the editor at capture time. */
  scrollTop?: number
}

/** Anchor for a bookmark inside a plaintext note: a char offset + relocate snippet. */
export type PlainBookmarkAnchor = {
  kind: 'plain'
  /** Character offset into the note text at capture time (best-effort; drifts). */
  offset: number
  /** Short surrounding text used to re-locate the spot if `offset` drifted. */
  snippet: string
  /** Coarse scroll position (px) of the textarea at capture time. */
  scrollTop?: number
}

export type BookmarkAnchor = SuperBookmarkAnchor | PlainBookmarkAnchor

/** A single bookmark attached to a note. */
export type Bookmark = {
  /** Stable id so a note can carry more than one bookmark. */
  id: string
  /** User nickname shown in the sidebar (like a tag title). */
  label: string
  /** Optional color (a CSS/hex string, like a tag's `color`). */
  color?: string
  /** Optional icon (a vector icon name or single emoji, like a tag's icon). */
  icon?: string
  /** Where in the note this bookmark points. */
  anchor: BookmarkAnchor
  /** ISO 8601 creation time. */
  createdAt: string
}

/** A bookmark paired with the note it belongs to (for the aggregate sidebar list). */
export type AggregatedBookmark = {
  note: SNNote
  bookmark: Bookmark
  /** The source note's display title (trimmed, defaulted to "Untitled"). */
  noteTitle: string
}

/** Default label when the user doesn't supply one. */
export const DEFAULT_BOOKMARK_LABEL = 'Bookmark'

/**
 * Default icon for a bookmark row when the user hasn't picked one. There is no
 * dedicated "bookmark" glyph in the icon set, so we reuse `pin` (a marker/pin),
 * which is a registered vector icon.
 */
export const DEFAULT_BOOKMARK_ICON = 'pin'

/** Characters of context captured on each side of a plaintext mark for relocation. */
export const SNIPPET_RADIUS = 24

/* -------------------------------------------------------------------------- */
/* Validation / normalization (never throw on missing/legacy/malformed data)  */
/* -------------------------------------------------------------------------- */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Coerce an arbitrary stored anchor into a valid one, or null. Never throws. */
export function normalizeAnchor(value: unknown): BookmarkAnchor | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const scrollTop = Number.isFinite(Number(candidate.scrollTop)) ? Number(candidate.scrollTop) : undefined

  if (candidate.kind === 'super') {
    if (!isNonEmptyString(candidate.bookmarkId)) {
      return null
    }
    const anchor: SuperBookmarkAnchor = { kind: 'super', bookmarkId: candidate.bookmarkId }
    if (isNonEmptyString(candidate.nodeKey)) {
      anchor.nodeKey = candidate.nodeKey
    }
    if (scrollTop !== undefined) {
      anchor.scrollTop = scrollTop
    }
    return anchor
  }

  if (candidate.kind === 'plain') {
    const rawOffset = Number(candidate.offset)
    if (!Number.isFinite(rawOffset) || rawOffset < 0) {
      return null
    }
    const anchor: PlainBookmarkAnchor = {
      kind: 'plain',
      offset: Math.floor(rawOffset),
      snippet: typeof candidate.snippet === 'string' ? candidate.snippet : '',
    }
    if (scrollTop !== undefined) {
      anchor.scrollTop = scrollTop
    }
    return anchor
  }

  return null
}

/** Coerce a stored bookmark into a valid one, or null. Never throws. */
export function normalizeBookmark(value: unknown): Bookmark | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (!isNonEmptyString(candidate.id)) {
    return null
  }
  const anchor = normalizeAnchor(candidate.anchor)
  if (!anchor) {
    return null
  }
  const label =
    typeof candidate.label === 'string' && candidate.label.trim().length > 0
      ? candidate.label
      : DEFAULT_BOOKMARK_LABEL
  const bookmark: Bookmark = {
    id: candidate.id,
    label,
    anchor,
    createdAt:
      typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
        ? candidate.createdAt
        : new Date(0).toISOString(),
  }
  if (isNonEmptyString(candidate.color)) {
    bookmark.color = candidate.color
  }
  if (isNonEmptyString(candidate.icon)) {
    bookmark.icon = candidate.icon
  }
  return bookmark
}

/**
 * Read the bookmarks stored on a note. Always returns a fresh array; tolerates a
 * missing/legacy value (undefined) and filters out malformed entries. Never throws.
 */
export function getNoteBookmarks(note: SNNote): Bookmark[] {
  const raw = note.getAppDomainValue<unknown>(NoteBookmarksKey)
  if (!Array.isArray(raw)) {
    return []
  }
  const result: Bookmark[] = []
  for (const entry of raw) {
    const normalized = normalizeBookmark(entry)
    if (normalized) {
      result.push(normalized)
    }
  }
  return result
}

export function noteHasBookmark(note: SNNote): boolean {
  return getNoteBookmarks(note).length > 0
}

/* -------------------------------------------------------------------------- */
/* Pure list operations                                                       */
/* -------------------------------------------------------------------------- */

/** Pure: produce the next list with `bookmark` added (new id) or replaced (same id). */
export function upsertBookmark(bookmarks: Bookmark[], bookmark: Bookmark): Bookmark[] {
  const next = bookmarks.filter((existing) => existing.id !== bookmark.id)
  next.push({ ...bookmark })
  return sortBookmarksByCreatedAt(next)
}

/** Pure: produce the next list with the bookmark of `id` removed. */
export function removeBookmark(bookmarks: Bookmark[], id: string): Bookmark[] {
  return bookmarks.filter((bookmark) => bookmark.id !== id)
}

/**
 * Pure: patch a bookmark's editable fields (label / color / icon) by id. Passing
 * `null` for color/icon CLEARS that field; `undefined` leaves it unchanged. The
 * anchor and id are never changed here. Returns a new array.
 */
export function updateBookmark(
  bookmarks: Bookmark[],
  id: string,
  patch: { label?: string; color?: string | null; icon?: string | null },
): Bookmark[] {
  return bookmarks.map((bookmark) => {
    if (bookmark.id !== id) {
      return bookmark
    }
    const next: Bookmark = { ...bookmark }
    if (patch.label !== undefined && patch.label.trim().length > 0) {
      next.label = patch.label
    }
    if (patch.color === null) {
      delete next.color
    } else if (patch.color !== undefined) {
      next.color = patch.color
    }
    if (patch.icon === null) {
      delete next.icon
    } else if (patch.icon !== undefined) {
      next.icon = patch.icon
    }
    return next
  })
}

export function sortBookmarksByCreatedAt(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    const av = Number.isNaN(at) ? 0 : at
    const bv = Number.isNaN(bt) ? 0 : bt
    return av - bv
  })
}

let idCounter = 0

/**
 * Generate a reasonably-unique bookmark id. Uses `crypto.randomUUID` when
 * available, otherwise a time+counter fallback (keeps this module usable in tests
 * without crypto). Mirrors `generateReminderId`.
 */
export function generateBookmarkId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  idCounter += 1
  return `bookmark-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/* -------------------------------------------------------------------------- */
/* Plaintext position capture + relocation (best-effort; honest about drift)  */
/* -------------------------------------------------------------------------- */

/** Clamp an offset into [0, text.length]. */
export function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) {
    return 0
  }
  return Math.min(Math.max(0, Math.floor(offset)), text.length)
}

/**
 * Capture a plaintext anchor at `offset`: stores the offset plus a short snippet of
 * the surrounding text (SNIPPET_RADIUS chars each side) so the spot can be re-found
 * after the offset drifts.
 */
export function capturePlainAnchor(text: string, offset: number, scrollTop?: number): PlainBookmarkAnchor {
  const clamped = clampOffset(text, offset)
  const start = Math.max(0, clamped - SNIPPET_RADIUS)
  const end = Math.min(text.length, clamped + SNIPPET_RADIUS)
  const anchor: PlainBookmarkAnchor = {
    kind: 'plain',
    offset: clamped,
    snippet: text.slice(start, end),
  }
  if (scrollTop !== undefined && Number.isFinite(scrollTop)) {
    anchor.scrollTop = scrollTop
  }
  return anchor
}

/**
 * Re-locate a plaintext bookmark in (possibly edited) `text`.
 *
 * Strategy (honest, best-effort):
 *  1. If the snippet is empty, fall back to the stored offset (clamped).
 *  2. If the stored offset still has the snippet starting at it (no drift),
 *     return the offset unchanged.
 *  3. Otherwise search for the snippet and return the position WITHIN the match
 *     that corresponds to the original mark (the mark sat `markInSnippet` chars
 *     into the snippet). Prefer the occurrence nearest the original offset so a
 *     repeated snippet resolves to the closest plausible spot.
 *  4. If the snippet no longer exists at all (heavily edited), fall back to the
 *     clamped stored offset.
 *
 * Returns a character offset into `text`. Never throws.
 */
export function relocateBySnippet(text: string, offset: number, snippet: string): number {
  const fallback = clampOffset(text, offset)
  if (!snippet) {
    return fallback
  }

  // Where within the snippet the original mark sat. capturePlainAnchor puts the
  // mark SNIPPET_RADIUS chars in, unless it was near the start of the document.
  const markInSnippet = Math.min(SNIPPET_RADIUS, offset)

  // No drift: the snippet is exactly where we left it.
  if (text.slice(offset - markInSnippet, offset - markInSnippet + snippet.length) === snippet) {
    return fallback
  }

  // Collect all occurrences of the snippet and pick the one whose resulting mark
  // position is nearest the original offset.
  let bestSnippetStart = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let searchFrom = 0
  for (;;) {
    const found = text.indexOf(snippet, searchFrom)
    if (found === -1) {
      break
    }
    const candidateMark = found + markInSnippet
    const distance = Math.abs(candidateMark - offset)
    if (distance < bestDistance) {
      bestDistance = distance
      bestSnippetStart = found
    }
    searchFrom = found + 1
  }

  if (bestSnippetStart === -1) {
    return fallback
  }
  return clampOffset(text, bestSnippetStart + markInSnippet)
}

/* -------------------------------------------------------------------------- */
/* Cross-note aggregation + search (for the sidebar Bookmarks section)        */
/* -------------------------------------------------------------------------- */

/**
 * Flatten every (non-trashed) note's bookmarks into a single list, each entry
 * keeping a back-reference to its source note. Pure, in-memory derivation (no
 * server polling) — mirrors `collectAllReminders`. Notes without bookmarks cost a
 * cheap array read and contribute nothing.
 */
export function collectAllBookmarks(notes: SNNote[]): AggregatedBookmark[] {
  const all: AggregatedBookmark[] = []
  for (const note of notes) {
    if (note.trashed) {
      continue
    }
    const noteTitle = note.title?.trim() || 'Untitled'
    for (const bookmark of getNoteBookmarks(note)) {
      all.push({ note, bookmark, noteTitle })
    }
  }
  return all
}

/**
 * Narrow an aggregated bookmark list by a free-text query, matched
 * case-insensitively against the bookmark label AND the source note title. An
 * empty/whitespace query returns the list unchanged.
 */
export function filterBookmarks(bookmarks: AggregatedBookmark[], query: string): AggregatedBookmark[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) {
    return bookmarks
  }
  return bookmarks.filter(
    ({ bookmark, noteTitle }) =>
      bookmark.label.toLowerCase().includes(trimmed) || noteTitle.toLowerCase().includes(trimmed),
  )
}
