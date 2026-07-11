import { PkcKeyPair, PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { AdditionalData } from '../../../../Types/EncryptionAdditionalData'
import { HashStringUseCase } from '../Hash/HashString'
import { HashingKey } from '../Hash/HashingKey'

export class GenerateSymmetricAdditionalDataUseCase {
  private hashUseCase: HashStringUseCase

  constructor(private readonly crypto: PureCryptoInterface) {
    this.hashUseCase = new HashStringUseCase(this.crypto)
  }

  execute(
    payloadPlaintext: string,
    hashingKey: HashingKey,
    signingKeyPair?: PkcKeyPair,
  ): { additionalData: AdditionalData; plaintextHash: string } {
    const plaintextHash = this.hashUseCase.execute(payloadPlaintext, hashingKey)

    if (!signingKeyPair) {
      return {
        additionalData: {},
        plaintextHash,
      }
    }

    const signature = this.crypto.sodiumCryptoSign(plaintextHash, signingKeyPair.privateKey)

    return {
      additionalData: {
        signingData: {
          publicKey: signingKeyPair.publicKey,
          signature,
        },
      },
      plaintextHash,
    }
  }
}
