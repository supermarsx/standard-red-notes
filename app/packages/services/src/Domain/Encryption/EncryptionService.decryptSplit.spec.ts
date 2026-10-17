import { ContentType } from '@standardnotes/domain-core'
import {
  DecryptedPayload,
  DecryptedPayloadInterface,
  EncryptedPayload,
  EncryptedPayloadInterface,
  PayloadTimestampDefaults,
} from '@standardnotes/models'
import type { KeyedDecryptionSplit, KeyedEncryptionSplit } from '@standardnotes/encryption'
import { EncryptionService } from './EncryptionService'

const precedence = [
  ['usesItemsKey', 'first-items'],
  ['usesRootKey', 'root'],
  ['usesKeySystemRootKey', 'system-root'],
  ['usesItemsKeyWithKeyLookup', 'lookup-items'],
  ['usesRootKeyWithKeyLookup', 'lookup-root'],
  ['usesKeySystemRootKeyWithKeyLookup', 'lookup-system-root'],
] as const

const fixture = () => {
  let uuidReads = 0
  const wrapped = <T extends EncryptedPayload | DecryptedPayload>(original: T): T => {
    const uuid = original.uuid
    const result = {
      ...original,
      ejected: () => original.ejected(),
    } as T
    Object.defineProperty(result, 'uuid', {
      enumerable: true,
      get: () => {
        uuidReads++
        return uuid
      },
    })
    return result
  }
  const payload = (uuid: string, owner = uuid) => {
    const original = new EncryptedPayload({
      ...PayloadTimestampDefaults(),
      uuid,
      user_uuid: owner,
      content_type: ContentType.TYPES.Note,
      content: '004:fixture',
      enc_item_key: '004:key',
      items_key_id: undefined,
      errorDecrypting: false,
      waitingForKey: false,
    })
    return wrapped(original)
  }
  const plain = (uuid: string, owner = uuid) =>
    wrapped(
      new DecryptedPayload({
        ...PayloadTimestampDefaults(),
        uuid,
        user_uuid: owner,
        content_type: ContentType.TYPES.Note,
        content: { references: [], title: 'original' },
      }),
    )
  const decrypt = jest.fn(async (items: EncryptedPayloadInterface[]) =>
    items.map((item) => ({ uuid: item.uuid, content: { references: [], title: 'decrypted' } })),
  )
  const service = Object.create(EncryptionService.prototype) as EncryptionService
  const encrypt = jest.fn(async (items: DecryptedPayloadInterface[]) =>
    items.map((item) => ({
      uuid: item.uuid,
      content: '004:new-ciphertext',
      enc_item_key: '004:new-key',
      items_key_id: undefined,
    })),
  )
  Object.assign(service, {
    _rootKeyDecryptPayload: { executeMany: decrypt },
    _rootKeyDecryptPayloadWithKeyLookup: { executeMany: decrypt },
    _getKeyPairs: { execute: () => ({ isFailed: () => true }) },
    _rootKeyEncryptPayload: { executeMany: encrypt },
    _rootKeyEncryptPayloadWithKeyLookup: { executeMany: encrypt },
    itemsEncryption: {
      decryptPayloads: decrypt,
      decryptPayloadsWithKeyLookup: decrypt,
      encryptPayloads: encrypt,
      encryptPayloadsWithKeyLookup: encrypt,
    },
  })
  return { service, payload, plain, decrypt, encrypt, reads: () => uuidReads }
}

it.each([1000, 2000])('packages %s decrypted results with linear original-UUID reads', async (size) => {
  const test = fixture()
  const items = Array.from({ length: size }, (_, index) => test.payload(`note-${index}`))
  const result = await test.service.decryptSplit({ usesItemsKeyWithKeyLookup: { items } })
  expect(result).toHaveLength(size)
  expect(result[0].uuid).toBe('note-0')
  expect(result[result.length - 1]?.uuid).toBe(`note-${size - 1}`)
  expect(test.reads()).toBeLessThanOrEqual(size * 4)
})

it.each([1000, 2000])('packages %s encrypted results with linear original-UUID reads', async (size) => {
  const test = fixture()
  const items = Array.from({ length: size }, (_, index) => test.plain(`note-${index}`))
  const result = await test.service.encryptSplit({ usesItemsKeyWithKeyLookup: { items } })
  expect(result).toHaveLength(size)
  expect(result[0].uuid).toBe('note-0')
  expect(result[result.length - 1]?.uuid).toBe(`note-${size - 1}`)
  expect(test.reads()).toBeLessThanOrEqual(size * 4)
})

it('preserves finder precedence across all key groups and the first duplicate in the winning group', async () => {
  const test = fixture()
  const group = (owner: string) => ({ items: [test.payload('duplicate', owner)], key: {} as never })
  const split: KeyedDecryptionSplit = {
    usesItemsKey: {
      items: [test.payload('duplicate', 'first-items'), test.payload('duplicate', 'second-items')],
      key: {} as never,
    },
    usesRootKey: group('root'),
    usesKeySystemRootKey: group('system-root'),
    usesItemsKeyWithKeyLookup: group('lookup-items'),
    usesRootKeyWithKeyLookup: group('lookup-root'),
    usesKeySystemRootKeyWithKeyLookup: group('lookup-system-root'),
  }
  for (const [key, owner] of precedence) {
    const result = await test.service.decryptSplit(split)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((payload) => payload.user_uuid === owner)).toBe(true)
    delete split[key]
  }
})

it('preserves the missing-original exception for an unexpected decryption result', async () => {
  const test = fixture()
  test.decrypt.mockResolvedValueOnce([{ uuid: 'not-in-split', content: { references: [], title: 'decrypted' } }])
  await expect(
    test.service.decryptSplit({ usesItemsKeyWithKeyLookup: { items: [test.payload('present')] } }),
  ).rejects.toThrow('Cannot find payload in encryption split')
})

it('preserves encryption finder precedence and first duplicates', async () => {
  const test = fixture()
  const group = (owner: string) => ({ items: [test.plain('duplicate', owner)], key: {} as never })
  const split: KeyedEncryptionSplit = {
    usesItemsKey: {
      items: [test.plain('duplicate', 'first-items'), test.plain('duplicate', 'second-items')],
      key: {} as never,
    },
    usesRootKey: group('root'),
    usesKeySystemRootKey: group('system-root'),
    usesItemsKeyWithKeyLookup: group('lookup-items'),
    usesRootKeyWithKeyLookup: group('lookup-root'),
    usesKeySystemRootKeyWithKeyLookup: group('lookup-system-root'),
  }
  for (const [key, owner] of precedence) {
    const result = await test.service.encryptSplit(split)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((payload) => payload.user_uuid === owner)).toBe(true)
    delete split[key]
  }
})

it('preserves the missing-original exception for an unexpected encryption result', async () => {
  const test = fixture()
  test.encrypt.mockResolvedValueOnce([
    { uuid: 'not-in-split', content: '004:new', enc_item_key: '004:key', items_key_id: undefined },
  ])
  await expect(
    test.service.encryptSplit({ usesItemsKeyWithKeyLookup: { items: [test.plain('present')] } }),
  ).rejects.toThrow('Cannot find payload in encryption split')
})

it('retains original encrypted bytes and metadata on a decryption failure', async () => {
  const test = fixture()
  test.decrypt.mockResolvedValueOnce([{ uuid: 'failure', errorDecrypting: true, waitingForKey: true }] as never)
  const result = await test.service.decryptSplit({
    usesItemsKeyWithKeyLookup: { items: [test.payload('failure', 'original-owner')] },
  })
  expect(result[0]).toBeInstanceOf(EncryptedPayload)
  expect(result[0]).toMatchObject({
    uuid: 'failure',
    user_uuid: 'original-owner',
    content: '004:fixture',
    errorDecrypting: true,
    waitingForKey: true,
  })
})
