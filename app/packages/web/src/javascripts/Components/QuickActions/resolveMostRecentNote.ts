import { SNNote } from '@standardnotes/snjs'

/**
 * Minimal structural shape of a note for "most recently modified" resolution.
 * Kept structural (rather than depending on the full SNNote class) so the resolver is
 * trivially unit-testable without standing up the app/services.
 */
export interface RecencyComparableNote {
  uuid: string
  userModifiedDate?: Date
  trashed?: boolean
}

/**
 * Resolve the most recently modified, non-trashed note from a collection.
 *
 * The notes "in" a tag/folder are exactly the notes that reference it. Callers pass
 * `application.items.itemsReferencingItem(tag).filter(isNote)` (the same call
 * LinkingController uses for linked notes). We sort by `userModifiedDate` descending
 * and return the newest, or undefined when the collection is empty.
 */
export function resolveMostRecentNote<T extends RecencyComparableNote>(notes: T[]): T | undefined {
  let mostRecent: T | undefined
  let mostRecentTime = -Infinity

  for (const note of notes) {
    if (note.trashed) {
      continue
    }
    const time = note.userModifiedDate instanceof Date ? note.userModifiedDate.getTime() : 0
    if (time > mostRecentTime) {
      mostRecentTime = time
      mostRecent = note
    }
  }

  return mostRecent
}

/** Convenience overload typed to SNNote for use in the app. */
export function resolveMostRecentSNNote(notes: SNNote[]): SNNote | undefined {
  return resolveMostRecentNote(notes)
}
