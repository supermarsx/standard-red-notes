import { KeyParamsOrigination, ProtocolVersion } from '@standardnotes/common'
import { CreateNewRootKey } from '@standardnotes/encryption'
import { RootKeyContentSpecialized, RootKeyInterface } from '@standardnotes/models'
import { DeviceInterface } from '../Device/DeviceInterface'
import { EncryptionOperatorsInterface } from '@standardnotes/encryption'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { ReencryptTypeAItems } from '../Encryption/UseCase/TypeA/ReencryptTypeAItems'
import { StorageKey } from '../Storage/StorageKeys'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { StorageValueModes } from '../Storage/StorageTypes'
import {
  CredentialRotationBundleContent,
  CredentialRotationJournal,
  CredentialRotationPhase,
} from './CredentialRotationJournal'
import { RootKeyManager } from './RootKeyManager'
import { UuidGenerator } from '@standardnotes/utils'

describe('RootKeyManager credential rotation recovery', () => {
  let storage: jest.Mocked<StorageServiceInterface>
  let manager: RootKeyManager

  const rootContent = (masterKey: string, identifier: string): RootKeyContentSpecialized => ({
    version: ProtocolVersion.V004,
    masterKey,
    serverPassword: `server-${masterKey}`,
    keyParams: {
      version: ProtocolVersion.V004,
      identifier,
      pw_nonce: `nonce-${masterKey}`,
      origination: KeyParamsOrigination.PasswordChange,
      created: '1',
    },
    encryptionKeyPair: undefined,
    signingKeyPair: undefined,
  })

  let fixtureUuid = 0
  UuidGenerator.SetGenerator(() => `fixture-uuid-${++fixtureUuid}`)
  const currentContent = rootContent('current-master-secret', 'old@example.com')
  const newContent = rootContent('new-master-secret', 'new@example.com')
  const currentRoot = CreateNewRootKey<RootKeyInterface>(currentContent)
  const newRoot = CreateNewRootKey<RootKeyInterface>(newContent)

  const journal = {
    schemaVersion: 1,
    operationId: 'rotation-id',
    phase: CredentialRotationPhase.ServerConfirmed,
    createdAt: 1,
    bundleEncryptedByCurrentRoot: { uuid: 'current-ciphertext' },
    bundleEncryptedByNewRoot: { uuid: 'new-ciphertext' },
    rollbackPayloads: [],
  } as unknown as CredentialRotationJournal

  const bundle = {
    schemaVersion: 1,
    currentEmail: 'old@example.com',
    newEmail: 'new@example.com',
    currentRootKey: currentContent,
    newRootKey: newContent,
  } as CredentialRotationBundleContent

  beforeEach(() => {
    let uuid = 0
    UuidGenerator.SetGenerator(() => `uuid-${++uuid}`)

    storage = {
      getValue: jest.fn(),
      isStorageWrapped: jest.fn().mockReturnValue(true),
      canDecryptWithKey: jest.fn(),
      setValueAndAwaitPersist: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageServiceInterface>

    manager = new RootKeyManager(
      {} as DeviceInterface,
      storage,
      {} as EncryptionOperatorsInterface,
      'application-id',
      {} as ReencryptTypeAItems,
      {} as InternalEventBusInterface,
    )
  })

  it('selects the reciprocal root that decrypts storage after an interrupted keychain transition', async () => {
    storage.getValue.mockReturnValue(journal)
    storage.canDecryptWithKey.mockImplementation(async (key) => key.masterKey === newRoot.masterKey)

    const internals = manager as unknown as {
      decryptCredentialRotationJournalWithKey: jest.Mock
      resolveCredentialRotationRootForStorage(rootKey: RootKeyInterface): Promise<RootKeyInterface>
    }
    internals.decryptCredentialRotationJournalWithKey = jest.fn().mockResolvedValue(bundle)

    const resolved = await internals.resolveCredentialRotationRootForStorage(currentRoot)

    expect(resolved.masterKey).toBe(newRoot.masterKey)
    expect(storage.canDecryptWithKey).toHaveBeenCalledTimes(2)
  })

  it('persists only ciphertext outside wrapped storage and surfaces journal write failures', async () => {
    const currentCiphertext = { uuid: 'current-envelope', content: '004:ciphertext-a' }
    const newCiphertext = { uuid: 'new-envelope', content: '004:ciphertext-b' }
    const internals = manager as unknown as {
      encryptCredentialRotationBundle: jest.Mock
    }
    internals.encryptCredentialRotationBundle = jest
      .fn()
      .mockResolvedValueOnce(currentCiphertext)
      .mockResolvedValueOnce(newCiphertext)

    await manager.prepareCredentialRotationJournal({
      currentEmail: 'old@example.com',
      newEmail: 'new@example.com',
      currentRootKey: currentRoot,
      newRootKey: newRoot,
      rollbackPayloads: [],
    })

    const persisted = storage.setValueAndAwaitPersist.mock.calls[0][1] as CredentialRotationJournal
    expect(storage.setValueAndAwaitPersist).toHaveBeenCalledWith(
      StorageKey.CredentialRotationJournal,
      expect.any(Object),
      StorageValueModes.Nonwrapped,
    )
    expect(JSON.stringify(persisted)).not.toContain('old@example.com')
    expect(JSON.stringify(persisted)).not.toContain('current-master-secret')
    expect(JSON.stringify(persisted)).not.toContain('server-current-master-secret')

    const writeFailure = new Error('disk full')
    storage.setValueAndAwaitPersist.mockRejectedValueOnce(writeFailure)
    internals.encryptCredentialRotationBundle.mockResolvedValue(currentCiphertext)

    await expect(
      manager.prepareCredentialRotationJournal({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey: currentRoot,
        newRootKey: newRoot,
        rollbackPayloads: [],
      }),
    ).rejects.toBe(writeFailure)
  })
})
