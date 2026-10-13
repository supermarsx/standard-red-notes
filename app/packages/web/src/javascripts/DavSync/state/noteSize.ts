import { utf8Length } from '../hash/sha256'

/**
 * Standard Red Notes: how large a linked calendar note may get.
 *
 * A calendar note is one encrypted item. Every change to it uploads all of it,
 * every other device downloads all of it, and the server's note history keeps
 * another whole copy of it for each save. A count of entries does not bound
 * that: a thousand entries with nothing but a title are about 400 KB, and a
 * thousand that each carry a long description are close to 4 MB. So the bound
 * is on bytes, and the count is a second, simpler bound beside it.
 *
 * The measure is the note's text plus the sync records kept with it, in UTF-8
 * bytes. That is not the size of the item on the wire (encryption and encoding
 * add roughly two fifths), but it is what a pass can compute exactly before it
 * writes, the same on every device.
 *
 * `DAV_NOTE_BYTES_LIMIT` is the line the app already draws for a note that is
 * too large to be healthy (`LargeNoteThreshold`, where it starts warning that
 * the mobile app may not be able to sync the note); `noteSize.spec.ts` holds the
 * two together. Past it a pass brings nothing more in, and says so. It never
 * drops anything to get back under.
 */
export const DAV_NOTE_BYTES_LIMIT = 1_500_000

/** From here on the person is told the calendar is getting large, while there is still room to act. */
export const DAV_NOTE_BYTES_NOTICE = 1_000_000

/** The size of a note for the bound above: its text, and its sync records as they are stored. */
export function noteBytesOf(text: string, state: unknown): number {
  return utf8Length(text) + (state === undefined ? 0 : utf8Length(JSON.stringify(state)))
}

export type NoteSizeLevel = 'fine' | 'large' | 'full'

/** Where a note of this size stands: nothing to say, worth a notice, or no room for more. */
export function noteSizeLevel(bytes: number): NoteSizeLevel {
  if (bytes > DAV_NOTE_BYTES_LIMIT) {
    return 'full'
  }
  return bytes > DAV_NOTE_BYTES_NOTICE ? 'large' : 'fine'
}
