/// <reference types="jest" />

import AsyncStorage from '@react-native-async-storage/async-storage'
import { EncryptedTransferPayload, PayloadInterface, RootKeyInterface, TransferPayload } from '@standardnotes/models'
import { createMMKV } from 'react-native-mmkv'
import { ApplicationStage } from '../../../../services/src/Domain/Application/ApplicationStage'
import { EncryptionProviderInterface } from '../../../../services/src/Domain/Encryption/EncryptionProviderInterface'
import { ApplicationEvent } from '../../../../services/src/Domain/Event/ApplicationEvent'
import { CredentialRotationPhase } from '../../../../services/src/Domain/RootKeyManager/CredentialRotationJournal'
import { StorageServiceInterface } from '../../../../services/src/Domain/Storage/StorageServiceInterface'
import { UserService } from '../../../../services/src/Domain/User/UserService'
import { Database } from './Database'

const mockAsyncStorageValues = new Map<string, string>()
const mockFlashStorageValues = new Map<string, Map<string, string>>()
let mockRejectedAsyncStorageKey: string | undefined

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    clear: jest.fn(),
    getAllKeys: jest.fn(),
    getItem: jest.fn(),
    getMany: jest.fn(),
    removeItem: jest.fn(),
    removeMany: jest.fn(),
    setItem: jest.fn(),
  },
}))

jest.mock('@standardnotes/snjs', () => ({
  GetSortedPayloadsByPriority: jest.fn(),
}))

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}))

jest.mock('react-native-mmkv', () => ({
  createMMKV: jest.fn(),
}))

const encryptedPayload = (uuid: string, contentType: string, root: 'old' | 'new'): EncryptedTransferPayload => ({
  uuid,
  content_type: contentType,
  content: `004:${root}-ciphertext-${uuid}`,
  enc_item_key: `004:${root}-item-key`,
  items_key_id: undefined,
  errorDecrypting: false,
  waitingForKey: false,
  created_at: new Date(0),
  updated_at: new Date(0),
  created_at_timestamp: 0,
  updated_at_timestamp: 0,
})

const ejectPayload = (payload: PayloadInterface): TransferPayload => {
  const ejectablePayload = payload as PayloadInterface & {
    ejected?: () => TransferPayload
  }
  return ejectablePayload.ejected ? ejectablePayload.ejected() : payload
}

describe('mobile credential rotation restart recovery', () => {
  beforeEach(() => {
    mockAsyncStorageValues.clear()
    mockFlashStorageValues.clear()
    mockRejectedAsyncStorageKey = undefined

    jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === mockRejectedAsyncStorageKey) {
        mockRejectedAsyncStorageKey = undefined
        throw Error('simulated AsyncStorage write interruption')
      }
      mockAsyncStorageValues.set(key, value)
    })
    jest.mocked(AsyncStorage.getItem).mockImplementation(async (key) => mockAsyncStorageValues.get(key) ?? null)
    jest.mocked(AsyncStorage.getAllKeys).mockImplementation(async () => Array.from(mockAsyncStorageValues.keys()))
    jest.mocked(AsyncStorage.getMany).mockImplementation(async (keys) => {
      return Object.fromEntries(keys.map((key) => [key, mockAsyncStorageValues.get(key) ?? null]))
    })
    jest.mocked(AsyncStorage.removeItem).mockImplementation(async (key) => {
      mockAsyncStorageValues.delete(key)
    })
    jest.mocked(AsyncStorage.removeMany).mockImplementation(async (keys) => {
      for (const key of keys) {
        mockAsyncStorageValues.delete(key)
      }
    })
    jest.mocked(AsyncStorage.clear).mockImplementation(async () => {
      mockAsyncStorageValues.clear()
    })

    jest.mocked(createMMKV).mockImplementation((configuration) => {
      const id = configuration?.id ?? 'default'
      let values = mockFlashStorageValues.get(id)
      if (!values) {
        values = new Map()
        mockFlashStorageValues.set(id, values)
      }

      return {
        clearAll: () => values?.clear(),
        getAllKeys: () => Array.from(values?.keys() ?? []),
        getString: (key: string) => values?.get(key),
        remove: (key: string) => values?.delete(key),
        set: (key: string, value: string) => values?.set(key, value),
      } as unknown as ReturnType<typeof createMMKV>
    })
  })

  it('restages every old-root Type-A payload after a partial AsyncStorage write and process restart', async () => {
    const identifier = 'account-uuid'
    const databaseKeyPrefix = `${identifier}-Item-`
    const oldItemsKey = encryptedPayload('old-items-key', 'SN|ItemsKey', 'old')
    const oldTrustedContact = encryptedPayload('trusted-contact', 'SN|TrustedContact', 'old')
    const rollbackPayloads = [oldItemsKey, oldTrustedContact]
    const databaseBeforeInterruption = new Database(identifier)
    await databaseBeforeInterruption.setItems(rollbackPayloads)

    const newItemsKey = encryptedPayload('new-items-key', 'SN|ItemsKey', 'new')
    const rotatedItemsKey = encryptedPayload('old-items-key', 'SN|ItemsKey', 'new')
    const rotatedTrustedContact = encryptedPayload('trusted-contact', 'SN|TrustedContact', 'new')
    mockRejectedAsyncStorageKey = `${databaseKeyPrefix}trusted-contact`

    await expect(
      databaseBeforeInterruption.setItems([newItemsKey, rotatedItemsKey, rotatedTrustedContact]),
    ).rejects.toThrow('simulated AsyncStorage write interruption')

    /**
     * A fresh Database instance models the next mobile process. The durable state
     * contains the new ItemsKey and one rotated record, while the failed record is
     * still encrypted by the old root.
     */
    const databaseAfterRestart = new Database(identifier)
    const partialState = await databaseAfterRestart.multiGet<EncryptedTransferPayload>([
      'new-items-key',
      'old-items-key',
      'trusted-contact',
    ])
    expect(partialState.map((payload) => payload.uuid).sort()).toEqual([
      'new-items-key',
      'old-items-key',
      'trusted-contact',
    ])
    expect(partialState.find((payload) => payload.uuid === 'new-items-key')?.content).toContain('004:new-')
    expect(partialState.find((payload) => payload.uuid === 'old-items-key')?.content).toContain('004:new-')
    expect(partialState.find((payload) => payload.uuid === 'trusted-contact')?.content).toContain('004:old-')

    const currentRootKey = {
      compare: jest.fn().mockReturnValue(false),
    } as unknown as RootKeyInterface
    const newRootKey = {
      compare: jest.fn().mockReturnValue(true),
    } as unknown as RootKeyInterface
    const journal = {
      schemaVersion: 1 as const,
      operationId: 'rotation-id',
      phase: CredentialRotationPhase.ServerConfirmed,
      createdAt: 0,
      bundleEncryptedByCurrentRoot: encryptedPayload('current-bundle', 'SN|CredentialRotation', 'old'),
      bundleEncryptedByNewRoot: encryptedPayload('new-bundle', 'SN|CredentialRotation', 'new'),
      rollbackPayloads,
      newItemsKeyUuid: 'new-items-key',
    }
    const storageService = {
      getRawPayloads: jest.fn(async (uuids: string[]) => {
        return databaseAfterRestart.multiGet<EncryptedTransferPayload>(uuids)
      }),
      savePayloads: jest.fn(async (payloads: PayloadInterface[]) => {
        await databaseAfterRestart.setItems(payloads.map(ejectPayload))
      }),
    } as unknown as StorageServiceInterface
    const encryptionService = {
      getCredentialRotationJournal: jest.fn().mockReturnValue(journal),
      getCredentialRotationSecrets: jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      }),
      getSureRootKey: jest.fn().mockReturnValue(newRootKey),
      decryptSplit: jest.fn(async (split: Parameters<EncryptionProviderInterface['decryptSplit']>[0]) => {
        if (!split.usesRootKey) {
          throw Error('Expected an explicit root key for credential rotation recovery')
        }

        const expectedRoot = split.usesRootKey.key === newRootKey ? 'new' : 'old'
        return split.usesRootKey.items.map((payload) => {
          if (typeof payload.content !== 'string' || !payload.content.startsWith(`004:${expectedRoot}-`)) {
            return payload
          }

          return {
            ...payload.ejected(),
            content: {
              decryptedBy: expectedRoot,
            },
          }
        })
      }),
      encryptSplit: jest.fn(async (split: Parameters<EncryptionProviderInterface['encryptSplit']>[0]) => {
        if (!split.usesRootKey || split.usesRootKey.key !== newRootKey) {
          throw Error('Expected the pending new root key for credential rotation recovery')
        }

        return split.usesRootKey.items.map((payload) => encryptedPayload(payload.uuid, payload.content_type, 'new'))
      }),
    } as unknown as EncryptionProviderInterface
    const dependency = <T>(): T => {
      return {} as T
    }
    const userService = new UserService(
      dependency(),
      dependency(),
      storageService,
      dependency(),
      encryptionService,
      dependency(),
      dependency(),
      dependency(),
      dependency(),
      dependency(),
      dependency(),
      dependency(),
    )

    await userService.handleEvent({
      type: ApplicationEvent.ApplicationStageChanged,
      payload: {
        stage: ApplicationStage.Launched_10,
      },
    })

    const recoveredState = await databaseAfterRestart.multiGet<EncryptedTransferPayload>([
      'old-items-key',
      'trusted-contact',
    ])
    expect(recoveredState).toHaveLength(2)
    expect(recoveredState.every((payload) => payload.content.startsWith('004:new-'))).toBe(true)
    expect(recoveredState.some((payload) => payload.content.startsWith('004:old-'))).toBe(false)
    expect(storageService.savePayloads).toHaveBeenCalledWith([
      expect.objectContaining({ uuid: 'old-items-key' }),
      expect.objectContaining({ uuid: 'trusted-contact' }),
    ])
  })
})
