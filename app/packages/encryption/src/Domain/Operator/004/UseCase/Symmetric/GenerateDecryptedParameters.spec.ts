import { PkcKeyPair, PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { getMockedCrypto } from '../../MockedCrypto'
import { GenerateDecryptedParametersUseCase } from './GenerateDecryptedParameters'
import {
  DecryptedPayload,
  DecryptedPayloadInterface,
  ItemsKeyInterface,
  PayloadTimestampDefaults,
  ProtocolVersion,
  RootKeyContent,
} from '@standardnotes/models'
import { GenerateEncryptedParametersUseCase } from './GenerateEncryptedParameters'
import {
  EncryptedInputParameters,
  EncryptedOutputParameters,
  isErrorDecryptingParameters,
} from '../../../../Types/EncryptedParameters'
import { ContentType } from '@standardnotes/domain-core'
import { SNRootKey } from '../../../../Keys/RootKey/RootKey'
import { AnyKeyParamsContent, KeyParamsOrigination } from '@standardnotes/common'

describe('generate decrypted parameters usecase', () => {
  let crypto: PureCryptoInterface
  let usecase: GenerateDecryptedParametersUseCase
  let signingKeyPair: PkcKeyPair
  let itemsKey: ItemsKeyInterface

  beforeEach(() => {
    crypto = getMockedCrypto()
    usecase = new GenerateDecryptedParametersUseCase(crypto)
    itemsKey = {
      uuid: 'items-key-id',
      itemsKey: 'items-key',
      content_type: ContentType.TYPES.ItemsKey,
    } as jest.Mocked<ItemsKeyInterface>
  })

  const generateEncryptedParameters = <T extends EncryptedOutputParameters>(plaintext: string) => {
    const decrypted = {
      uuid: '123',
      content: {
        text: plaintext,
      },
      content_type: ContentType.TYPES.Note,
    } as unknown as jest.Mocked<DecryptedPayloadInterface>

    const encryptedParametersUsecase = new GenerateEncryptedParametersUseCase(crypto)
    return encryptedParametersUsecase.execute(decrypted, itemsKey, signingKeyPair) as T
  }

  describe('without signatures', () => {
    it('should generate decrypted parameters', () => {
      const encrypted = generateEncryptedParameters<EncryptedInputParameters>('foo')

      const result = usecase.execute(encrypted, itemsKey)

      expect(result).toEqual({
        uuid: expect.any(String),
        content: expect.any(Object),
        signatureData: {
          required: false,
          contentHash: expect.any(String),
        },
      })
    })
  })

  describe('with signatures', () => {
    beforeEach(() => {
      signingKeyPair = crypto.sodiumCryptoSignSeedKeypair('seedling')
    })

    it('should generate decrypted parameters', () => {
      const encrypted = generateEncryptedParameters<EncryptedInputParameters>('foo')

      const result = usecase.execute(encrypted, itemsKey)

      expect(result).toEqual({
        uuid: expect.any(String),
        content: expect.any(Object),
        signatureData: {
          required: false,
          contentHash: expect.any(String),
          result: {
            passes: true,
            publicKey: signingKeyPair.publicKey,
            signature: expect.any(String),
          },
        },
      })
    })
  })

  describe('CRYPTO-1: embedded key_params (kp) pinning for root-key-encrypted items', () => {
    const buildRootKey = (keyParams: AnyKeyParamsContent): SNRootKey => {
      return new SNRootKey(
        new DecryptedPayload<RootKeyContent>({
          uuid: 'root-key',
          content_type: ContentType.TYPES.RootKey,
          content: {
            version: ProtocolVersion.V004,
            masterKey: 'master-key',
            keyParams,
          } as RootKeyContent,
          ...PayloadTimestampDefaults(),
        }),
      )
    }

    const trustedParams: AnyKeyParamsContent = {
      identifier: 'user@example.com',
      pw_nonce: 'trusted-nonce',
      version: ProtocolVersion.V004,
      origination: KeyParamsOrigination.Registration,
      created: '0',
    } as AnyKeyParamsContent

    /** Encrypts an items-key (root-key-encrypted content type) so the ciphertext embeds `kp`. */
    const encryptRootKeyEncryptedItem = (rootKey: SNRootKey) => {
      const decrypted = {
        uuid: 'items-key-uuid',
        content: {
          itemsKey: 'the-items-key',
          version: ProtocolVersion.V004,
        },
        content_type: ContentType.TYPES.ItemsKey,
        ...PayloadTimestampDefaults(),
      } as unknown as jest.Mocked<DecryptedPayloadInterface>

      const encryptedParametersUsecase = new GenerateEncryptedParametersUseCase(crypto)
      return encryptedParametersUsecase.execute(decrypted, rootKey, undefined) as EncryptedInputParameters
    }

    it('decrypts normally when embedded kp matches the trusted root-key params', () => {
      const rootKey = buildRootKey(trustedParams)
      const encrypted = encryptRootKeyEncryptedItem(rootKey)

      const result = usecase.execute(encrypted, rootKey)

      expect(isErrorDecryptingParameters(result)).toBeFalsy()
    })

    it('refuses to decrypt when the embedded kp is swapped to weaker/legacy params', () => {
      const realRootKey = buildRootKey(trustedParams)
      const encrypted = encryptRootKeyEncryptedItem(realRootKey)

      // Attacker-controlled trusted key derived from the real password still has the real params,
      // but the stored ciphertext now carries a swapped (downgraded) kp.
      const swappedParams: AnyKeyParamsContent = {
        identifier: 'user@example.com',
        pw_nonce: 'attacker-nonce',
        version: ProtocolVersion.V003,
      } as AnyKeyParamsContent
      const tamperedRootKey = buildRootKey(swappedParams)
      const tamperedEncrypted = encryptRootKeyEncryptedItem(tamperedRootKey)

      // Decrypt the tampered ciphertext (swapped kp) with the user's REAL trusted root key.
      const result = usecase.execute(tamperedEncrypted, realRootKey)

      expect(isErrorDecryptingParameters(result)).toBeTruthy()
      // Sanity: the legitimately-encrypted payload still decrypts with the real key.
      expect(isErrorDecryptingParameters(usecase.execute(encrypted, realRootKey))).toBeFalsy()
    })
  })
})
