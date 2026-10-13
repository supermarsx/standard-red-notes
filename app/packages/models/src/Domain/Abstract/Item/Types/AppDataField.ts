export enum AppDataField {
  Pinned = 'pinned',
  Archived = 'archived',
  Locked = 'locked',
  UserModifiedDate = 'client_updated_at',
  DefaultEditor = 'defaultEditor',
  MobileRules = 'mobileRules',
  NotAvailableOnMobile = 'notAvailableOnMobile',
  MobileActive = 'mobileActive',
  LastSize = 'lastSize',
  LegacyPrefersPlainEditor = 'prefersPlainEditor',
  ComponentInstallError = 'installError',
  /**
   * When true, this item is "local only": it is excluded from the sync upload set and
   * therefore never leaves the device. Default (absent/false) = item syncs normally.
   * Stored in appData (encrypted note content) but, because a local-only item is never
   * uploaded, the flag itself never reaches the server. See SyncService.itemsNeedingSync.
   */
  LocalOnly = 'localOnly',
  /**
   * Which state of a live shared document a note's body is: the room epoch, the Yjs state
   * vector and a fingerprint of the body, written by the collaborative editor on every save it
   * makes from such a document (web: CollaborationRevisionStamp). It is bookkeeping ABOUT the
   * body, not part of what the note says: two people saving the same body a moment apart write
   * different vectors, and that must not make the two saves different content. It is therefore
   * ignored when contents are compared (DecryptedItem.appDataContentKeysToIgnoreWhenCheckingEquality).
   */
  CollaborationRevision = 'collaborationRevision',
}
