import { lt, valid } from 'semver'
import { ConflictType } from '@standardnotes/responses'

import { ItemSaveValidationDTO } from '../SaveValidator/ItemSaveValidationDTO'
import { ItemSaveRuleResult } from './ItemSaveRuleResult'
import { ItemSaveRuleInterface } from './ItemSaveRuleInterface'

export class SharedVaultSnjsFilter implements ItemSaveRuleInterface {
  private readonly MINIMUM_SNJS_VERSION_FOR_SHARED_VAULT_OPERATIONS = '2.200.0'

  async check(dto: ItemSaveValidationDTO): Promise<ItemSaveRuleResult> {
    const isItemInASharedVaultOrHasKeySystem =
      dto.existingItem?.isAssociatedWithASharedVault() || dto.itemHash.hasDedicatedKeySystemAssociation()
    if (!isItemInASharedVaultOrHasKeySystem) {
      return {
        passed: true,
      }
    }

    // `lt` THROWS on anything that is not a semver, and the version is whatever the caller's
    // lane put in `x-snjs-version` -- which has been absent, and has been an API version
    // (`20240226`). A throw here is not a refusal of this item: it fails the whole sync, and
    // on the durable socket lane it fails a command the client then replays for good. A
    // version this server cannot read is therefore refused by name, like one that is too old.
    const clientSnjsVersion = valid(dto.snjsVersion)
    const isClientSnjsVersionLessThanMinimum =
      clientSnjsVersion === null || lt(clientSnjsVersion, this.MINIMUM_SNJS_VERSION_FOR_SHARED_VAULT_OPERATIONS)
    if (isClientSnjsVersionLessThanMinimum) {
      return {
        passed: false,
        conflict: {
          unsavedItem: dto.itemHash,
          serverItem: dto.existingItem ?? undefined,
          type: ConflictType.SharedVaultSnjsVersionError,
        },
      }
    }

    return {
      passed: true,
    }
  }
}
