import { ImmutablePayloadCollection } from './../Collection/Payload/ImmutablePayloadCollection'
import { ConflictDelta } from './Conflict'
import {
  isErrorDecryptingPayload,
  isDecryptedPayload,
  isDeletedPayload,
} from '../../Abstract/Payload/Interfaces/TypeCheck'
import { FullyFormedPayloadInterface, PayloadEmitSource } from '../../Abstract/Payload'
import { ContentType } from '@standardnotes/domain-core'
import { HistoryMap } from '../History'
import { ServerSyncPushContextualPayload } from '../../Abstract/Contextual/ServerSyncPush'
import { payloadByFinalizingSyncState } from './Utilities/ApplyDirtyState'
import { ItemsKeyDelta } from './ItemsKeyDelta'
import { extendSyncDelta, SyncDeltaEmit } from './Abstract/DeltaEmit'
import { SyncDeltaInterface } from './Abstract/SyncDeltaInterface'

export class DeltaRemoteRetrieved implements SyncDeltaInterface {
  constructor(
    readonly baseCollection: ImmutablePayloadCollection,
    readonly applyCollection: ImmutablePayloadCollection,
    private itemsSavedOrSaving: ServerSyncPushContextualPayload[],
    readonly historyMap: HistoryMap,
  ) {}

  private isUuidOfPayloadCurrentlySavingOrSaved(uuid: string): boolean {
    return this.itemsSavedOrSaving.find((i) => i.uuid === uuid) != undefined
  }

  public result(): SyncDeltaEmit {
    const result: SyncDeltaEmit = {
      emits: [],
      ignored: [],
      source: PayloadEmitSource.RemoteRetrieved,
    }

    const conflicted: FullyFormedPayloadInterface[] = []

    /**
     * If we have retrieved an item that was saved as part of this ongoing sync operation,
     * or if the item is locally dirty, filter it out of retrieved_items, and add to potential conflicts.
     */
    for (const apply of this.applyCollection.all()) {
      if (
        apply.content_type === ContentType.TYPES.ItemsKey ||
        apply.content_type === ContentType.TYPES.KeySystemItemsKey
      ) {
        const itemsKeyDeltaEmit = new ItemsKeyDelta(this.baseCollection, [apply]).result()

        extendSyncDelta(result, itemsKeyDeltaEmit)

        continue
      }

      const isSavedOrSaving = this.isUuidOfPayloadCurrentlySavingOrSaved(apply.uuid)

      if (isSavedOrSaving) {
        conflicted.push(apply)

        continue
      }

      const base = this.baseCollection.find(apply.uuid)
      if (base?.dirty && !isErrorDecryptingPayload(base)) {
        conflicted.push(apply)

        continue
      }

      result.emits.push(payloadByFinalizingSyncState(apply, this.baseCollection))
    }

    /**
     * For any potential conflict above, we compare the values with current
     * local values, and if they differ, we create a new payload that is a copy
     * of the server payload.
     */
    for (const conflict of conflicted) {
      /**
       * A DELETED payload is fully formed but is not a *decrypted* payload, so it used to fall
       * through this loop — after already having been removed from the normal emit path above by
       * being pushed onto `conflicted`. The delta then emitted nothing at all for that uuid: the
       * server's deletion was silently dropped and the dirty local item survived to be pushed
       * back up, resurrecting an item the user had deleted on another device. Route it through
       * ConflictDelta instead, which preserves a dirty local edit as a conflict copy and applies
       * the tombstone to the original uuid — the same resolution DeltaRemoteDataConflicts already
       * produces for an identical server deletion arriving as a sync_conflict.
       */
      const isDeletedConflict = isDeletedPayload(conflict)

      if (!isDecryptedPayload(conflict) && !isDeletedConflict) {
        continue
      }

      const base = this.baseCollection.find(conflict.uuid)
      if (!base) {
        continue
      }

      if (isDeletedConflict && isErrorDecryptingPayload(base)) {
        /**
         * An errored base holds no readable local edit worth preserving, and the conflict
         * strategy would answer KeepBaseDuplicateApply here — duplicating the incoming deletion
         * into a *dirty* tombstone, which is not discardable and would be pushed back to the
         * server as a new deleted item. Apply the deletion directly instead.
         */
        result.emits.push(payloadByFinalizingSyncState(conflict, this.baseCollection))

        continue
      }

      const delta = new ConflictDelta(this.baseCollection, base, conflict, this.historyMap)

      extendSyncDelta(result, delta.result())
    }

    return result
  }
}
