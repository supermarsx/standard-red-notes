import { FullyFormedPayloadInterface } from './../../../Abstract/Payload/Interfaces/UnionTypes'
import { UuidMap } from '@standardnotes/utils'
import { PayloadCollection } from './PayloadCollection'

export class ImmutablePayloadCollection<
  P extends FullyFormedPayloadInterface = FullyFormedPayloadInterface,
> extends PayloadCollection<P> {
  public get payloads(): P[] {
    return this.all()
  }

  /** We don't use a constructor for this because we don't want the constructor to have
   * side-effects, such as calling collection.set(). */
  static WithPayloads<T extends FullyFormedPayloadInterface>(payloads: T[] = []): ImmutablePayloadCollection<T> {
    const collection = new ImmutablePayloadCollection<T>()
    if (payloads.length > 0) {
      collection.set(payloads)
    }

    Object.freeze(collection)
    return collection
  }

  static FromCollection<T extends FullyFormedPayloadInterface>(
    collection: PayloadCollection<T>,
  ): ImmutablePayloadCollection<T> {
    const mapCopy = Object.freeze(Object.assign({}, collection.map))
    /**
     * Deep-copy each per-content_type array. `Object.assign({}, typedMap)` is a SHALLOW copy:
     * the arrays would be shared by reference with the source, so a later in-place mutation
     * (setToTypedMap/deleteFromTypedMap push/remove) on the copy would corrupt the source's
     * arrays — breaking the "immutable" guarantee. Slicing each array makes the copy independent.
     */
    const typedMapCopy: Partial<Record<string, T[]>> = {}
    for (const contentType of Object.keys(collection.typedMap)) {
      typedMapCopy[contentType] = collection.typedMap[contentType]?.slice()
    }
    Object.freeze(typedMapCopy)
    const referenceMapCopy = Object.freeze(collection.referenceMap.makeCopy()) as UuidMap
    const conflictMapCopy = Object.freeze(collection.conflictMap.makeCopy()) as UuidMap

    const result = new ImmutablePayloadCollection<T>(
      true,
      mapCopy,
      typedMapCopy,
      referenceMapCopy,
      conflictMapCopy,
    )

    Object.freeze(result)

    return result
  }

  mutableCopy(): PayloadCollection<P> {
    const mapCopy = Object.assign({}, this.map)
    /**
     * Deep-copy each per-content_type array so the mutable copy does not share array references
     * with this (frozen) immutable source. Without the slice, a push/remove on the copy's typed
     * arrays would mutate the source in place — corrupting the supposedly immutable original.
     */
    const typedMapCopy: Partial<Record<string, P[]>> = {}
    for (const contentType of Object.keys(this.typedMap)) {
      typedMapCopy[contentType] = this.typedMap[contentType]?.slice()
    }
    const referenceMapCopy = this.referenceMap.makeCopy()
    const conflictMapCopy = this.conflictMap.makeCopy()
    const result = new PayloadCollection(true, mapCopy, typedMapCopy, referenceMapCopy, conflictMapCopy)
    return result
  }
}
