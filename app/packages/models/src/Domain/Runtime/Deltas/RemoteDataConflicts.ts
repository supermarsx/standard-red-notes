import { ConflictDelta } from './Conflict'
import { FullyFormedPayloadInterface, PayloadEmitSource } from '../../Abstract/Payload'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { HistoryMap } from '../History'
import { extendSyncDelta, SyncDeltaEmit } from './Abstract/DeltaEmit'
import { SyncDeltaInterface } from './Abstract/SyncDeltaInterface'
import { payloadByFinalizingSyncState } from './Utilities/ApplyDirtyState'
import { ConflictConflictingDataParams } from '@standardnotes/responses'

export class DeltaRemoteDataConflicts implements SyncDeltaInterface {
  constructor(
    readonly baseCollection: ImmutablePayloadCollection,
    readonly conflicts: ConflictConflictingDataParams<FullyFormedPayloadInterface>[],
    readonly historyMap: HistoryMap,
  ) {}

  public result(): SyncDeltaEmit {
    const result: SyncDeltaEmit = {
      emits: [],
      ignored: [],
      source: PayloadEmitSource.RemoteRetrieved,
    }

    for (const conflict of this.conflicts) {
      if (conflict.server_item == undefined) {
        // Defensive: a conflicting_data conflict must carry a server_item. If the server
        // sent one that failed payload filtering it is handled as an InvalidServerItem
        // elsewhere; skip here rather than dereferencing undefined and aborting the sync.
        continue
      }

      const base = this.baseCollection.find(conflict.server_item.uuid)

      const isBaseDeleted = base == undefined

      if (isBaseDeleted) {
        result.emits.push(payloadByFinalizingSyncState(conflict.server_item, this.baseCollection))

        continue
      }

      const delta = new ConflictDelta(this.baseCollection, base, conflict.server_item, this.historyMap)

      extendSyncDelta(result, delta.result())
    }

    return result
  }
}
