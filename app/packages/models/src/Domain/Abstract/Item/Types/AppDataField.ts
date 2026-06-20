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
}
