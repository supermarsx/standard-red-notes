import { MutationType } from '../Types/MutationType'
import { PayloadInterface } from '../../Payload'
import { assertNotLitePayload } from '../../Payload/Lite/LiteSafetyGuard'
import { ItemInterface } from '../Interfaces/ItemInterface'
import { TransferPayload } from '../../TransferPayload'
import { getIncrementedDirtyIndex } from '../../../Runtime/DirtyCounter/DirtyCounter'
import { KeySystemIdentifier } from '../../../Syncable/KeySystemRootKey/KeySystemIdentifier'
import { ContentTypeUsesRootKeyEncryption } from '../../../Runtime/Encryption/ContentTypeUsesRootKeyEncryption'

/**
 * An item mutator takes in an item, and an operation, and returns the resulting payload.
 * Subclasses of mutators can modify the content field directly, but cannot modify the payload directly.
 * All changes to the payload must occur by copying the payload and reassigning its value.
 */
export class ItemMutator<
  P extends PayloadInterface<TransferPayload> = PayloadInterface<TransferPayload>,
  I extends ItemInterface<P> = ItemInterface<P>,
> {
  public readonly immutableItem: I
  protected immutablePayload: P
  protected readonly type: MutationType

  constructor(item: I, type: MutationType) {
    this.immutableItem = item
    this.type = type
    this.immutablePayload = item.payload
  }

  public getUuid() {
    return this.immutablePayload.uuid
  }

  public getItem(): I {
    return this.immutableItem
  }

  public getResult(): P {
    if (this.type === MutationType.NonDirtying) {
      return this.immutablePayload.copy()
    }

    /**
     * SAFETY: a dirtying mutation must never operate on a content-stripped (lite) payload.
     * Doing so would mark a body-less payload dirty and eventually sync it, overwriting the
     * real encrypted body. Re-hydrate full content before mutating.
     */
    assertNotLitePayload(this.immutablePayload, 'ItemMutator.getResult')

    const result = this.immutablePayload.copy({
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
    })

    return result
  }

  public setBeginSync(began: Date, globalDirtyIndex: number) {
    this.immutablePayload = this.immutablePayload.copy({
      lastSyncBegan: began,
      globalDirtyIndexAtLastSync: globalDirtyIndex,
    })
  }

  public set key_system_identifier(keySystemIdentifier: KeySystemIdentifier | undefined) {
    if (ContentTypeUsesRootKeyEncryption(this.immutableItem.content_type)) {
      throw new Error('Cannot set key_system_identifier on a root key encrypted item')
    }

    this.immutablePayload = this.immutablePayload.copy({
      key_system_identifier: keySystemIdentifier,
    })
  }

  public set shared_vault_uuid(sharedVaultUuid: string | undefined) {
    if (ContentTypeUsesRootKeyEncryption(this.immutableItem.content_type)) {
      throw new Error('Cannot set shared_vault_uuid on a root key encrypted item')
    }

    this.immutablePayload = this.immutablePayload.copy({
      shared_vault_uuid: sharedVaultUuid,
    })
  }

  public set errorDecrypting(_: boolean) {
    throw Error('This method is no longer implemented')
  }

  public set updated_at(_: Date) {
    throw Error('This method is no longer implemented')
  }

  public set updated_at_timestamp(_: number) {
    throw Error('This method is no longer implemented')
  }
}
