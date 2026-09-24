export const InfoStrings = {
  AccountDeleted: 'Your account has been successfully deleted.',

  /**
   * Standard Red Notes (work-preservation, t97): shown when a note's open editor discovers its
   * item has been discarded from the local store. Investigation confirmed the only path that
   * removes an item from `findItem` is a server-asserted deletion being applied, so this is
   * stated as fact rather than the old "can not be found or has been deleted" hedge.
   * NoteSyncController appends a sentence pointing at the automatic conflict-copy when the user
   * had unsynced text at the moment of deletion.
   */
  NoteDeletedRemotely: 'This note was deleted, most likely on another device or in another tab.',
}
