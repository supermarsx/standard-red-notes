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

/** The slice of the snjs application the editing re-hydration helper needs. */
export interface LazyRehydrationApp {
  sync: LazyRehydrationSync
  mutator: {
    emitItemFromPayload(payload: DecryptedPayloadInterface, source: PayloadEmitSource): Promise<unknown>
  }
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

  const full = await app.sync.getFullContentPayload(note.uuid)
  if (!full || isLitePayload(full)) {
    return note
  }

  await app.mutator.emitItemFromPayload(full, PayloadEmitSource.LocalDatabaseLoaded)

  return note
}
