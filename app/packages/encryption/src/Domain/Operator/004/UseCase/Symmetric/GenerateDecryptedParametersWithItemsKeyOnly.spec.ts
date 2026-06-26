import { PkcKeyPair, PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { getMockedCrypto } from '../../MockedCrypto'
import { GenerateDecryptedParametersUseCase } from './GenerateDecryptedParameters'
import { GenerateEncryptedParametersUseCase } from './GenerateEncryptedParameters'
import { DecryptedPayloadInterface, ItemsKeyInterface } from '@standardnotes/models'
import { EncryptedInputParameters, EncryptedOutputParameters } from '../../../../Types/EncryptedParameters'
import { DecryptedParameters } from '../../../../Types/DecryptedParameters'
import { isErrorDecryptingParameters } from '../../../../Types/EncryptedParameters'
import { ContentType } from '@standardnotes/domain-core'

/**
 * Proves the INVARIANT the decryption worker pool relies on: decrypting with a
 * minimal `{ itemsKey }` object (just the hex string the worker ships across
 * postMessage) is byte-for-byte identical to decrypting with the full
 * ItemsKeyInterface model object on the sync main-thread path.
 *
 * GenerateDecryptedParametersUseCase reads ONLY `key.itemsKey` (verified:
 * decryptContentKey -> key.itemsKey; DeriveHashingKey -> key.itemsKey). This test
 * is the regression guard for that: if anyone ever adds a second key field, the
 * "with full key vs. with itemsKey-only" assertions below will diverge.
 */
describe('GenerateDecryptedParameters with itemsKey-only key (worker invariant)', () => {
  let crypto: PureCryptoInterface
  let usecase: GenerateDecryptedParametersUseCase
  let signingKeyPair: PkcKeyPair
  let fullKey: ItemsKeyInterface

  beforeEach(() => {
    crypto = getMockedCrypto()
    usecase = new GenerateDecryptedParametersUseCase(crypto)
    fullKey = {
      uuid: 'items-key-id',
      itemsKey: 'items-key-hex',
      // Extra fields a real ItemsKeyInterface carries but the use-case must NOT read:
      content_type: ContentType.TYPES.ItemsKey,
      keyVersion: '004',
      isDefault: true,
      itemsKeyVersion: undefined,
    } as unknown as ItemsKeyInterface
  })

  const encrypt = (plaintext: string): EncryptedInputParameters => {
    const decrypted = {
      uuid: '123',
      content: { text: plaintext },
      content_type: ContentType.TYPES.Note,
    } as unknown as jest.Mocked<DecryptedPayloadInterface>

    const encryptUseCase = new GenerateEncryptedParametersUseCase(crypto)
    return encryptUseCase.execute(decrypted, fullKey, signingKeyPair) as EncryptedOutputParameters as EncryptedInputParameters
  }

  const decryptOrThrow = (
    encrypted: EncryptedInputParameters,
    key: { itemsKey: string },
  ): DecryptedParameters => {
    const result = usecase.execute(encrypted, key as unknown as ItemsKeyInterface)
    if (isErrorDecryptingParameters(result)) {
      throw new Error('expected successful decryption')
    }
    return result
  }

  describe('without signatures', () => {
    it('itemsKey-only key matches the full key object exactly', () => {
      const encrypted = encrypt('hello world')

      const withFullKey = decryptOrThrow(encrypted, fullKey)
      const withItemsKeyOnly = decryptOrThrow(encrypted, { itemsKey: 'items-key-hex' })

      expect(withItemsKeyOnly).toEqual(withFullKey)
      expect(withItemsKeyOnly.content).toEqual({ text: 'hello world' })
    })
  })

  describe('with signatures', () => {
    beforeEach(() => {
      signingKeyPair = crypto.sodiumCryptoSignSeedKeypair('seedling')
    })

    it('itemsKey-only key reproduces content AND signature data', () => {
      const encrypted = encrypt('signed payload')

      const withFullKey = decryptOrThrow(encrypted, fullKey)
      const withItemsKeyOnly = decryptOrThrow(encrypted, { itemsKey: 'items-key-hex' })

      expect(withItemsKeyOnly).toEqual(withFullKey)
      expect(withItemsKeyOnly.content).toEqual({ text: 'signed payload' })
      expect(withItemsKeyOnly.signatureData).toEqual(withFullKey.signatureData)
      expect(withItemsKeyOnly.signatureData.result?.passes).toBe(true)
    })
  })

  it('a failed content-key decrypt yields an errorDecrypting marker keyed by uuid', () => {
    // The mock crypto does not model key-dependent failure, so simulate a real
    // libsodium decrypt failure (returns null) to assert the error contract the
    // worker preserves: a failed item stays encrypted as { uuid, errorDecrypting }.
    ;(crypto.xchacha20Decrypt as jest.Mock).mockReturnValueOnce(null)
    const encrypted = encrypt('secret')

    const result = usecase.execute(encrypted, { itemsKey: 'items-key-hex' } as unknown as ItemsKeyInterface)

    expect(isErrorDecryptingParameters(result)).toBe(true)
    expect((result as { uuid: string }).uuid).toBe(encrypted.uuid)
  })
})
