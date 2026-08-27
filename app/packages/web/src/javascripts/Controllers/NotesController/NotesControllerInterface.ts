import { SNNote } from '@standardnotes/models'

export interface NotesControllerInterface {
  get firstSelectedNote(): SNNote | undefined
}

/**
 * Outcome of a bulk note mutation, split into the notes actually written and the notes that could
 * not be. Callers MUST NOT treat a non-throwing call as full success: under lazy-decrypt a
 * cold-loaded note whose body cannot be read back is refused by the model safety guard, and that
 * refusal has to reach the user rather than be counted as done.
 */
export interface BulkNoteMutationResult {
  changed: SNNote[]
  failed: SNNote[]
}
