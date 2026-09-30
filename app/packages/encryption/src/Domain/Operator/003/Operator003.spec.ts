import { KeyParamsOrigination, ProtocolVersion } from '@standardnotes/common'
import { ContentType } from '@standardnotes/domain-core'
import {
  DecryptedPayload,
  DecryptedPayloadInterface,
  ItemContent,
  ItemsKeyContent,
  PayloadTimestampDefaults,
} from '@standardnotes/models'
import { splitString } from '@standardnotes/utils'
import { V003Algorithm } from '../../Algorithm'
import { SNItemsKey } from '../../Keys/ItemsKey/ItemsKey'
import { Create003KeyParams } from '../../Keys/RootKey/KeyParamsFunctions'
import { isErrorDecryptingParameters } from '../../Types/EncryptedParameters'
import { getMockedLegacyCrypto, legacyPbkdf2Output, legacySha256Output } from '../MockedLegacyCrypto'
import { SNProtocolOperator003 } from './Operator003'

/**
 * 003 keeps 002's ciphertext format and replaces the key derivation: the salt is computed
 * locally from a server-supplied nonce instead of being returned by the server, and the
 * iteration count became a constant. The salt formula is the whole account: change the
 * separator, the order, or the 'SF' literal and every existing 003 account derives a
 * different root key and can no longer be opened. Nothing exercised it before this file.
 */
describe('operator 003', () => {
  let crypto: ReturnType<typeof getMockedLegacyCrypto>
  let operator: SNProtocolOperator003

  const keyParams = () =>
    Create003KeyParams({
      identifier: 'legacy@example.com',
      pw_nonce: 'the-nonce',
      version: ProtocolVersion.V003,
      origination: KeyParamsOrigination.Registration,
      created: '1',
    })

  const expectedSaltInput = 'legacy@example.com:SF:003:110000:the-nonce'

  const buildItemsKey = (): SNItemsKey =>
    new SNItemsKey(
      new DecryptedPayload<ItemsKeyContent>({
        uuid: 'items-key-uuid',
        content_type: ContentType.TYPES.ItemsKey,
        content: {
          itemsKey: 'the-items-key',
          dataAuthenticationKey: 'the-auth-key',
          version: ProtocolVersion.V003,
        } as ItemsKeyContent,
        ...PayloadTimestampDefaults(),
      }),
    )

  const buildPayload = (): DecryptedPayloadInterface =>
    new DecryptedPayload({
      uuid: 'note-uuid',
      content_type: ContentType.TYPES.Note,
      content: { title: 'legacy note', text: 'body' } as unknown as ItemContent,
      ...PayloadTimestampDefaults(),
    })

  beforeEach(() => {
    crypto = getMockedLegacyCrypto()
    operator = new SNProtocolOperator003(crypto)
  })

  it('reports version 003 while inheriting the 002 ciphertext format', async () => {
    expect(operator.version).toEqual(ProtocolVersion.V003)

    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), buildItemsKey())

    expect(encrypted.content.split(':')).toHaveLength(5)
    /** The stamped version comes from the key, not the operator, so a 003 key stamps 003. */
    expect(encrypted.content.split(':')[0]).toEqual(ProtocolVersion.V003)
    expect(encrypted.version).toEqual(ProtocolVersion.V003)
  })

  it('round-trips a note through encryption and back', async () => {
    const key = buildItemsKey()

    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), key)
    const decrypted = await operator.generateDecryptedParametersAsync(encrypted, key)

    expect(isErrorDecryptingParameters(decrypted)).toBeFalsy()
    expect(decrypted).toMatchObject({
      uuid: 'note-uuid',
      content: { title: 'legacy note', text: 'body' },
    })
  })

  it('still rejects a payload whose authentication hash has been swapped', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const key = buildItemsKey()
      const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), key)

      const components = encrypted.content.split(':')
      components[1] = 'hmac.an-attacker-supplied-hash'

      const decrypted = await operator.generateDecryptedParametersAsync(
        { ...encrypted, content: components.join(':') },
        key,
      )

      expect(decrypted).toEqual({ uuid: 'note-uuid', errorDecrypting: true })
      expect(consoleError).toHaveBeenCalledWith('Authentication hash does not match.')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('computes the salt as sha256 of identifier, the SF literal, the version, the cost and the nonce, colon-joined in that order', async () => {
    await operator.computeRootKey('password', keyParams())

    expect(crypto.sha256).toHaveBeenCalledWith(expectedSaltInput)
    /** Spelled out rather than rebuilt from the same join, so a reordering cannot pass. */
    expect(expectedSaltInput.split(':')).toEqual([
      'legacy@example.com',
      'SF',
      '003',
      String(V003Algorithm.PbkdfCost),
      'the-nonce',
    ])
  })

  it('derives the root key at the fixed 003 cost, not a cost taken from the key params, in three partitions', async () => {
    const rootKey = await operator.computeRootKey('password', keyParams())

    /**
     * 002 read the iteration count out of the key params; 003 fixed it at 110 000. Reading it
     * from the params again would derive a different key whenever the server sent anything else.
     */
    expect(V003Algorithm.PbkdfCost).toEqual(110_000)
    expect(crypto.pbkdf2).toHaveBeenCalledWith(
      'password',
      legacySha256Output(expectedSaltInput),
      V003Algorithm.PbkdfCost,
      V003Algorithm.PbkdfOutputLength,
    )

    const derived = legacyPbkdf2Output(
      'password',
      legacySha256Output(expectedSaltInput),
      V003Algorithm.PbkdfCost,
      V003Algorithm.PbkdfOutputLength,
    )
    const [serverPassword, masterKey, dataAuthenticationKey] = splitString(derived, 3)
    expect(rootKey.serverPassword).toEqual(serverPassword)
    expect(rootKey.masterKey).toEqual(masterKey)
    expect(rootKey.dataAuthenticationKey).toEqual(dataAuthenticationKey)
    expect(rootKey.keyVersion).toEqual(ProtocolVersion.V003)
  })

  it('creates a root key from a locally generated nonce at the 003 seed length', async () => {
    const rootKey = await operator.createRootKey('legacy@example.com', 'password', KeyParamsOrigination.Registration)

    const nonce = crypto.generateRandomKey.mock.results[0].value as string
    expect(crypto.generateRandomKey).toHaveBeenCalledWith(V003Algorithm.SaltSeedLength)
    /** 001 and 002 hashed with sha1; 003 moved to sha256 and never calls sha1. */
    expect(crypto.sha256).toHaveBeenCalledWith(`legacy@example.com:SF:003:${V003Algorithm.PbkdfCost}:${nonce}`)
    expect(crypto.unsafeSha1).not.toHaveBeenCalled()
    expect(rootKey.keyVersion).toEqual(ProtocolVersion.V003)
    expect(rootKey.keyParams.version).toEqual(ProtocolVersion.V003)
    /** 003 identifies the account by `identifier`, where 001 and 002 used `email`. */
    expect(rootKey.keyParams.identifier).toEqual('legacy@example.com')
  })

  it('creates a 003 items key with both an items key and a data authentication key', () => {
    const itemsKey = operator.createItemsKey()

    expect(itemsKey.keyVersion).toEqual(ProtocolVersion.V003)
    expect(itemsKey.itemsKey).toEqual(crypto.generateRandomKey.mock.results[0].value)
    expect(itemsKey.dataAuthenticationKey).toEqual(crypto.generateRandomKey.mock.results[1].value)
    expect(crypto.generateRandomKey).toHaveBeenNthCalledWith(1, V003Algorithm.EncryptionKeyLength)
    expect(crypto.generateRandomKey).toHaveBeenNthCalledWith(2, V003Algorithm.EncryptionKeyLength)
    expect(itemsKey.content_type).toEqual(ContentType.TYPES.ItemsKey)
  })
})
