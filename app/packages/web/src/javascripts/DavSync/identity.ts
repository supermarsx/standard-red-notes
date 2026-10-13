import { base32Lower, sha256, utf8Bytes } from './hash/sha256'

/**
 * Standard Red Notes: who an entry is, on both sides of a calendar sync.
 *
 * Identity is computed, never invented. Two of a person's devices may sync the
 * same linked calendar at the same moment; if each made up an id for an event
 * arriving from the other server, the note would end up holding it twice. So
 * the id of an arriving entry is a function of its UID and of nothing else, and
 * every device computes the same one. Going the other way, an entry made in the
 * app gets a UID that is a function of its id, so two devices writing it out
 * aim at the same resource and the server's own precondition settles the race.
 *
 * THESE FUNCTIONS MUST NOT CHANGE. Every linked entry is matched through them.
 * A different answer for the same input would make every linked entry look new
 * on both sides at once. The spec pins their output for fixed inputs.
 */

/** The id prefix of an entry that came from another server. */
export const INBOUND_ID_PREFIX = 'dav-'

/** The UID prefix of a calendar event that was made in the app. */
export const OUTBOUND_EVENT_UID_PREFIX = 'srn-'

/** The UID prefix of a task that was made in the app (the published feed already uses it). */
export const OUTBOUND_TASK_UID_PREFIX = 'srn-task-'

const INBOUND_ID_LENGTH = 20

/**
 * The id an entry with this UID has inside the app: `dav-` and the first 20
 * characters (100 bits) of the lower-case base32 of the SHA-256 of the UID's
 * UTF-8 bytes. The UID is used exactly as the server states it; UIDs are
 * case-sensitive and may contain anything.
 */
export function localIdForUid(uid: string): string {
  return `${INBOUND_ID_PREFIX}${base32Lower(sha256(utf8Bytes(uid))).slice(0, INBOUND_ID_LENGTH)}`
}

/** Whether an id was computed from a UID, that is, the entry came from another server. */
export function isInboundId(id: string): boolean {
  return (
    id.startsWith(INBOUND_ID_PREFIX) &&
    id.length === INBOUND_ID_PREFIX.length + INBOUND_ID_LENGTH &&
    /^[a-z2-7]+$/.test(id.slice(INBOUND_ID_PREFIX.length))
  )
}

/** The UID a calendar event made in the app is written out under. */
export function uidForEventId(eventId: string): string {
  return `${OUTBOUND_EVENT_UID_PREFIX}${eventId}`
}

/** The UID a task made in the app is written out under. */
export function uidForTodoId(todoId: string): string {
  return `${OUTBOUND_TASK_UID_PREFIX}${todoId}`
}
