export const InfoStrings = {
  AccountDeleted: 'Your account has been successfully deleted.',

  /**
   * Standard Red Notes (work-preservation, t97): shown when a note's open editor discovers its
   * item has been discarded from the local store AND that discard was a genuine deletion (a
   * `content.conflict_of` rescue copy exists, or no related copy exists at all) -- distinct from
   * `NoteReidentifiedRemotely` below, which covers a uuid ALTERNATION discard that is not a
   * deletion. This is stated as fact rather than the old "can not be found or has been deleted"
   * hedge. NoteSyncController appends a sentence pointing at the automatic conflict-copy when
   * the user had unsynced text at the moment of deletion.
   */
  NoteDeletedRemotely: 'This note was deleted, most likely on another device or in another tab.',

  /**
   * Standard Red Notes (work-preservation, t97): shown instead of `NoteDeletedRemotely` when the
   * discarded uuid was a `PayloadsByAlternatingUuid` re-identification (the copy carries
   * `content.duplicate_of` but never `content.conflict_of`) rather than a deletion -- the note's
   * content survives verbatim under a new uuid and is still on the server. Nothing was lost;
   * saying "deleted" here would be false. Deliberately does not name a cause: per ee11b67f the
   * trigger is a uuid COLLISION (e.g. restoring an old backup whose uuids clash with the
   * account's own), not a sync/edit conflict -- an earlier draft of this string said "a sync
   * conflict gave it a new identity", which was itself inaccurate.
   */
  NoteReidentifiedRemotely:
    'This note was not deleted. It was automatically given a new identity, and its content is safe.',
}
