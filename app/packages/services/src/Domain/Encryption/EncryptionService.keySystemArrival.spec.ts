import { ContentType } from '@standardnotes/domain-core'
import { DecryptedPayload, EncryptedPayload, PayloadTimestampDefaults } from '@standardnotes/models'
import { EncryptionService } from './EncryptionService'

describe('fresh-profile synced vault key arrival', () => {
  const setup = () => {
    const encrypted = (uuid: string, contentType: string) =>
      new EncryptedPayload({
        ...PayloadTimestampDefaults(),
        uuid,
        content_type: contentType,
        content: '004:fixture-ciphertext',
        enc_item_key: '004:fixture-item-key',
        items_key_id: undefined,
        errorDecrypting: true,
        waitingForKey: true,
        key_system_identifier: 'vault-scope',
      })
    let invalid = [
      encrypted('system-items-key', ContentType.TYPES.KeySystemItemsKey),
      encrypted('vault-note', ContentType.TYPES.Note),
    ]
    const order: string[] = []
    let itemsKeyRegistered = false
    let observer!: (change: { changed: unknown[]; inserted: unknown[] }) => void
    const removeObserver = jest.fn()
    const items = {
      addObserver: jest.fn((_types, callback) => {
        observer = callback
        return removeObserver
      }),
    }
    const payloads = {
      get invalidPayloads() {
        return invalid
      },
      emitPayloads: jest.fn(async (values: (EncryptedPayload | DecryptedPayload)[]) => {
        for (const value of values) {
          if (typeof value.content !== 'string') {
            invalid = invalid.filter((existing) => existing.uuid !== value.uuid)
            if (value.content_type === ContentType.TYPES.KeySystemItemsKey) {
              itemsKeyRegistered = true
              order.push('system items key registered')
              observer({ changed: [], inserted: [value] })
            }
          }
        }
      }),
    }
    const lookup = {
      executeMany: jest.fn(async () => [
        { uuid: 'system-items-key', content: { references: [] } },
      ]),
    }
    const itemEncryption = {
      decryptErroredItemPayloads: jest.fn(async () => {
        if (itemsKeyRegistered) {
          order.push('vault note decrypted')
          invalid = invalid.filter((value) => value.uuid !== 'vault-note')
        }
      }),
    }
    const unused = {} as never
    const service = new EncryptionService(
      items as never,
      unused,
      payloads as never,
      unused,
      itemEncryption as never,
      unused,
      { generateUUID: () => 'fixture-uuid' } as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      lookup as never,
      unused,
      unused,
      { addEventHandler: jest.fn() } as never,
    )
    return { service, items, lookup, itemEncryption, payloads, order, removeObserver, arrive: () => observer({ changed: [], inserted: [{}] }) }
  }

  it('automatically decrypts an earlier system items key and then its note when the root key arrives', async () => {
    const fixture = setup()
    expect(fixture.payloads.invalidPayloads).toHaveLength(2)
    expect(fixture.lookup.executeMany).not.toHaveBeenCalled()
    expect(fixture.items.addObserver).toHaveBeenCalledWith(
      [ContentType.TYPES.KeySystemRootKey, ContentType.TYPES.KeySystemItemsKey],
      expect.any(Function),
    )
    fixture.arrive()
    await fixture.service.blockDeinit()
    expect(fixture.payloads.invalidPayloads).toHaveLength(0)
    expect(fixture.order.indexOf('system items key registered')).toBeLessThan(
      fixture.order.indexOf('vault note decrypted'),
    )
    fixture.service.deinit()
  })

  it('coalesces key arrivals during a retry and waits for it before destroying account services', async () => {
    const fixture = setup()
    let finish!: (values: { uuid: string; content: { references: never[] } }[]) => void
    fixture.lookup.executeMany.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve }),
    )
    fixture.arrive()
    fixture.arrive()
    let teardownReady = false
    const blocked = fixture.service.blockDeinit().then(() => { teardownReady = true })
    await Promise.resolve()
    expect(teardownReady).toBe(false)
    expect(fixture.lookup.executeMany).toHaveBeenCalledTimes(1)
    finish([{ uuid: 'system-items-key', content: { references: [] } }])
    await blocked
    expect(teardownReady).toBe(true)
    expect(fixture.payloads.invalidPayloads).toHaveLength(0)
    fixture.service.deinit()
    expect(fixture.removeObserver).toHaveBeenCalledTimes(1)
    fixture.arrive()
    expect(fixture.lookup.executeMany).toHaveBeenCalledTimes(1)
  })
})
