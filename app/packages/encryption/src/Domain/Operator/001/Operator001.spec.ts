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
import { V001Algorithm } from '../../Algorithm'
import { SNItemsKey } from '../../Keys/ItemsKey/ItemsKey'
import { Create001KeyParams } from '../../Keys/RootKey/KeyParamsFunctions'
import { isErrorDecryptingParameters } from '../../Types/EncryptedParameters'
import { getMockedLegacyCrypto, legacyPbkdf2Output, legacySha1Output } from '../MockedLegacyCrypto'
import { SNProtocolOperator001 } from './Operator001'

/**
 * 001 is the oldest protocol still readable by this client. Nothing exercised it before this
 * file, so a refactor could have silently changed the on-the-wire framing or the key
 * derivation and the only symptom would have been an old account failing to decrypt.
 */
describe('operator 001', () => {
  /** 001 predates per-item IVs and uses a fixed all-zero IV for every AES-CBC call. */
  const NO_IV = '0'.repeat(32)

  let crypto: ReturnType<typeof getMockedLegacyCrypto>
  let operator: SNProtocolOperator001

  const buildItemsKey = (itemsKey: string): SNItemsKey =>
    new SNItemsKey(
      new DecryptedPayload<ItemsKeyContent>({
        uuid: 'items-key-uuid',
        content_type: ContentType.TYPES.ItemsKey,
        content: {
          itemsKey,
          version: ProtocolVersion.V001,
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
    operator = new SNProtocolOperator001(crypto)
  })

  it('reports version 001 and its display name', () => {
    expect(operator.version).toEqual(ProtocolVersion.V001)
    expect(operator.getEncryptionDisplayName()).toEqual('AES-256')
  })

  it('round-trips a note through encryption and back', async () => {
    const key = buildItemsKey('the-items-key')
    const payload = buildPayload()

    const encrypted = await operator.generateEncryptedParametersAsync(payload, key)
    const decrypted = await operator.generateDecryptedParametersAsync(encrypted, key)

    expect(isErrorDecryptingParameters(decrypted)).toBeFalsy()
    expect(decrypted).toMatchObject({
      uuid: 'note-uuid',
      content: { title: 'legacy note', text: 'body' },
    })
  })

  it('version-prefixes the content but not the item key, which is the asymmetry decryption compensates for', async () => {
    const key = buildItemsKey('the-items-key')

    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), key)

    expect(encrypted.content.startsWith(ProtocolVersion.V001)).toBe(true)
    /**
     * `enc_item_key` carries no prefix on the way out, and `generateDecryptedParametersAsync`
     * prepends `this.version` before stripping three characters back off. Adding a prefix here
     * without removing that compensation would truncate the ciphertext instead.
     */
    expect(encrypted.enc_item_key.startsWith(ProtocolVersion.V001)).toBe(false)
    expect(encrypted.enc_item_key.startsWith('AES.')).toBe(true)
    expect(encrypted.version).toEqual(ProtocolVersion.V001)
    expect(encrypted.items_key_id).toEqual('items-key-uuid')
  })

  it('encrypts with the fixed all-zero iv and authenticates the version-prefixed ciphertext with the item key second half', async () => {
    const key = buildItemsKey('the-items-key')

    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), key)

    const generatedItemKey = crypto.generateRandomKey.mock.results[0].value as string
    expect(crypto.generateRandomKey).toHaveBeenCalledWith(V001Algorithm.EncryptionKeyLength * 2)

    for (const call of crypto.aes256CbcEncrypt.mock.calls) {
      expect(call[1]).toEqual(NO_IV)
    }

    const authenticationKey = generatedItemKey.substring(generatedItemKey.length / 2)
    expect(crypto.hmac256).toHaveBeenCalledWith(encrypted.content, authenticationKey)
    expect(encrypted.auth_hash).toEqual(await crypto.hmac256.mock.results[0].value)
  })

  it('reports errorDecrypting, and logs only the uuid, when the item key is missing', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const decrypted = await operator.generateDecryptedParametersAsync(
        {
          uuid: 'note-uuid',
          content_type: ContentType.TYPES.Note,
          content: 'anything',
          enc_item_key: undefined as unknown as string,
          version: ProtocolVersion.V001,
          items_key_id: 'items-key-uuid',
          key_system_identifier: undefined,
          shared_vault_uuid: undefined,
        },
        buildItemsKey('the-items-key'),
      )

      expect(decrypted).toEqual({ uuid: 'note-uuid', errorDecrypting: true })
      expect(consoleError).toHaveBeenCalledWith('Missing item encryption key; skipping decryption.')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports errorDecrypting rather than garbage when the item key cannot be decrypted, and logs no ciphertext', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), buildItemsKey('right-key'))

      const decrypted = await operator.generateDecryptedParametersAsync(encrypted, buildItemsKey('wrong-key'))

      expect(decrypted).toEqual({ uuid: 'note-uuid', errorDecrypting: true })
      /** CRYPTO-2 log hygiene: the uuid, and nothing carrying ciphertext or key material. */
      expect(consoleError).toHaveBeenCalledWith('Error decrypting parameters', { uuid: 'note-uuid' })
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(encrypted.enc_item_key)
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('right-key')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports errorDecrypting when the item key opens but the content does not', async () => {
    const key = buildItemsKey('the-items-key')
    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), key)

    const decrypted = await operator.generateDecryptedParametersAsync(
      { ...encrypted, content: `${ProtocolVersion.V001}AES.not-the-derived-key.${NO_IV}.{}` },
      key,
    )

    expect(decrypted).toEqual({ uuid: 'note-uuid', errorDecrypting: true })
  })

  it('exposes no authenticated data for external use, unlike 002 and later', async () => {
    const encrypted = await operator.generateEncryptedParametersAsync(buildPayload(), buildItemsKey('k'))

    expect(operator.getPayloadAuthenticatedDataForExternalUse(encrypted)).toBeUndefined()
  })

  it('derives the root key from the stored salt and cost, splitting the output into exactly two partitions', async () => {
    const keyParams = Create001KeyParams({
      email: 'legacy@example.com',
      pw_cost: 5000,
      pw_nonce: 'the-nonce',
      pw_salt: 'the-salt',
      version: ProtocolVersion.V001,
      origination: KeyParamsOrigination.Registration,
      created: '1',
    })

    const rootKey = await operator.computeRootKey('password', keyParams)

    expect(crypto.pbkdf2).toHaveBeenCalledWith('password', 'the-salt', 5000, V001Algorithm.PbkdfOutputLength)

    const derived = legacyPbkdf2Output('password', 'the-salt', 5000, V001Algorithm.PbkdfOutputLength)
    const [serverPassword, masterKey] = splitString(derived, 2)
    expect(rootKey.serverPassword).toEqual(serverPassword)
    expect(rootKey.masterKey).toEqual(masterKey)
    /** 001 has no data authentication key; 002 introduced the third partition. */
    expect(rootKey.dataAuthenticationKey).toBeUndefined()
    expect(rootKey.keyVersion).toEqual(ProtocolVersion.V001)
  })

  it('creates a root key whose salt is sha1 of identifier + SN + nonce at the minimum cost', async () => {
    const rootKey = await operator.createRootKey('legacy@example.com', 'password', KeyParamsOrigination.Registration)

    const nonce = crypto.generateRandomKey.mock.results[0].value as string
    expect(crypto.generateRandomKey).toHaveBeenCalledWith(V001Algorithm.SaltSeedLength)
    /**
     * The separator is the literal 'SN' with no colons — 002 changed it to ':' and 003
     * replaced the whole formula. Getting it wrong derives a different key for every
     * existing 001 account.
     */
    expect(crypto.unsafeSha1).toHaveBeenCalledWith(`legacy@example.com${'SN'}${nonce}`)
    expect(crypto.pbkdf2).toHaveBeenCalledWith(
      'password',
      legacySha1Output(`legacy@example.comSN${nonce}`),
      V001Algorithm.PbkdfMinCost,
      V001Algorithm.PbkdfOutputLength,
    )
    expect(rootKey.keyVersion).toEqual(ProtocolVersion.V001)
  })

  it('creates an items key with no separate data authentication key, which 002 introduced', () => {
    const itemsKey = operator.createItemsKey()

    expect(itemsKey.keyVersion).toEqual(ProtocolVersion.V001)
    expect(itemsKey.itemsKey).toEqual(crypto.generateRandomKey.mock.results[0].value)
    expect(crypto.generateRandomKey).toHaveBeenCalledTimes(1)
    expect(crypto.generateRandomKey).toHaveBeenCalledWith(V001Algorithm.EncryptionKeyLength)
    /**
     * 001 derives its authentication key from the second half of the per-item key instead of
     * storing one on the items key. 002 stores one, and its spec asserts the other side of this.
     */
    expect(itemsKey.dataAuthenticationKey).toBeUndefined()
  })
})
