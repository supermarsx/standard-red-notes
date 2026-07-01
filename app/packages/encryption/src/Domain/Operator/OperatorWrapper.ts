import {
  DecryptedPayloadInterface,
  ItemsKeyInterface,
  RootKeyInterface,
  ItemContent,
  EncryptedPayloadInterface,
  KeySystemItemsKeyInterface,
  KeySystemRootKeyInterface,
  compareVersions,
} from '@standardnotes/models'
import {
  EncryptedOutputParameters,
  encryptedInputParametersFromPayload,
  ErrorDecryptingParameters,
} from '../Types/EncryptedParameters'
import { DecryptedParameters } from '../Types/DecryptedParameters'
import { PkcKeyPair } from '@standardnotes/sncrypto-common'
import { isAsyncOperator } from './OperatorInterface/TypeCheck'
import { EncryptionOperatorsInterface } from './EncryptionOperatorsInterface'

export async function encryptPayload(
  payload: DecryptedPayloadInterface,
  key: ItemsKeyInterface | KeySystemItemsKeyInterface | KeySystemRootKeyInterface | RootKeyInterface,
  operatorManager: EncryptionOperatorsInterface,
  signingKeyPair: PkcKeyPair | undefined,
): Promise<EncryptedOutputParameters> {
  const operator = operatorManager.operatorForVersion(key.keyVersion)
  let result: EncryptedOutputParameters | undefined = undefined

  if (isAsyncOperator(operator)) {
    result = await operator.generateEncryptedParametersAsync(payload, key)
  } else {
    result = operator.generateEncryptedParameters(payload, key, signingKeyPair)
  }

  if (!result) {
    throw 'Unable to generate encryption parameters'
  }

  return result
}

export async function decryptPayload<C extends ItemContent = ItemContent>(
  payload: EncryptedPayloadInterface,
  key: ItemsKeyInterface | KeySystemItemsKeyInterface | KeySystemRootKeyInterface | RootKeyInterface,
  operatorManager: EncryptionOperatorsInterface,
): Promise<DecryptedParameters<C> | ErrorDecryptingParameters> {
  /**
   * CRYPTO-1 (protocol downgrade hardening):
   * `payload.version` is attacker/server-controllable. Selecting the operator purely from
   * it would allow a compromised server to flip a stored item to a weaker legacy protocol
   * (003/002/001 use weaker PBKDF2) and have the client silently decrypt/re-encrypt under it.
   *
   * The trusted `key` carries a `keyVersion` derived from the real account password / vault.
   * We refuse to decrypt content whose claimed version is WEAKER (numerically lower) than the
   * key's version. This does NOT break:
   *  - normal 004 decrypt (payload.version === key.keyVersion),
   *  - legitimate 003->004 migration: legacy items are re-decrypted with a legacy key of the
   *    SAME version (key 003 + payload 003 compare equal), and the new 004 items key is decrypted
   *    by the new 004 root key (equal),
   *  - vault / shared-key decryption (key and payload share the vault key version).
   * It only blocks the case where a 004-trusted key is asked to honor a downgraded 003/002 payload.
   */
  if (compareVersions(payload.version, key.keyVersion) < 0) {
    console.error(
      'Refusing to decrypt payload: claimed protocol version is weaker than the trusted key version (possible downgrade attack)',
      { uuid: payload.uuid, payloadVersion: payload.version, keyVersion: key.keyVersion },
    )
    return {
      uuid: payload.uuid,
      errorDecrypting: true,
    }
  }

  const operator = operatorManager.operatorForVersion(payload.version)

  try {
    if (isAsyncOperator(operator)) {
      return await operator.generateDecryptedParametersAsync(encryptedInputParametersFromPayload(payload), key)
    } else {
      return operator.generateDecryptedParameters(encryptedInputParametersFromPayload(payload), key)
    }
  } catch (e) {
    /**
     * CRYPTO-2 (log hygiene): never log the full encrypted payload (nonce, ciphertext,
     * enc_item_key, key_params). Log only the item uuid and a short error message.
     */
    console.error('Error decrypting payload', {
      uuid: payload.uuid,
      error: e instanceof Error ? e.message : String(e),
    })
    return {
      uuid: payload.uuid,
      errorDecrypting: true,
    }
  }
}
