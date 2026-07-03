import { PayloadSource } from './../../Abstract/Payload/Types/PayloadSource'
import { extendArray, UuidGenerator } from '@standardnotes/utils'
import { ImmutablePayloadCollection } from '../../Runtime/Collection/Payload/ImmutablePayloadCollection'
import { ItemContent } from '../../Abstract/Content/ItemContent'
import { PayloadsByUpdatingReferencingPayloadReferences } from './PayloadsByUpdatingReferencingPayloadReferences'
import { isDecryptedPayload } from '../../Abstract/Payload/Interfaces/TypeCheck'
import { isLitePayload } from '../../Abstract/Payload/Lite/LitePayload'
import { FullyFormedPayloadInterface } from '../../Abstract/Payload/Interfaces/UnionTypes'
import { SyncResolvedPayload } from '../../Runtime/Deltas/Utilities/SyncResolvedPayload'
import { getIncrementedDirtyIndex } from '../../Runtime/DirtyCounter/DirtyCounter'

/**
 * Copies payload and assigns it a new uuid.
 * @returns An array of payloads that have changed as a result of copying.
 */
export function PayloadsByDuplicating<C extends ItemContent = ItemContent>(dto: {
  payload: FullyFormedPayloadInterface<C>
  baseCollection: ImmutablePayloadCollection<FullyFormedPayloadInterface>
  isConflict?: boolean
  additionalContent?: Partial<C>
  source?: PayloadSource
}): SyncResolvedPayload[] {
  const { payload, baseCollection, isConflict, additionalContent, source } = dto

  /**
   * LAZY-DECRYPT DATA-LOSS GUARD (defense-in-depth): never duplicate a content-stripped ("lite")
   * note. Its body was dropped in memory, so a copy would be a dirty, body-less payload still
   * carrying the lite marker — a phantom empty conflicted-copy that trips the sync tripwire.
   * Refuse: emit NO duplicate rather than an empty one. Callers no longer reach here with a lite
   * base once the ConflictDelta seam finalizes lite bases from the server payload; this is
   * belt-and-suspenders for any future caller.
   */
  if (isLitePayload(payload)) {
    return []
  }

  const results: SyncResolvedPayload[] = []

  const override = {
    uuid: UuidGenerator.GenerateUuid(),
    dirty: true,
    dirtyIndex: getIncrementedDirtyIndex(),
    lastSyncBegan: undefined,
    lastSyncEnd: new Date(),
    duplicate_of: payload.uuid,
  }

  let copy: SyncResolvedPayload

  if (isDecryptedPayload(payload)) {
    const contentOverride: C = {
      ...payload.content,
      ...additionalContent,
    }

    if (isConflict) {
      contentOverride.conflict_of = payload.uuid
    }

    copy = payload.copyAsSyncResolved({
      ...override,
      content: contentOverride,
      deleted: false,
    })
  } else {
    copy = payload.copyAsSyncResolved(
      {
        ...override,
      },
      source || payload.source,
    )
  }

  results.push(copy)

  if (isDecryptedPayload(payload) && isDecryptedPayload(copy)) {
    /**
     * Get the payloads that make reference to payload and add the copy.
     */
    const updatedReferencing = PayloadsByUpdatingReferencingPayloadReferences(payload, baseCollection, [copy])
    extendArray(results, updatedReferencing)
  }

  return results
}
