import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { deconstructEncryptedPayloadString } from '../../V004AlgorithmHelpers'
import {
  ItemContent,
  ItemsKeyInterface,
  KeySystemItemsKeyInterface,
  KeySystemRootKeyInterface,
  RootKeyInterface,
} from '@standardnotes/models'
import { SNRootKey } from '../../../../Keys/RootKey/RootKey'
import { SNRootKeyParams } from '../../../../Keys/RootKey/RootKeyParams'
import { RootKeyEncryptedAuthenticatedData } from '../../../../Types/RootKeyEncryptedAuthenticatedData'
import { StringToAuthenticatedDataUseCase } from '../Utils/StringToAuthenticatedData'
import { CreateConsistentBase64JsonPayloadUseCase } from '../Utils/CreateConsistentBase64JsonPayload'
import { GenerateSymmetricPayloadSignatureResultUseCase } from './GenerateSymmetricPayloadSignatureResult'
import {
  EncryptedInputParameters,
  EncryptedOutputParameters,
  ErrorDecryptingParameters,
} from './../../../../Types/EncryptedParameters'
import { DecryptedParameters } from '../../../../Types/DecryptedParameters'
import { DeriveHashingKeyUseCase } from '../Hash/DeriveHashingKey'
import { V004Components } from '../../V004AlgorithmTypes'

export class GenerateDecryptedParametersUseCase {
  private base64DataUsecase = new CreateConsistentBase64JsonPayloadUseCase(this.crypto)
  private stringToAuthenticatedDataUseCase = new StringToAuthenticatedDataUseCase(this.crypto)
  private signingVerificationUseCase = new GenerateSymmetricPayloadSignatureResultUseCase(this.crypto)
  private deriveHashingKeyUseCase = new DeriveHashingKeyUseCase(this.crypto)

  constructor(private readonly crypto: PureCryptoInterface) {}

  execute<C extends ItemContent = ItemContent>(
    encrypted: EncryptedInputParameters,
    key: ItemsKeyInterface | KeySystemItemsKeyInterface | KeySystemRootKeyInterface | RootKeyInterface,
  ): DecryptedParameters<C> | ErrorDecryptingParameters {
    /**
     * CRYPTO-1 (kp pin): when decrypting an item's key with the account root key, verify that
     * the key_params (`kp`) embedded in the ciphertext's authenticated data MATCH the trusted
     * root-key params (derived from the real password). A compromised server could otherwise swap
     * `kp` to force re-derivation under a weaker KDF. If they don't match, refuse.
     *
     * `StringToAuthenticatedData` overrides u/v/ksi/svu from the outer payload but lets `kp` pass
     * through unverified, which is exactly why we pin it here.
     */
    if (!this.verifyEmbeddedKeyParams(encrypted, key)) {
      console.error('Refusing to decrypt: embedded key_params (kp) do not match trusted root-key params', {
        uuid: encrypted.uuid,
      })
      return {
        uuid: encrypted.uuid,
        errorDecrypting: true,
      }
    }

    const contentKeyResult = this.decryptContentKey(encrypted, key)
    if (!contentKeyResult) {
      console.error('Error decrypting contentKey from parameters', { uuid: encrypted.uuid })
      return {
        uuid: encrypted.uuid,
        errorDecrypting: true,
      }
    }

    const contentResult = this.decryptContent(encrypted, contentKeyResult.decrypted)
    if (!contentResult) {
      return {
        uuid: encrypted.uuid,
        errorDecrypting: true,
      }
    }

    const hashingKey = this.deriveHashingKeyUseCase.execute(key)

    const signatureVerificationResult = this.signingVerificationUseCase.execute(
      encrypted,
      hashingKey,
      {
        additionalData: contentKeyResult.components.additionalData,
        plaintext: contentKeyResult.decrypted,
      },
      {
        additionalData: contentResult.components.additionalData,
        plaintext: contentResult.decrypted,
      },
    )

    return {
      uuid: encrypted.uuid,
      content: JSON.parse(contentResult.decrypted),
      signatureData: signatureVerificationResult,
    }
  }

  private decryptContent(encrypted: EncryptedOutputParameters, contentKey: string) {
    const contentComponents = deconstructEncryptedPayloadString(encrypted.content)

    return this.decrypt(encrypted, contentComponents, contentKey)
  }

  private decryptContentKey(
    encrypted: EncryptedOutputParameters,
    key: ItemsKeyInterface | KeySystemItemsKeyInterface | KeySystemRootKeyInterface | RootKeyInterface,
  ) {
    const contentKeyComponents = deconstructEncryptedPayloadString(encrypted.enc_item_key)

    return this.decrypt(encrypted, contentKeyComponents, key.itemsKey)
  }

  /**
   * Pins the embedded `kp` (account root-key params) against the trusted root key. Only applies
   * when decrypting with the account root key (SNRootKey); items keys and key-system (vault) keys
   * carry no account `kp` to pin, so they are intentionally not affected here.
   *
   * Returns true (pass) when there is nothing to enforce, or when the embedded params match the
   * trusted ones. Returns false only on a genuine mismatch (swapped kp).
   */
  private verifyEmbeddedKeyParams(
    encrypted: EncryptedOutputParameters,
    key: ItemsKeyInterface | KeySystemItemsKeyInterface | KeySystemRootKeyInterface | RootKeyInterface,
  ): boolean {
    if (!(key instanceof SNRootKey)) {
      return true
    }

    const components = deconstructEncryptedPayloadString(encrypted.enc_item_key)
    const rawAuthenticatedData = this.stringToAuthenticatedDataUseCase.executeRaw(components.authenticatedData)
    const embeddedKp = (rawAuthenticatedData as RootKeyEncryptedAuthenticatedData).kp

    if (embeddedKp == undefined) {
      /** No embedded kp to verify; nothing to enforce. */
      return true
    }

    /**
     * Use the codebase's own canonical, version-aware params comparison. It first requires the
     * version to be equal (so a swapped legacy/weaker-KDF kp is rejected), then compares
     * identifier + pw_nonce (003/004) or identifier + pw_salt (001/002).
     */
    const embeddedParams = new SNRootKeyParams(embeddedKp)
    return key.keyParams.compare(embeddedParams)
  }

  private decrypt(encrypted: EncryptedOutputParameters, components: V004Components, key: string) {
    const rawAuthenticatedData = this.stringToAuthenticatedDataUseCase.executeRaw(components.authenticatedData)

    const doesRawContainLegacyUppercaseUuid = /[A-Z]/.test(rawAuthenticatedData.u)

    const authenticatedData = this.stringToAuthenticatedDataUseCase.execute(components.authenticatedData, {
      u: doesRawContainLegacyUppercaseUuid ? encrypted.uuid.toUpperCase() : encrypted.uuid,
      v: encrypted.version,
      ksi: encrypted.key_system_identifier,
      svu: encrypted.shared_vault_uuid,
    })

    const authenticatedDataString = this.base64DataUsecase.execute(authenticatedData)

    const decrypted = this.crypto.xchacha20Decrypt(
      components.ciphertext,
      components.nonce,
      key,
      authenticatedDataString,
    )

    if (!decrypted) {
      return null
    }

    return {
      decrypted,
      components: components,
      authenticatedDataString,
    }
  }
}
