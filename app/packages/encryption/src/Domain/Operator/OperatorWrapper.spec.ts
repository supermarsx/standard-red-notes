import {
  DecryptedPayload,
  EncryptedPayloadInterface,
  ItemsKeyContent,
  PayloadTimestampDefaults,
  ProtocolVersion,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { decryptPayload } from './OperatorWrapper'
import { EncryptionOperatorsInterface } from './EncryptionOperatorsInterface'
import { SNItemsKey } from '../Keys/ItemsKey/ItemsKey'
import { isErrorDecryptingParameters } from '../Types/EncryptedParameters'

describe('OperatorWrapper.decryptPayload — CRYPTO-1 downgrade hardening', () => {
  const buildItemsKey = (version: ProtocolVersion): SNItemsKey =>
    new SNItemsKey(
      new DecryptedPayload<ItemsKeyContent>({
        uuid: 'items-key',
        content_type: ContentType.TYPES.ItemsKey,
        content: {
          itemsKey: 'the-key',
          version,
        } as ItemsKeyContent,
        ...PayloadTimestampDefaults(),
      }),
    )

  const buildEncryptedPayload = (version: ProtocolVersion): EncryptedPayloadInterface =>
    ({
      uuid: 'note-uuid',
      version,
      content: 'some-ciphertext',
      content_type: ContentType.TYPES.Note,
      enc_item_key: 'enc-item-key',
      items_key_id: 'items-key',
      key_system_identifier: undefined,
      shared_vault_uuid: undefined,
      signatureData: undefined,
    }) as unknown as EncryptedPayloadInterface

  const buildOperatorManager = (): EncryptionOperatorsInterface => {
    const operator = {
      generateDecryptedParameters: jest.fn().mockReturnValue({ uuid: 'note-uuid', content: {} }),
    }
    return {
      operatorForVersion: jest.fn().mockReturnValue(operator),
      defaultOperator: jest.fn(),
      deinit: jest.fn(),
    } as unknown as EncryptionOperatorsInterface
  }

  it('refuses to decrypt a downgraded payload (003 content) when the trusted key is 004', async () => {
    const manager = buildOperatorManager()
    const key004 = buildItemsKey(ProtocolVersion.V004)
    const downgraded = buildEncryptedPayload(ProtocolVersion.V003)

    const result = await decryptPayload(downgraded, key004, manager)

    expect(isErrorDecryptingParameters(result)).toBeTruthy()
    // The operator must never even be selected/invoked for a downgraded payload.
    expect(manager.operatorForVersion).not.toHaveBeenCalled()
  })

  it('allows normal 004 decrypt (payload version equals key version)', async () => {
    const manager = buildOperatorManager()
    const key004 = buildItemsKey(ProtocolVersion.V004)
    const payload004 = buildEncryptedPayload(ProtocolVersion.V004)

    const result = await decryptPayload(payload004, key004, manager)

    expect(isErrorDecryptingParameters(result)).toBeFalsy()
    expect(manager.operatorForVersion).toHaveBeenCalledWith(ProtocolVersion.V004)
  })

  it('allows legitimate migration decrypt of a 003 payload with a 003 key (same version)', async () => {
    const manager = buildOperatorManager()
    const key003 = buildItemsKey(ProtocolVersion.V003)
    const payload003 = buildEncryptedPayload(ProtocolVersion.V003)

    const result = await decryptPayload(payload003, key003, manager)

    expect(isErrorDecryptingParameters(result)).toBeFalsy()
    expect(manager.operatorForVersion).toHaveBeenCalledWith(ProtocolVersion.V003)
  })

  it('allows a newer payload version than the key (never weaker), e.g. 004 payload with legacy key', async () => {
    const manager = buildOperatorManager()
    const key003 = buildItemsKey(ProtocolVersion.V003)
    const payload004 = buildEncryptedPayload(ProtocolVersion.V004)

    const result = await decryptPayload(payload004, key003, manager)

    expect(isErrorDecryptingParameters(result)).toBeFalsy()
  })

  it('CRYPTO-2: on decrypt error, logs only uuid + message, never the ciphertext payload', async () => {
    const manager = buildOperatorManager()
    ;(manager.operatorForVersion as jest.Mock).mockReturnValue({
      generateDecryptedParameters: jest.fn(() => {
        throw new Error('boom')
      }),
    })
    const key004 = buildItemsKey(ProtocolVersion.V004)
    const payload004 = buildEncryptedPayload(ProtocolVersion.V004)

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await decryptPayload(payload004, key004, manager)

    expect(isErrorDecryptingParameters(result)).toBeTruthy()

    const loggedArgs = errorSpy.mock.calls[errorSpy.mock.calls.length - 1]
    const serialized = JSON.stringify(loggedArgs)
    expect(serialized).toContain('note-uuid')
    expect(serialized).toContain('boom')
    // No sensitive material may appear in the log.
    expect(serialized).not.toContain('some-ciphertext')
    expect(serialized).not.toContain('enc-item-key')

    errorSpy.mockRestore()
  })
})
