/* istanbul ignore file */

import {
  DecryptedItemInterface,
  DecryptedPayloadInterface,
  DeletedItemInterface,
  FullyFormedPayloadInterface,
} from '@standardnotes/models'
import { SyncOptions } from './SyncOptions'
import { AbstractService } from '../Service/AbstractService'
import { SyncEvent } from '../Event/SyncEvent'
import { SyncOpStatus } from './SyncOpStatus'
import { HttpRequest } from '@standardnotes/responses'

export interface SyncServiceInterface extends AbstractService<SyncEvent> {
  sync(options?: Partial<SyncOptions>): Promise<unknown>
  getRawSyncRequestForExternalUse(
    items: (DecryptedItemInterface | DeletedItemInterface)[],
  ): Promise<HttpRequest | undefined>

  isDatabaseLoaded(): boolean

  /**
   * LAZY-DECRYPT re-hydration entry point. Reads the raw encrypted payload for `uuid` from the
   * local database and decrypts it, returning the FULL decrypted payload (with body/`text`).
   * Returns undefined if not found or undecryptable. Used by the four consumer points to obtain
   * full content on demand when lazy-decrypt is enabled.
   */
  getFullContentPayload(uuid: string): Promise<DecryptedPayloadInterface | undefined>

  onNewDatabaseCreated(): Promise<void>
  loadDatabasePayloads(): Promise<void>
  beginAutoSyncTimer(): void
  resetSyncState(): void
  markAllItemsAsNeedingSyncAndPersist(): Promise<void>
  downloadFirstSync(waitTimeOnFailureMs: number, otherSyncOptions?: Partial<SyncOptions>): Promise<void>
  persistPayloads(payloads: FullyFormedPayloadInterface[]): Promise<void>
  lockSyncing(): void
  unlockSyncing(): void
  syncSharedVaultsFromScratch(sharedVaultUuids: string[]): Promise<void>

  setLaunchPriorityUuids(launchPriorityUuids: string[]): void

  isOutOfSync(): boolean
  getLastSyncDate(): Date | undefined
  getSyncStatus(): SyncOpStatus

  /**
   * Enable/disable Manual Sync mode. When ON, automatic syncs (item-change-triggered,
   * the periodic interval, network-return, backoff retries, and websocket-notification
   * pulls/pushes) are suppressed; only an explicit user-initiated sync runs. Local
   * persistence and offline behavior are unaffected. Default is OFF (automatic syncing).
   */
  setManualSyncMode(enabled: boolean): void
  isManualSyncModeEnabled(): boolean

  completedOnlineDownloadFirstSync: boolean
}
