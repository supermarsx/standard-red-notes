import { DecryptedItemInterface } from './../Interfaces/DecryptedItem'
import { Copy } from '@standardnotes/utils'
import { MutationType } from '../Types/MutationType'
import { PrefKey } from '../../../Syncable/UserPrefs/PrefKey'
import { ItemContent } from '../../Content/ItemContent'
import { AppDataField } from '../Types/AppDataField'
import { DefaultAppDomain, DomainDataValueType, ItemDomainKey } from '../Types/DefaultAppDomain'
import { ItemMutator } from './ItemMutator'
import { DecryptedPayloadInterface } from '../../Payload/Interfaces/DecryptedPayload'
import { assertNotLitePayload } from '../../Payload/Lite/LiteSafetyGuard'
import { ItemInterface } from '../Interfaces/ItemInterface'
import { getIncrementedDirtyIndex } from '../../../Runtime/DirtyCounter/DirtyCounter'

export class DecryptedItemMutator<
  C extends ItemContent = ItemContent,
  I extends DecryptedItemInterface<C> = DecryptedItemInterface<C>,
> extends ItemMutator<DecryptedPayloadInterface<C>, I> {
  protected mutableContent: C

  constructor(item: I, type: MutationType) {
    super(item, type)

    const mutableCopy = Copy<C>(this.immutablePayload.content)
    this.mutableContent = mutableCopy
  }

  public override getResult(): DecryptedPayloadInterface<C> {
    if (this.type === MutationType.NonDirtying) {
      return this.immutablePayload.copy({
        content: this.mutableContent,
      })
    }

    /**
     * SAFETY: a dirtying mutation must never operate on a content-stripped (lite) payload.
     * Marking a body-less payload dirty would eventually sync it and overwrite the real
     * encrypted body. Re-hydrate full content (getFullContent) before mutating.
     */
    assertNotLitePayload(this.immutablePayload, 'DecryptedItemMutator.getResult')

    if (this.type === MutationType.UpdateUserTimestamps) {
      this.userModifiedDate = new Date()
    } else {
      const currentValue = this.immutableItem.userModifiedDate
      if (!currentValue) {
        this.userModifiedDate = new Date(this.immutableItem.serverUpdatedAt)
      }
    }

    const result = this.immutablePayload.copy({
      content: this.mutableContent,
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
      signatureData: undefined,
      last_edited_by_uuid: undefined,
    })

    return result
  }

  public override setBeginSync(began: Date, globalDirtyIndex: number) {
    this.immutablePayload = this.immutablePayload.copy({
      content: this.mutableContent,
      lastSyncBegan: began,
      globalDirtyIndexAtLastSync: globalDirtyIndex,
    })
  }

  /** Not recommended to use as this might break item schema if used incorrectly */
  public setCustomContent(content: C): void {
    this.mutableContent = Copy(content)
  }

  public set userModifiedDate(date: Date) {
    this.setAppDataItem(AppDataField.UserModifiedDate, date)
  }

  public set conflictOf(conflictOf: string | undefined) {
    this.mutableContent.conflict_of = conflictOf
  }

  public set protected(isProtected: boolean) {
    this.mutableContent.protected = isProtected
  }

  public set trashed(trashed: boolean) {
    this.mutableContent.trashed = trashed
  }

  set starred(starred: boolean) {
    this.mutableContent.starred = starred
  }

  public set pinned(pinned: boolean) {
    this.setAppDataItem(AppDataField.Pinned, pinned)
  }

  public set archived(archived: boolean) {
    this.setAppDataItem(AppDataField.Archived, archived)
  }

  public set locked(locked: boolean) {
    this.setAppDataItem(AppDataField.Locked, locked)
  }

  /**
   * Marks/unmarks this item as "local only" (excluded from the sync upload set).
   *
   * Local-only is a pre-upload decision. Once an item has synced, excluding future
   * uploads cannot retract the encrypted copy already stored by the server, so allowing
   * that transition would violate the feature's privacy contract. Existing legacy
   * local-only items remain readable and can be switched back to syncing.
   */
  public set localOnly(localOnly: boolean) {
    const isNewlyEnabling = localOnly && !this.immutableItem.localOnly
    if (isNewlyEnabling && !this.immutableItem.neverSynced) {
      throw new Error('Local-only can only be enabled before an item has ever been synced.')
    }

    this.setAppDataItem(AppDataField.LocalOnly, localOnly)
  }

  /**
   * Overwrites the entirety of this domain's data with the data arg.
   */
  public setDomainData(data: DomainDataValueType, domain: ItemDomainKey): void {
    if (!this.mutableContent.appData) {
      this.mutableContent.appData = {
        [DefaultAppDomain]: {},
      }
    }

    this.mutableContent.appData[domain] = data
  }

  /**
   * First gets the domain data for the input domain.
   * Then sets data[key] = value
   */
  public setDomainDataKey(key: keyof DomainDataValueType, value: unknown, domain: ItemDomainKey): void {
    if (!this.mutableContent.appData) {
      this.mutableContent.appData = {
        [DefaultAppDomain]: {},
      }
    }

    if (!this.mutableContent.appData[domain]) {
      this.mutableContent.appData[domain] = {}
    }

    const domainData = this.mutableContent.appData[domain] as DomainDataValueType
    domainData[key] = value
  }

  public setAppDataItem(key: AppDataField | PrefKey, value: unknown) {
    this.setDomainDataKey(key, value, DefaultAppDomain)
  }

  public e2ePendingRefactor_addItemAsRelationship(item: DecryptedItemInterface) {
    const references = this.mutableContent.references || []
    if (!references.find((r) => r.uuid === item.uuid)) {
      references.push({
        uuid: item.uuid,
        content_type: item.content_type,
      })
    }
    this.mutableContent.references = references
  }

  public removeItemAsRelationship(item: ItemInterface) {
    let references = this.mutableContent.references || []
    references = references.filter((r) => r.uuid !== item.uuid)
    this.mutableContent.references = references
  }
}
