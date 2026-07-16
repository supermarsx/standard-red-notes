import { HexString, PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { AsymmetricallyEncryptedString } from '../../../Types/Types'
import { V004AsymmetricStringComponents } from '../../V004AlgorithmTypes'
import { ParseConsistentBase64JsonPayloadUseCase } from '../Utils/ParseConsistentBase64JsonPayload'
import { AsymmetricItemAdditionalData } from '../../../../Types/EncryptionAdditionalData'
import { AsymmetricDecryptResult } from '../../../Types/AsymmetricDecryptResult'

export class AsymmetricDecrypt004 {
  private parseBase64Usecase: ParseConsistentBase64JsonPayloadUseCase

  constructor(private readonly crypto: PureCryptoInterface) {
    this.parseBase64Usecase = new ParseConsistentBase64JsonPayloadUseCase(this.crypto)
  }

  execute(dto: {
    stringToDecrypt: AsymmetricallyEncryptedString
    recipientSecretKey: HexString
  }): AsymmetricDecryptResult | null {
    const [_, nonce, ciphertext, additionalDataString] = <V004AsymmetricStringComponents>dto.stringToDecrypt.split(':')

    const additionalData = this.parseBase64Usecase.execute<AsymmetricItemAdditionalData>(additionalDataString)

    try {
      const plaintext = this.crypto.sodiumCryptoBoxEasyDecrypt(
        ciphertext,
        nonce,
        additionalData.senderPublicKey,
        dto.recipientSecretKey,
      )
      if (!plaintext) {
        return null
      }

      const signatureVerified = this.crypto.sodiumCryptoSignVerify(
        ciphertext,
        additionalData.signingData.signature,
        additionalData.signingData.publicKey,
      )

      return {
        plaintext,
        signatureVerified,
        signaturePublicKey: additionalData.signingData.publicKey,
        senderPublicKey: additionalData.senderPublicKey,
      }
    } catch {
      return null
    }
  }
}
