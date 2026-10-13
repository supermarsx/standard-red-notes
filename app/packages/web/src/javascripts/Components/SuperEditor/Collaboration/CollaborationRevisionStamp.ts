/**
 * Which state of the shared document a stored revision of a note is.
 *
 * The durable form of a collaborated note is still the whole serialized body, saved by every
 * person in the room through ordinary item sync, while the CRDT that actually merges their edits
 * lives only in the browsers that have the note open. A stored revision therefore always LAGS the
 * live document while anyone types, and nothing in it used to say so: a client that retrieved one
 * could only compare texts, found them different, and kept "the server's version" as a conflicted
 * copy — once per sync, on every client, which is how one person joining a busy note produced
 * forty copies of it.
 *
 * The stamp makes the question answerable. It is the state of the Yjs document the body was
 * serialized from, in the two parts Yjs itself describes a state by:
 *
 *  - `sv`, the state vector: for each client id, how many of that client's operations the
 *    document holds;
 *  - `ds`, the delete set: which of those operations have been deleted. A deletion creates no
 *    operation of its own and does not advance the vector, so without this part a revision in
 *    which someone only DELETED would look exactly like the state before they did.
 *
 * A document that holds at least `sv` in every entry and has deleted at least everything in `ds`
 * has applied every insertion and every deletion the stamped body was made from: the revision is
 * an OLDER STATE OF THE SAME DOCUMENT and holds nothing the live one lacks. That is a proof, not
 * a guess. When it cannot be given (another lineage, an operation that never arrived, a body
 * written by something that does not edit the CRDT, a state too large to describe) the old
 * behaviour stands and the copy is kept.
 *
 * A stamp speaks for ONE save: the one that wrote it. It records when (`at`), and it is read only
 * while the note's own "last modified by a person" date is that same moment. Whatever writes the
 * note afterwards without writing a stamp of its own — an older build restoring a revision from
 * history, which puts an old body AND its old stamp back; an older build renaming the note —
 * moves that date and so voids the stamp, and the revision is treated as an unstamped one always
 * was. A stamp can therefore never make a later decision look like an earlier state.
 *
 * It travels inside the encrypted note content, so the server neither sees nor stores anything
 * new. It is a few numbers per person plus a few bytes per run of deleted text, and it starts
 * again from nothing whenever the room empties and the next person rebuilds the document.
 *
 * This module imports nothing: a controller that only has to REMOVE a stamp must not pull the
 * CRDT library in with it. The Yjs side lives in CollaborativeDocumentRegistry.
 */
export type CollaborationRevisionStamp = {
  v: 1
  /** The room epoch the document belongs to: a new epoch is a new document, rebuilt from text. */
  epoch: string
  /** `[clientId, clock]` pairs of the Yjs state vector, ascending by client id. */
  sv: Array<[number, number]>
  /**
   * The delete set: `[clientId, runs]` ascending by client id, where `runs` is a flat list
   * `gap, length, gap, length, …` of that client's deleted operations in ascending clock order,
   * each gap counted from the end of the run before it (the first from clock 0).
   */
  ds: Array<[number, number[]]>
  /** Length and fingerprint of the body this stamp was written with; see `fingerprintText`. */
  text: [number, string]
  /** When the save that wrote this stamp was made, in milliseconds since the epoch, on its author's clock. */
  at: number
}

/** The state of a live Yjs document, as plain data. */
export type CollaborativeDocumentState = {
  /** Client id to the number of that client's operations the document holds. */
  stateVector: ReadonlyMap<number, number>
  /** Client id to that client's deleted operations, as `[clock, length]` runs in ascending clock order. */
  deleted: ReadonlyMap<number, ReadonlyArray<readonly [number, number]>>
}

/** The key the stamp is stored under, in the note's default app-data domain. */
export const COLLABORATION_REVISION_KEY = 'collaborationRevision'
const DEFAULT_APP_DOMAIN = 'org.standardnotes.sn'
/** The app-data key of the note's "last modified by a person" date, which every such write moves. */
const USER_MODIFIED_DATE_KEY = 'client_updated_at'
/**
 * How far the note's user-modified date may lie after the stamp's own time and still be the same
 * save. The stamp is written inside the mutation and the date is set as that mutation completes,
 * on the same clock, so the real distance is a millisecond or two; the allowance is for a slow
 * machine, not for a second write.
 */
export const STAMP_SAVE_WINDOW_MS = 2_000

/** A document that this many clients have written to is left unstamped rather than bloating the note. */
export const MAX_STAMP_CLIENTS = 2_048
/**
 * A document with more separate runs of deleted text than this is left unstamped.
 *
 * Measured with the real editor binding, a run costs about four bytes of stamp and a document
 * gains one for roughly every seven keystrokes of ordinary writing and correcting: 720 bytes
 * after 1,000 keystrokes, 5 to 10 KB after 10,000, 30 KB after 50,000, while twenty 5,000-character
 * pastes removed again cost 28 bytes in all. The count only grows while the room stays occupied;
 * it is zero again once everyone has left. The bound is where the stamp would start to rival
 * the note itself, and above it there is simply no proof: revisions are copied as they always
 * were.
 */
export const MAX_STAMP_DELETED_RUNS = 8_192
const MAX_EPOCH_LENGTH = 128
const MAX_YJS_CLIENT_ID = 0xffff_ffff

/**
 * A fingerprint that binds a stamp to the exact body it was written with.
 *
 * Anything that rewrites `text` without editing the CRDT — another kind of client, an import, an
 * assistant edit, an older build — leaves the previous stamp in the note's app data. Its state
 * would then vouch for a body it never described, and a body nobody merged would be discarded as
 * "already contained". The fingerprint no longer matches such a body, and a stamp that does not
 * match is not a stamp. It guards against accident, not forgery: whoever can write the note can
 * write any body they like.
 */
export function fingerprintText(text: string): [number, string] {
  // cyrb53: two interleaved 32-bit multiplicative hashes, 53 bits out.
  let high = 0xdeadbeef ^ text.length
  let low = 0x41c6ce57 ^ text.length
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    high = Math.imul(high ^ code, 2654435761)
    low = Math.imul(low ^ code, 1597334677)
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909)
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909)
  const hash = 4294967296 * (2097151 & low) + (high >>> 0)
  return [text.length, hash.toString(16)]
}

/**
 * The stamp for a body serialized from a document in `state`. `undefined` when there is nothing
 * meaningful, or nothing affordable, to say: an empty document, a state that is not one a
 * document can be in, more writers or more deleted runs than a stamp may carry.
 */
export function createCollaborationRevisionStamp(
  epoch: string,
  state: CollaborativeDocumentState,
  text: string,
  at: number,
): CollaborationRevisionStamp | undefined {
  if (typeof epoch !== 'string' || epoch.length === 0 || epoch.length > MAX_EPOCH_LENGTH || !isClock(at)) {
    return undefined
  }
  const sv: Array<[number, number]> = []
  for (const [clientId, clock] of state.stateVector) {
    if (!isClientId(clientId) || !isClock(clock)) {
      return undefined
    }
    if (clock > 0) {
      sv.push([clientId, clock])
    }
  }
  if (sv.length === 0 || sv.length > MAX_STAMP_CLIENTS) {
    return undefined
  }
  sv.sort((first, second) => first[0] - second[0])

  const ds: Array<[number, number[]]> = []
  let runCount = 0
  for (const [clientId, runs] of state.deleted) {
    if (runs.length === 0) {
      continue
    }
    const held = state.stateVector.get(clientId)
    if (!isClientId(clientId) || held === undefined) {
      return undefined
    }
    const flat: number[] = []
    let previousEnd = 0
    for (const [clock, length] of runs) {
      // Ascending, not overlapping, and only operations the document actually holds.
      if (!isClock(clock) || !isClock(length) || length === 0 || clock < previousEnd || clock + length > held) {
        return undefined
      }
      flat.push(clock - previousEnd, length)
      previousEnd = clock + length
    }
    runCount += runs.length
    if (runCount > MAX_STAMP_DELETED_RUNS) {
      return undefined
    }
    ds.push([clientId, flat])
  }
  ds.sort((first, second) => first[0] - second[0])

  return { v: 1, epoch, sv, ds, text: fingerprintText(text), at }
}

/**
 * The stamp a note's CONTENT carries, if it carries a well-formed one that describes that
 * content's own body and was written by the save that last modified it. Reads only plain data,
 * so it works on an item, an ejected payload's content, or a deep copy of either.
 */
export function readCollaborationRevisionStamp(content: unknown): CollaborationRevisionStamp | undefined {
  if (typeof content !== 'object' || content === null) {
    return undefined
  }
  const { text, appData } = content as { text?: unknown; appData?: unknown }
  if (typeof text !== 'string' || typeof appData !== 'object' || appData === null) {
    return undefined
  }
  const domain = (appData as Record<string, unknown>)[DEFAULT_APP_DOMAIN]
  if (typeof domain !== 'object' || domain === null) {
    return undefined
  }
  const candidate = (domain as Record<string, unknown>)[COLLABORATION_REVISION_KEY]
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined
  }
  const { v, epoch, sv, ds, text: fingerprint, at } = candidate as Record<string, unknown>
  if (
    v !== 1 ||
    typeof epoch !== 'string' ||
    epoch.length === 0 ||
    epoch.length > MAX_EPOCH_LENGTH ||
    !Array.isArray(sv) ||
    sv.length === 0 ||
    sv.length > MAX_STAMP_CLIENTS ||
    !Array.isArray(ds) ||
    ds.length > sv.length ||
    !Array.isArray(fingerprint) ||
    fingerprint.length !== 2 ||
    !isClock(at)
  ) {
    return undefined
  }
  // Written by the save that last modified the note, and by no earlier one.
  const modifiedAt = userModifiedTime((domain as Record<string, unknown>)[USER_MODIFIED_DATE_KEY])
  if (modifiedAt === undefined || modifiedAt < at || modifiedAt - at > STAMP_SAVE_WINDOW_MS) {
    return undefined
  }
  const held = new Map<number, number>()
  const vector: Array<[number, number]> = []
  for (const entry of sv) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return undefined
    }
    const [clientId, clock] = entry as unknown[]
    if (!isClientId(clientId) || !isClock(clock) || clock === 0 || held.has(clientId)) {
      return undefined
    }
    held.set(clientId, clock)
    vector.push([clientId, clock])
  }
  const deleted = readDeleteSet(ds, held)
  if (!deleted) {
    return undefined
  }
  const [length, hash] = fingerprintText(text)
  if (fingerprint[0] !== length || fingerprint[1] !== hash) {
    return undefined
  }
  return { v: 1, epoch, sv: vector, ds: deleted, text: [length, hash], at }
}

/** The note's user-modified date as a time: a Date in memory, an ISO string once stored. */
function userModifiedTime(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const time = new Date(value).getTime()
  return Number.isSafeInteger(time) ? time : undefined
}

function readDeleteSet(ds: unknown[], held: ReadonlyMap<number, number>): Array<[number, number[]]> | undefined {
  const seen = new Set<number>()
  const deleted: Array<[number, number[]]> = []
  let runCount = 0
  for (const entry of ds) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return undefined
    }
    const [clientId, runs] = entry as unknown[]
    if (!isClientId(clientId) || seen.has(clientId) || !Array.isArray(runs)) {
      return undefined
    }
    const limit = held.get(clientId)
    if (limit === undefined || runs.length === 0 || runs.length % 2 !== 0) {
      return undefined
    }
    runCount += runs.length / 2
    if (runCount > MAX_STAMP_DELETED_RUNS) {
      return undefined
    }
    const flat: number[] = []
    let end = 0
    for (let index = 0; index < runs.length; index += 2) {
      const gap: unknown = runs[index]
      const length: unknown = runs[index + 1]
      if (!isClock(gap) || !isClock(length) || length === 0) {
        return undefined
      }
      end += gap + length
      // A deletion of an operation the stamped document does not hold describes no document.
      if (end > limit) {
        return undefined
      }
      flat.push(gap, length)
    }
    seen.add(clientId)
    deleted.push([clientId, flat])
  }
  return deleted
}

/**
 * Whether a document in `local` state has applied every insertion AND every deletion the stamped
 * revision was serialized from. True means the revision is an older (or the same) state of that
 * document.
 */
export function documentStateCovers(
  local: CollaborativeDocumentState,
  stamp: Pick<CollaborationRevisionStamp, 'sv' | 'ds'>,
): boolean {
  for (const [clientId, clock] of stamp.sv) {
    if ((local.stateVector.get(clientId) ?? 0) < clock) {
      return false
    }
  }
  for (const [clientId, runs] of stamp.ds) {
    if (!deletedRunsContain(local.deleted.get(clientId) ?? [], runs)) {
      return false
    }
  }
  return true
}

/** Whether every clock in the flat `gap, length` runs lies inside one of `local`'s ascending runs. */
function deletedRunsContain(local: ReadonlyArray<readonly [number, number]>, runs: number[]): boolean {
  let localIndex = 0
  let position = 0
  for (let index = 0; index < runs.length; index += 2) {
    let start = position + runs[index]
    const end = start + runs[index + 1]
    position = end
    while (start < end) {
      while (localIndex < local.length && local[localIndex][0] + local[localIndex][1] <= start) {
        localIndex += 1
      }
      if (localIndex === local.length || local[localIndex][0] > start) {
        return false
      }
      start = local[localIndex][0] + local[localIndex][1]
    }
  }
  return true
}

type AppDataWriter = { setAppDataItem(key: never, value: unknown): void }

/**
 * Write the stamp for the body being saved, or REMOVE the one already there. A save with no
 * live document behind it must not leave an earlier stamp beside its text.
 */
export function writeCollaborationRevisionStamp(mutator: unknown, stamp: CollaborationRevisionStamp | undefined): void {
  // Written by its literal name, not through the models package's AppDataField enum (which does
  // list it, for its own comparison rule): this build's web bundle runs against a prebuilt
  // models package, where a new enum member is `undefined` at runtime until that package is
  // rebuilt.
  //
  // `undefined`, not `null`, removes it: content is compared and stored as JSON, which drops an
  // undefined key, so a note that has no stamp stays equal to one that never had the key.
  ;(mutator as AppDataWriter).setAppDataItem(COLLABORATION_REVISION_KEY as never, stamp)
}

/**
 * Remove whatever stamp the note carries: what a save of a new body does before anything else,
 * so that a body is never left beside another body's stamp. Does nothing with an object that is
 * not a note mutator (the save path is also driven with bare stand-ins).
 */
export function removeCollaborationRevisionStamp(mutator: unknown): void {
  if (typeof (mutator as Partial<AppDataWriter> | null | undefined)?.setAppDataItem === 'function') {
    writeCollaborationRevisionStamp(mutator, undefined)
  }
}

/**
 * Keep the stamp speaking for a save that changes something OTHER than the body (a rename).
 *
 * Such a save moves the note's user-modified date, which would void a stamp that still describes
 * the unchanged body perfectly well. If the note the mutator was opened on carries a valid
 * stamp, the same stamp is written again as of `now`.
 */
export function carryCollaborationRevisionStamp(mutator: unknown, now: number): void {
  const before = (mutator as { getItem?: () => { content?: unknown } | undefined }).getItem?.()?.content
  const stamp = readCollaborationRevisionStamp(before)
  if (stamp && isClock(now)) {
    writeCollaborationRevisionStamp(mutator, { ...stamp, at: now })
  }
}

function isClientId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_YJS_CLIENT_ID
}

function isClock(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
