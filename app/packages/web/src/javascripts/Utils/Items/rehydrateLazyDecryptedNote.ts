import {
  DecryptedPayloadInterface,
  isLitePayload,
  PayloadEmitSource,
  SNNote,
} from '@standardnotes/snjs'

/**
 * LAZY-DECRYPT CONSUMER RE-HYDRATION
 * ----------------------------------
 * When the `lazyDecryptEnabled` flag is ON, cold-loaded notes are "lite": their
 * metadata (title/preview/flags/refs) is retained but the body (`text`) is
 * stripped to keep resident heap small. Any consumer that genuinely needs the
 * full body — editor open, markdown export, the search-index build,
 * revisions/links — must re-hydrate it on demand from IndexedDB via
 * `sync.getFullContentPayload(uuid)`.
 *
 * BYTE-IDENTICAL-WHEN-OFF GUARANTEE: with the flag off, no item is ever lite, so
 * `isLitePayload` is always false and every function here short-circuits to the
 * note's existing `text`. None of this machinery runs unless a lite item is
 * actually encountered.
 */

/** The (read-only) sync slice the body-fetching helpers need. Kept narrow for testability. */
export interface LazyRehydrationSync {
  getFullContentPayload(uuid: string): Promise<DecryptedPayloadInterface | undefined>
}

/** The minimal live-item shape the rehydrate guard inspects. */
export interface LazyRehydrationLiveItem {
  payload: SNNote['payload']
  dirty: boolean
}

/** The (read-only) items slice used to re-read the LIVE item before emitting. */
export interface LazyRehydrationItems {
  findItem(uuid: string): LazyRehydrationLiveItem | undefined
}

/** The slice of the snjs application the editing re-hydration helper needs. */
export interface LazyRehydrationApp {
  sync: LazyRehydrationSync
  items: LazyRehydrationItems
  mutator: {
    emitItemFromPayload(payload: DecryptedPayloadInterface, source: PayloadEmitSource): Promise<unknown>
  }
}

/**
 * DATA-LOSS GUARD (rehydrate-clobber race): a lite→full re-hydrate emits a NON-dirty full payload
 * sourced from disk. Between the moment we decide to re-hydrate (and `await` the async disk read)
 * and the moment we emit, the live item may have changed: the user may have typed (making it a
 * dirty FULL payload) or a sync/delta may have written the same uuid. Emitting the stale on-disk
 * body then would silently clobber that fresh edit.
 *
 * This predicate re-reads the LIVE item immediately before emitting and returns true ONLY when the
 * item is STILL lite AND STILL clean (and its dirtyIndex has not advanced past the snapshot taken
 * when we started). Any other state means a newer write is in flight, so the rehydrate emit must be
 * ABORTED. When the flag is off, no item is ever lite, so this never runs.
 */
export function isRehydrateEmitStillSafe(
  items: LazyRehydrationItems,
  uuid: string,
  dirtyIndexAtStart: number | undefined,
): boolean {
  const live = items.findItem(uuid)
  if (!live) {
    return false
  }

  if (!isLitePayload(live.payload)) {
    return false
  }

  if (live.dirty) {
    return false
  }

  const liveDirtyIndex = (live.payload as { dirtyIndex?: number }).dirtyIndex
  if (liveDirtyIndex !== undefined && dirtyIndexAtStart !== undefined && liveDirtyIndex > dirtyIndexAtStart) {
    return false
  }

  return true
}

/**
 * Returns true if the note is a content-stripped (lite) projection, i.e. its body
 * was dropped on cold-load and must be re-hydrated before the body is read. When
 * the flag is off this is always false.
 */
export function isLiteNote(note: Pick<SNNote, 'payload'>): boolean {
  return isLitePayload(note.payload)
}

/**
 * Read the FULL body text of a note, transparently re-hydrating from IndexedDB
 * when the note is lite. Read-only: does NOT mutate in-memory state (so iterating
 * many notes — e.g. export / index build — does not re-bloat the heap).
 *
 * Falls back to the in-memory `text` (which is '' for a lite note) if the on-disk
 * payload can't be read/decrypted, so callers never get `undefined`.
 */
export async function getFullNoteText(sync: LazyRehydrationSync, note: SNNote): Promise<string> {
  if (!isLiteNote(note)) {
    return note.text
  }

  const full = await sync.getFullContentPayload(note.uuid)
  const text = (full?.content as { text?: string } | undefined)?.text
  return typeof text === 'string' ? text : note.text
}

/**
 * Ensure the note held in memory is FULL (body present), re-hydrating and emitting
 * the full payload back into state when it is lite. Use this for the EDITOR-OPEN
 * path: the editor must edit/save against real content, never a body-less lite
 * payload (which the safety guard would refuse to mutate).
 *
 * Returns the (now-full) note, or the original note unchanged when it was not lite
 * or when re-hydration failed (caller still has a usable, if lite, note).
 *
 * SAFETY: emitting the full payload makes the live item a normal full note; the
 * lite marker is gone, so subsequent mutations pass the dirty/sync guard.
 */
export async function rehydrateNoteForEditing(app: LazyRehydrationApp, note: SNNote): Promise<SNNote> {
  if (!isLiteNote(note)) {
    return note
  }

  const dirtyIndexAtStart = (note.payload as { dirtyIndex?: number }).dirtyIndex

  const full = await app.sync.getFullContentPayload(note.uuid)
  if (!full || isLitePayload(full)) {
    return note
  }

  /**
   * DATA-LOSS GUARD: re-read the LIVE item AFTER the async disk read above. If it is no longer
   * lite/clean (the user typed, or a sync wrote it) the re-hydrated on-disk body is stale — emitting
   * it would silently clobber the fresh edit. Abort the emit and keep the (now-full) live item.
   */
  if (!isRehydrateEmitStillSafe(app.items, note.uuid, dirtyIndexAtStart)) {
    return note
  }

  await app.mutator.emitItemFromPayload(full, PayloadEmitSource.LocalDatabaseLoaded)

  return note
}
