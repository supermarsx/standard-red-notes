import {
  DecryptedPayload,
  ItemContent,
  ItemsKeyContent,
  PayloadTimestampDefaults,
  ProtocolVersion,
} from '@standardnotes/models'
import { SNItemsKey } from '../../Keys/ItemsKey/ItemsKey'
import { KeySystemItemsKey } from '../../Keys/KeySystemItemsKey/KeySystemItemsKey'
import { SNProtocolOperator004 } from './Operator004'
import { getMockedCrypto } from './MockedCrypto'
import { deconstructEncryptedPayloadString } from './V004AlgorithmHelpers'
import { ContentType } from '@standardnotes/domain-core'

describe('operator 004', () => {
  const crypto = getMockedCrypto()

  let operator: SNProtocolOperator004

  beforeEach(() => {
    operator = new SNProtocolOperator004(crypto)
  })

  /**
   * These two guard a state that must be unreachable rather than merely unlikely.
   *
   * Both methods return `CreateDecryptedItemFromPayload`, which yields the real key class only
   * once that class has been registered against its content type. Unregistered, the factory
   * returns a bare `DecryptedItem` — typed as the key interface, with `itemsKey` and `keyVersion`
   * `undefined` — and the caller encrypts with an undefined key: no error, no log, and ciphertext
   * nobody can decrypt. This file deliberately does NOT import either registration module, so it
   * fails unless `Operator004.ts` and `CreateKeySystemItemsKey.ts` make themselves self-sufficient.
   */
  it('creates a usable items key without the caller having imported the ItemsKey registration', () => {
    const itemsKey = operator.createItemsKey()

    expect(itemsKey).toBeInstanceOf(SNItemsKey)
    expect(itemsKey.keyVersion).toEqual(ProtocolVersion.V004)
    expect(typeof itemsKey.itemsKey).toEqual('string')
    expect(itemsKey.itemsKey).not.toBeUndefined()
    expect(itemsKey.content_type).toEqual(ContentType.TYPES.ItemsKey)
  })

  it('creates a usable key-system items key without the caller having imported that registration', () => {
    const keySystemItemsKey = operator.createKeySystemItemsKey(
      'key-system-items-key-uuid',
      'key-system-identifier',
      'shared-vault-uuid',
      'root-key-token',
    )

    expect(keySystemItemsKey).toBeInstanceOf(KeySystemItemsKey)
    expect(keySystemItemsKey.keyVersion).toEqual(ProtocolVersion.V004)
    expect(typeof keySystemItemsKey.itemsKey).toEqual('string')
    expect(keySystemItemsKey.itemsKey).not.toBeUndefined()
    expect(keySystemItemsKey.content_type).toEqual(ContentType.TYPES.KeySystemItemsKey)
  })

  it('should deconstructEncryptedPayloadString', () => {
    const string = '004:noncy:<e>foo<e>:eyJ1IjoiMTIzIiwidiI6IjAwNCJ9'

    const result = deconstructEncryptedPayloadString(string)

    expect(result).toEqual({
      version: '004',
      nonce: 'noncy',
      ciphertext: '<e>foo<e>',
      authenticatedData: 'eyJ1IjoiMTIzIiwidiI6IjAwNCJ9',
      additionalData: 'e30=',
    })
  })

  it('should generateEncryptedParameters', () => {
    const payload = {
      uuid: '123',
      content_type: ContentType.TYPES.Note,
      content: { foo: 'bar' } as unknown as jest.Mocked<ItemContent>,
      ...PayloadTimestampDefaults(),
    } as jest.Mocked<DecryptedPayload>

    const key = new SNItemsKey(
      new DecryptedPayload<ItemsKeyContent>({
        uuid: 'key-456',
        content_type: ContentType.TYPES.ItemsKey,
        content: {
          itemsKey: 'secret',
          version: ProtocolVersion.V004,
        } as jest.Mocked<ItemsKeyContent>,
        ...PayloadTimestampDefaults(),
      }),
    )

    const result = operator.generateEncryptedParameters(payload, key)

    expect(result).toEqual({
      uuid: '123',
      items_key_id: 'key-456',
      key_system_identifier: undefined,
      shared_vault_uuid: undefined,
      content: '004:random-string:<e>{"foo"|"bar"}<e>:base64-{"u"|"123","v"|"004"}:base64-{}',
      content_type: ContentType.TYPES.Note,
      enc_item_key: '004:random-string:<e>random-string<e>:base64-{"u"|"123","v"|"004"}:base64-{}',
      version: '004',
    })
  })
})
