/* istanbul ignore file */

export enum SyncSource {
  External = 'External',
  SpawnQueue = 'SpawnQueue',
  ResolveQueue = 'ResolveQueue',
  MoreDirtyItems = 'MoreDirtyItems',
  DownloadFirst = 'DownloadFirst',
  AfterDownloadFirst = 'AfterDownloadFirst',
  IntegrityCheck = 'IntegrityCheck',
  ResolveOutOfSync = 'ResolveOutOfSync',
  /** An automatic retry scheduled after one or more consecutive sync failures (exponential backoff). */
  BackoffRetry = 'BackoffRetry',
  /** A sync triggered as soon as the network/app becomes available again (online/focus/visibility). */
  NetworkReturned = 'NetworkReturned',
}
