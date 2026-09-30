import {
  CreateDecryptedItemFromPayload,
  DecryptedPayload,
  DecryptedTransferPayload,
  FillItemContentSpecialized,
  KeySystemIdentifier,
  KeySystemItemsKeyContentSpecialized,
  KeySystemItemsKeyInterface,
  PayloadTimestampDefaults,
  ProtocolVersion,
} from '@standardnotes/models'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { V004Algorithm } from '../../../../Algorithm'
import { ContentType } from '@standardnotes/domain-core'
/**
 * Side-effect import; the same unsoundness as `createItemsKey()` (see `001/Operator001.ts`), one
 * content type over: this use case returns `CreateDecryptedItemFromPayload` for a
 * KeySystemItemsKey, whose class is registered by its own module. This is the 004 shared-vault
 * path, so it is the one that would bite a user on the current protocol rather than a legacy one.
 */
import '../../../../Keys/KeySystemItemsKey/Registration'

export class CreateKeySystemItemsKeyUseCase {
  constructor(private readonly crypto: PureCryptoInterface) {}

  execute(dto: {
    uuid: string
    keySystemIdentifier: KeySystemIdentifier
    sharedVaultUuid: string | undefined
    rootKeyToken: string
  }): KeySystemItemsKeyInterface {
    const key = this.crypto.generateRandomKey(V004Algorithm.EncryptionKeyLength)
    const content = FillItemContentSpecialized<KeySystemItemsKeyContentSpecialized>({
      itemsKey: key,
      creationTimestamp: new Date().getTime(),
      version: ProtocolVersion.V004,
      rootKeyToken: dto.rootKeyToken,
    })

    const transferPayload: DecryptedTransferPayload = {
      uuid: dto.uuid,
      content_type: ContentType.TYPES.KeySystemItemsKey,
      key_system_identifier: dto.keySystemIdentifier,
      shared_vault_uuid: dto.sharedVaultUuid,
      content: content,
      dirty: true,
      ...PayloadTimestampDefaults(),
    }

    const payload = new DecryptedPayload(transferPayload)
    return CreateDecryptedItemFromPayload(payload)
  }
}
