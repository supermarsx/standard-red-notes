import { DecryptErroredPayloads } from './../Encryption/UseCase/DecryptErroredPayloads'
import { ReencryptTypeAItems } from './../Encryption/UseCase/TypeA/ReencryptTypeAItems'
import { EncryptionProviderInterface } from './../Encryption/EncryptionProviderInterface'
import { UserApiServiceInterface } from '@standardnotes/api'
import { KeyParamsOrigination, UserRequestType } from '@standardnotes/common'
import { User } from '@standardnotes/responses'

import {
  AlertService,
  ChallengeServiceInterface,
  InternalEventBusInterface,
  ItemManagerInterface,
  ProtectionsClientInterface,
} from '..'
import { SessionsClientInterface } from '../Session/SessionsClientInterface'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { AccountEvent } from './AccountEvent'
import { UserService } from './UserService'
import { CredentialRotationPhase } from '../RootKeyManager/CredentialRotationJournal'
import { ApplicationEvent } from '../Event/ApplicationEvent'
import { ApplicationStage } from '../Application/ApplicationStage'
import { InternalEventPublishStrategy } from '../Internal/InternalEventPublishStrategy'

describe('UserService', () => {
  let sessionManager: SessionsClientInterface
  let syncService: SyncServiceInterface
  let storageService: StorageServiceInterface
  let itemManager: ItemManagerInterface
  let encryptionService: EncryptionProviderInterface
  let alertService: AlertService
  let challengeService: ChallengeServiceInterface
  let protectionService: ProtectionsClientInterface
  let userApiService: UserApiServiceInterface
  let reencryptTypeAItems!: ReencryptTypeAItems
  let decryptErroredPayloads!: DecryptErroredPayloads
  let internalEventBus: InternalEventBusInterface

  const createService = () =>
    new UserService(
      sessionManager,
      syncService,
      storageService,
      itemManager,
      encryptionService,
      alertService,
      challengeService,
      protectionService,
      userApiService,
      reencryptTypeAItems,
      decryptErroredPayloads,
      internalEventBus,
    )

  beforeEach(() => {
    sessionManager = {} as jest.Mocked<SessionsClientInterface>
    sessionManager.getSureUser = jest.fn().mockReturnValue({ uuid: '1-2-3' } as jest.Mocked<User>)

    syncService = {} as jest.Mocked<SyncServiceInterface>

    storageService = {} as jest.Mocked<StorageServiceInterface>
    storageService.getRawPayloads = jest.fn().mockResolvedValue([])
    storageService.savePayloads = jest.fn().mockResolvedValue(undefined)
    storageService.deletePayloadsWithUuids = jest.fn().mockResolvedValue(undefined)

    itemManager = {} as jest.Mocked<ItemManagerInterface>
    itemManager.getItems = jest.fn().mockReturnValue([])
    itemManager.findItem = jest.fn()

    encryptionService = {} as jest.Mocked<EncryptionProviderInterface>
    encryptionService.prepareCredentialRotationJournal = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      operationId: 'rotation-id',
      phase: CredentialRotationPhase.Prepared,
      rollbackPayloads: [],
    })
    encryptionService.updateCredentialRotationJournal = jest.fn().mockImplementation(async (update) => ({
      schemaVersion: 1,
      operationId: 'rotation-id',
      rollbackPayloads: [],
      ...update,
    }))
    encryptionService.clearCredentialRotationJournal = jest.fn().mockResolvedValue(undefined)
    encryptionService.getCredentialRotationJournal = jest.fn()
    encryptionService.getCredentialRotationSecrets = jest.fn()

    alertService = {} as jest.Mocked<AlertService>
    alertService.alert = jest.fn().mockResolvedValue(undefined)

    challengeService = {} as jest.Mocked<ChallengeServiceInterface>

    protectionService = {} as jest.Mocked<ProtectionsClientInterface>

    userApiService = {} as jest.Mocked<UserApiServiceInterface>

    reencryptTypeAItems = {} as jest.Mocked<ReencryptTypeAItems>
    reencryptTypeAItems.execute = jest.fn().mockResolvedValue(undefined)

    decryptErroredPayloads = {} as jest.Mocked<DecryptErroredPayloads>

    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
  })

  const successSessionResponse = {
    response: {
      status: 200,
      data: {},
    },
  }

  const errorSessionResponse = (message: string) => ({
    response: {
      status: 500,
      data: {
        error: {
          message,
        },
      },
    },
  })

  const prepareCredentialChange = (neverSynced = true) => {
    const currentRootKey = {
      compare: jest.fn(),
      serverPassword: 'current-server-password',
    }
    const newRootKey = {
      compare: jest.fn(),
      serverPassword: 'new-server-password',
    }
    const localRollback = jest.fn().mockResolvedValue(undefined)

    challengeService.getWrappingKeyIfApplicable = jest.fn().mockResolvedValue({
      canceled: false,
      wrappingKey: undefined,
    })
    encryptionService.validateAccountPassword = jest.fn().mockResolvedValue({ valid: true })
    encryptionService.getRootKeyParams = jest.fn().mockReturnValue({})
    encryptionService.computeRootKey = jest.fn().mockResolvedValue(currentRootKey)
    encryptionService.createRootKey = jest.fn().mockResolvedValue(newRootKey)
    encryptionService.createNewItemsKeyWithRollback = jest.fn().mockResolvedValue(localRollback)
    encryptionService.getSureDefaultItemsKey = jest.fn().mockReturnValue({
      uuid: 'new-items-key',
      neverSynced,
    })
    sessionManager.getUser = jest.fn().mockReturnValue({
      uuid: 'user-uuid',
      email: 'old@example.com',
    })
    syncService.lockSyncing = jest.fn()
    syncService.unlockSyncing = jest.fn()
    syncService.sync = jest.fn().mockResolvedValue(undefined)
    syncService.persistPayloads = jest.fn().mockResolvedValue(undefined)

    return {
      currentRootKey,
      localRollback,
      newRootKey,
    }
  }

  it('should submit a user request to the server', async () => {
    userApiService.submitUserRequest = jest.fn().mockReturnValue({ data: { success: true } })

    expect(await createService().submitUserRequest(UserRequestType.ExitDiscount)).toBeTruthy()
  })

  it('should indicate error if submit a user request to the server fails', async () => {
    userApiService.submitUserRequest = jest.fn().mockReturnValue({ data: { success: false } })

    expect(await createService().submitUserRequest(UserRequestType.ExitDiscount)).toBeFalsy()
  })

  it('should indicate error if submit a user request to the server fails with an error on server side', async () => {
    userApiService.submitUserRequest = jest.fn().mockReturnValue({ data: { error: { message: 'fail' } } })

    expect(await createService().submitUserRequest(UserRequestType.ExitDiscount)).toBeFalsy()
  })

  it('should indicate error if submitting a user request throws an exception', async () => {
    userApiService.submitUserRequest = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(await createService().submitUserRequest(UserRequestType.ExitDiscount)).toBeFalsy()
  })

  describe('credential rotation failure safety', () => {
    const passwordChange = {
      currentPassword: 'current-password',
      newPassword: 'new-password',
      origination: KeyParamsOrigination.PasswordChange,
      validateNewPasswordStrength: true,
    }
    const emailChange = {
      currentPassword: 'current-password',
      newEmail: 'new@example.com',
      origination: KeyParamsOrigination.EmailChange,
      validateNewPasswordStrength: false,
    }

    it('unlocks syncing when the initial server or keychain update rejects', async () => {
      prepareCredentialChange()
      const failure = new Error('keychain unavailable')
      sessionManager.changeCredentials = jest.fn().mockRejectedValue(failure)

      await expect(createService().changeCredentials(passwordChange)).rejects.toBe(failure)

      expect(syncService.lockSyncing).toHaveBeenCalledTimes(1)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
      expect(encryptionService.clearCredentialRotationJournal).not.toHaveBeenCalled()
    })

    it('durably journals the reciprocal-key recovery state before contacting the server', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange(false)
      sessionManager.changeCredentials = jest.fn().mockResolvedValue(successSessionResponse)

      await createService().changeCredentials(emailChange)

      expect(encryptionService.prepareCredentialRotationJournal).toHaveBeenCalledWith({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
        wrappingKey: undefined,
        rollbackPayloads: [],
      })
      expect(
        (encryptionService.prepareCredentialRotationJournal as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan((sessionManager.changeCredentials as jest.Mock).mock.invocationCallOrder[0])
    })

    it('persists every Type-A payload before relying on the first network sync', async () => {
      prepareCredentialChange(false)
      const payloads = [{ uuid: 'items-key' }, { uuid: 'trusted-contact' }]
      itemManager.getItems = jest.fn().mockReturnValue(
        payloads.map((payload) => ({
          payloadRepresentation: () => payload,
        })),
      )
      sessionManager.changeCredentials = jest.fn().mockResolvedValue(successSessionResponse)

      await createService().changeCredentials(passwordChange)

      expect(syncService.persistPayloads).toHaveBeenCalledWith(payloads)
      expect((syncService.persistPayloads as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (syncService.sync as jest.Mock).mock.invocationCallOrder[0],
      )
      expect(encryptionService.updateCredentialRotationJournal).toHaveBeenCalledWith({
        phase: CredentialRotationPhase.LocalItemsPersisted,
        newItemsKeyUuid: 'new-items-key',
      })
      expect(encryptionService.clearCredentialRotationJournal).toHaveBeenCalledTimes(1)
    })

    it('does not apply a local rollback when the server rejects the credential rollback', async () => {
      const { localRollback } = prepareCredentialChange()
      sessionManager.changeCredentials = jest
        .fn()
        .mockResolvedValueOnce(successSessionResponse)
        .mockResolvedValueOnce(errorSessionResponse('rollback rejected'))

      const result = await createService().changeCredentials(emailChange)

      expect(result.error?.message).toBe(
        'Your credentials changed, but key synchronization did not finish and the previous credentials could not be safely restored. Keep using your new credentials and do not sign out until syncing succeeds.',
      )
      expect(sessionManager.changeCredentials).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          currentServerPassword: 'new-server-password',
          newEmail: 'old@example.com',
        }),
      )
      expect(localRollback).not.toHaveBeenCalled()
      expect(reencryptTypeAItems.execute).toHaveBeenCalledTimes(1)
      expect(syncService.sync).toHaveBeenCalledTimes(1)
      expect(syncService.lockSyncing).toHaveBeenCalledTimes(2)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(2)
      expect(encryptionService.clearCredentialRotationJournal).not.toHaveBeenCalled()
    })

    it('does not apply a local rollback when the server rollback is unconfirmed', async () => {
      const { localRollback } = prepareCredentialChange()
      sessionManager.changeCredentials = jest
        .fn()
        .mockResolvedValueOnce(successSessionResponse)
        .mockRejectedValueOnce(new Error('connection dropped'))

      const result = await createService().changeCredentials(passwordChange)

      expect(result.error?.message).toContain('did not confirm whether your previous credentials were restored')
      expect(localRollback).not.toHaveBeenCalled()
      expect(syncService.lockSyncing).toHaveBeenCalledTimes(2)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(2)
      expect(encryptionService.clearCredentialRotationJournal).not.toHaveBeenCalled()
    })

    it('reports a distinct failure when local rollback fails after server confirmation', async () => {
      const { localRollback } = prepareCredentialChange()
      localRollback.mockRejectedValue(new Error('local database unavailable'))
      sessionManager.changeCredentials = jest
        .fn()
        .mockResolvedValueOnce(successSessionResponse)
        .mockResolvedValueOnce(successSessionResponse)

      const result = await createService().changeCredentials(passwordChange)

      expect(result.error?.message).toContain(
        'server restored your previous credentials, but this device could not finish restoring',
      )
      expect(localRollback).toHaveBeenCalledTimes(1)
      expect(syncService.sync).toHaveBeenCalledTimes(1)
      expect(syncService.lockSyncing).toHaveBeenCalledTimes(2)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(2)
    })

    it('restores the original email before applying a confirmed local rollback', async () => {
      const { currentRootKey, localRollback } = prepareCredentialChange()
      sessionManager.changeCredentials = jest
        .fn()
        .mockResolvedValueOnce(successSessionResponse)
        .mockResolvedValueOnce(successSessionResponse)

      const result = await createService().changeCredentials(emailChange)

      expect(sessionManager.changeCredentials).toHaveBeenNthCalledWith(2, {
        currentServerPassword: 'new-server-password',
        newRootKey: currentRootKey,
        wrappingKey: undefined,
        newEmail: 'old@example.com',
      })
      expect(localRollback).toHaveBeenCalledTimes(1)
      expect(reencryptTypeAItems.execute).toHaveBeenCalledTimes(2)
      expect(syncService.sync).toHaveBeenCalledTimes(2)
      expect(result.error?.message).toBe('Unable to change your credentials due to a sync error. Please try again.')
      expect(encryptionService.clearCredentialRotationJournal).toHaveBeenCalledTimes(1)
    })

    it('reconciles an ambiguous prepared rotation to the new credential side before database load', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue({
        schemaVersion: 1,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.Prepared,
        rollbackPayloads: [],
      })
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      sessionManager.reconcileCredentialRotationSignIn = jest.fn().mockResolvedValue(successSessionResponse.response)

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.Launched_10,
        },
      } as never)

      expect(sessionManager.reconcileCredentialRotationSignIn).toHaveBeenCalledWith(
        'new@example.com',
        newRootKey,
        undefined,
      )
      expect(encryptionService.updateCredentialRotationJournal).toHaveBeenCalledWith({
        phase: CredentialRotationPhase.ServerConfirmed,
        newItemsKeyUuid: undefined,
      })
    })

    it('keeps a resumable server-confirmed journal when launch-time local persistence fails', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      const journal = {
        schemaVersion: 1,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.ServerConfirmed,
        rollbackPayloads: [],
      }
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue(journal)
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(newRootKey)
      newRootKey.compare.mockReturnValue(true)
      syncService.persistPayloads = jest.fn().mockRejectedValue(new Error('quota exceeded'))

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.LoadedDatabase_12,
        },
      } as never)

      expect(encryptionService.clearCredentialRotationJournal).not.toHaveBeenCalled()
    })

    it('restages the pre-rotation Type-A snapshot under the new root before database load', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      const oldCiphertext = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: '004:old-ciphertext',
        enc_item_key: '004:old-item-key',
        items_key_id: null,
        errorDecrypting: false,
        waitingForKey: false,
      }
      const decryptedPayload = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: { itemsKey: 'decrypted-only-in-memory' },
      }
      const newCiphertext = {
        ...oldCiphertext,
        content: '004:new-ciphertext',
      }
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue({
        schemaVersion: 1,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.ServerConfirmed,
        rollbackPayloads: [oldCiphertext],
      })
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(newRootKey)
      newRootKey.compare.mockReturnValue(true)
      encryptionService.decryptSplit = jest.fn().mockResolvedValue([decryptedPayload])
      encryptionService.encryptSplit = jest.fn().mockResolvedValue([newCiphertext])
      storageService.getRawPayloads = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([newCiphertext])

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.Launched_10,
        },
      } as never)

      expect(encryptionService.decryptSplit).toHaveBeenCalledWith({
        usesRootKey: {
          items: [expect.objectContaining({ uuid: 'old-items-key', content: '004:old-ciphertext' })],
          key: currentRootKey,
        },
      })
      expect(encryptionService.encryptSplit).toHaveBeenCalledWith({
        usesRootKey: {
          items: [decryptedPayload],
          key: newRootKey,
        },
      })
      expect(storageService.savePayloads).toHaveBeenCalledWith([newCiphertext])
    })

    it('restages the full rollback snapshot when a persisted new ItemsKey masks an old-root Type-A payload', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      const oldItemsKeyCiphertext = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: '004:old-items-key-ciphertext',
        enc_item_key: '004:old-items-key',
        items_key_id: null,
        errorDecrypting: false,
        waitingForKey: false,
      }
      const oldTrustedContactCiphertext = {
        uuid: 'trusted-contact',
        content_type: 'SN|TrustedContact',
        content: '004:old-trusted-contact-ciphertext',
        enc_item_key: '004:old-item-key',
        items_key_id: null,
        errorDecrypting: false,
        waitingForKey: false,
      }
      const newItemsKeyCiphertext = {
        ...oldItemsKeyCiphertext,
        content: '004:new-items-key-ciphertext',
        enc_item_key: '004:new-item-key',
      }
      const newTrustedContactCiphertext = {
        ...oldTrustedContactCiphertext,
        content: '004:new-trusted-contact-ciphertext',
        enc_item_key: '004:new-item-key',
      }
      const decryptedItemsKey = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: { itemsKey: 'decrypted-items-key' },
      }
      const decryptedTrustedContact = {
        uuid: 'trusted-contact',
        content_type: 'SN|TrustedContact',
        content: { contactUuid: 'contact-uuid' },
      }
      const journal = {
        schemaVersion: 1 as const,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.ServerConfirmed,
        rollbackPayloads: [oldItemsKeyCiphertext, oldTrustedContactCiphertext],
        newItemsKeyUuid: 'new-items-key',
      }
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue(journal)
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(newRootKey)
      newRootKey.compare.mockReturnValue(true)
      storageService.getRawPayloads = jest
        .fn()
        .mockResolvedValueOnce([newItemsKeyCiphertext, oldTrustedContactCiphertext])
        .mockResolvedValueOnce([newItemsKeyCiphertext, newTrustedContactCiphertext])
      encryptionService.decryptSplit = jest
        .fn()
        .mockResolvedValueOnce([decryptedItemsKey, oldTrustedContactCiphertext])
        .mockResolvedValueOnce([decryptedItemsKey, decryptedTrustedContact])
        .mockResolvedValueOnce([decryptedItemsKey, decryptedTrustedContact])
      encryptionService.encryptSplit = jest.fn().mockResolvedValue([newItemsKeyCiphertext, newTrustedContactCiphertext])

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.Launched_10,
        },
      } as never)

      expect(storageService.getRawPayloads).toHaveBeenNthCalledWith(1, ['old-items-key', 'trusted-contact'])
      expect(storageService.getRawPayloads).not.toHaveBeenCalledWith(['new-items-key'])
      expect(encryptionService.encryptSplit).toHaveBeenCalledWith({
        usesRootKey: {
          items: [decryptedItemsKey, decryptedTrustedContact],
          key: newRootKey,
        },
      })
      expect(storageService.savePayloads).toHaveBeenCalledWith([newItemsKeyCiphertext, newTrustedContactCiphertext])
    })

    it('does not rewrite a complete rollback snapshot that already decrypts under the new root', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      const newCiphertext = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: '004:new-ciphertext',
        enc_item_key: '004:new-item-key',
        items_key_id: null,
        errorDecrypting: false,
        waitingForKey: false,
      }
      const decryptedPayload = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: { itemsKey: 'decrypted-items-key' },
      }
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue({
        schemaVersion: 1,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.ServerConfirmed,
        rollbackPayloads: [
          {
            ...newCiphertext,
            content: '004:old-ciphertext',
            enc_item_key: '004:old-item-key',
          },
        ],
        newItemsKeyUuid: 'new-items-key',
      })
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(newRootKey)
      newRootKey.compare.mockReturnValue(true)
      storageService.getRawPayloads = jest.fn().mockResolvedValue([newCiphertext])
      encryptionService.decryptSplit = jest.fn().mockResolvedValue([decryptedPayload])
      encryptionService.encryptSplit = jest.fn()

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.Launched_10,
        },
      } as never)

      expect(encryptionService.decryptSplit).toHaveBeenCalledWith({
        usesRootKey: {
          items: [expect.objectContaining({ uuid: 'old-items-key', content: '004:new-ciphertext' })],
          key: newRootKey,
        },
      })
      expect(encryptionService.encryptSplit).not.toHaveBeenCalled()
      expect(storageService.savePayloads).not.toHaveBeenCalled()
    })

    it('restores the exact old ciphertext and removes the prepared key after confirmed rollback', async () => {
      const { currentRootKey, newRootKey } = prepareCredentialChange()
      const oldCiphertext = {
        uuid: 'old-items-key',
        content_type: 'SN|ItemsKey',
        content: '004:old-ciphertext',
        enc_item_key: '004:old-item-key',
        items_key_id: null,
        errorDecrypting: false,
        waitingForKey: false,
      }
      encryptionService.getCredentialRotationJournal = jest.fn().mockReturnValue({
        schemaVersion: 1,
        operationId: 'rotation-id',
        phase: CredentialRotationPhase.RollbackConfirmed,
        rollbackPayloads: [oldCiphertext],
        newItemsKeyUuid: 'new-items-key',
      })
      encryptionService.getCredentialRotationSecrets = jest.fn().mockResolvedValue({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        currentRootKey,
        newRootKey,
      })
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(currentRootKey)
      currentRootKey.compare.mockReturnValue(true)

      await createService().handleEvent({
        type: ApplicationEvent.ApplicationStageChanged,
        payload: {
          stage: ApplicationStage.Launched_10,
        },
      } as never)

      expect(storageService.savePayloads).toHaveBeenCalledWith([
        expect.objectContaining({ uuid: 'old-items-key', content: '004:old-ciphertext' }),
      ])
      expect(storageService.deletePayloadsWithUuids).toHaveBeenCalledWith(['new-items-key'])
      expect(encryptionService.clearCredentialRotationJournal).toHaveBeenCalledTimes(1)
    })
  })

  describe('authentication sync-lock lifecycle', () => {
    beforeEach(() => {
      encryptionService.hasAccount = jest.fn().mockReturnValue(false)
      syncService.lockSyncing = jest.fn()
      syncService.unlockSyncing = jest.fn()
    })

    it('unlocks syncing when sign-in rejects before the account event handoff', async () => {
      const failure = new Error('sign-in request failed')
      sessionManager.signIn = jest.fn().mockRejectedValue(failure)

      await expect(createService().signIn('user@example.com', 'password')).rejects.toBe(failure)

      expect(syncService.lockSyncing).toHaveBeenCalledTimes(1)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
    })

    it('returns pending email confirmation without publishing a signed-in account event', async () => {
      const response = { emailConfirmationRequired: true }
      sessionManager.register = jest.fn().mockResolvedValue(response)
      internalEventBus.publishSync = jest.fn()

      await expect(createService().register('user@example.com', 'password', '')).resolves.toBe(response)

      expect(syncService.lockSyncing).toHaveBeenCalledTimes(1)
      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
      expect(internalEventBus.publishSync).not.toHaveBeenCalled()
    })

    it('routes recovered-root sign-in through reconciliation and the normal account event lifecycle', async () => {
      const recoveredRootKey = { uuid: 'recovered-root' }
      sessionManager.reconcileCredentialRotationSignIn = jest.fn().mockResolvedValue(successSessionResponse.response)
      internalEventBus.publishSync = jest.fn().mockResolvedValue(undefined)

      const response = await createService().signInWithRecoveryRootKey(
        'person@example.com',
        recoveredRootKey as never,
        'team-a',
        false,
      )

      expect(response).toBe(successSessionResponse.response)
      expect(sessionManager.reconcileCredentialRotationSignIn).toHaveBeenCalledWith(
        'person@example.com',
        recoveredRootKey,
        undefined,
        'team-a',
      )
      expect(internalEventBus.publishSync).toHaveBeenCalledWith(
        {
          type: AccountEvent.SignedInOrRegistered,
          payload: {
            payload: {
              mergeLocal: false,
              awaitSync: true,
              ephemeral: false,
              checkIntegrity: true,
            },
          },
        },
        expect.anything(),
      )
    })

    it('rejects recovered-root sign-in when local account state already exists', async () => {
      encryptionService.hasAccount = jest.fn().mockReturnValue(true)
      sessionManager.reconcileCredentialRotationSignIn = jest.fn()

      await expect(
        createService().signInWithRecoveryRootKey('person@example.com', {} as never, 'team-a', true),
      ).rejects.toThrow(/account already exists/i)
      expect(sessionManager.reconcileCredentialRotationSignIn).not.toHaveBeenCalled()
      expect(syncService.lockSyncing).not.toHaveBeenCalled()
    })

    it('unlocks syncing when a successful sign-in event observer rejects', async () => {
      sessionManager.signIn = jest.fn().mockResolvedValue(successSessionResponse)
      const service = createService()
      service.addEventObserver(async () => {
        throw new Error('account event failed')
      })

      await expect(service.signIn('user@example.com', 'password')).rejects.toThrow('account event failed')

      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
    })

    it('unlocks syncing when corrective sign-in rejects', async () => {
      const failure = new Error('corrective sign-in failed')
      sessionManager.bypassChecksAndSignInWithRootKey = jest.fn().mockRejectedValue(failure)

      await expect(
        createService().correctiveSignIn({
          keyParams: {
            identifier: 'user@example.com',
          },
        } as never),
      ).rejects.toBe(failure)

      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
    })

    it('unlocks syncing when a corrective sign-in event observer rejects', async () => {
      sessionManager.bypassChecksAndSignInWithRootKey = jest.fn().mockResolvedValue(successSessionResponse.response)
      const service = createService()
      service.addEventObserver(async () => {
        throw new Error('corrective account event failed')
      })

      await expect(
        service.correctiveSignIn({
          keyParams: {
            identifier: 'user@example.com',
          },
        } as never),
      ).rejects.toThrow('corrective account event failed')

      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
    })

    it('unlocks syncing when signed-in account storage preparation rejects', async () => {
      const failure = new Error('database unavailable')
      syncService.resetSyncState = jest.fn()
      syncService.markAllItemsAsNeedingSyncAndPersist = jest.fn()
      syncService.downloadFirstSync = jest.fn()
      storageService.setPersistencePolicy = jest.fn().mockRejectedValue(failure)

      await expect(
        createService().handleEvent({
          type: AccountEvent.SignedInOrRegistered,
          payload: {
            payload: {
              ephemeral: false,
              mergeLocal: true,
              awaitSync: true,
              checkIntegrity: true,
            },
          },
        } as never),
      ).rejects.toBe(failure)

      expect(syncService.unlockSyncing).toHaveBeenCalledTimes(1)
      expect(syncService.markAllItemsAsNeedingSyncAndPersist).not.toHaveBeenCalled()
      expect(syncService.downloadFirstSync).not.toHaveBeenCalled()
    })
  })

  describe('recovered-root credential rotation', () => {
    it('uses the shared journaled rotation path without re-validating a discarded password', async () => {
      const { currentRootKey } = prepareCredentialChange(false)
      sessionManager.isSignedIn = jest.fn().mockReturnValue(true)
      encryptionService.getSureRootKey = jest.fn().mockReturnValue(currentRootKey)
      currentRootKey.compare.mockReturnValue(true)
      sessionManager.changeCredentials = jest.fn().mockResolvedValue(successSessionResponse)

      const result = await createService().changeCredentialsUsingProvenRootKey({
        currentRootKey: currentRootKey as never,
        newPassword: 'strong new password',
      })

      expect(result.error).toBeUndefined()
      expect(encryptionService.validateAccountPassword).not.toHaveBeenCalled()
      expect(encryptionService.computeRootKey).not.toHaveBeenCalled()
      expect(encryptionService.prepareCredentialRotationJournal).toHaveBeenCalled()
      expect(sessionManager.changeCredentials).toHaveBeenCalled()
      expect(encryptionService.clearCredentialRotationJournal).toHaveBeenCalled()
    })

    it('rejects a proven root that is not the active signed-in root', async () => {
      const { currentRootKey } = prepareCredentialChange(false)
      sessionManager.isSignedIn = jest.fn().mockReturnValue(true)
      sessionManager.changeCredentials = jest.fn()
      encryptionService.getSureRootKey = jest.fn().mockReturnValue({ compare: jest.fn().mockReturnValue(false) })

      const result = await createService().changeCredentialsUsingProvenRootKey({
        currentRootKey: currentRootKey as never,
        newPassword: 'strong new password',
      })

      expect(result.error?.message).toMatch(/invalid password/i)
      expect(encryptionService.prepareCredentialRotationJournal).not.toHaveBeenCalled()
      expect(sessionManager.changeCredentials).not.toHaveBeenCalled()
    })
  })

  describe('items-key rewrite safety', () => {
    it('replaces items-key records without deleting the durable copies first', async () => {
      const payloads = [{ uuid: 'items-key-1' }, { uuid: 'items-key-2' }]
      itemManager.getDisplayableItemsKeys = jest.fn().mockReturnValue(
        payloads.map((payload) => ({
          payloadRepresentation: () => payload,
        })),
      )
      syncService.persistPayloads = jest.fn().mockResolvedValue(undefined)
      storageService.deletePayloads = jest.fn().mockResolvedValue(undefined)

      await (
        createService() as unknown as {
          rewriteItemsKeys(): Promise<void>
        }
      ).rewriteItemsKeys()

      expect(syncService.persistPayloads).toHaveBeenCalledWith(payloads)
      expect(storageService.deletePayloads).not.toHaveBeenCalled()
    })

    it('leaves existing durable items keys intact when replacement persistence fails', async () => {
      const payload = { uuid: 'items-key-1' }
      const writeFailure = new Error('quota exceeded')
      itemManager.getDisplayableItemsKeys = jest.fn().mockReturnValue([
        {
          payloadRepresentation: () => payload,
        },
      ])
      syncService.persistPayloads = jest.fn().mockRejectedValue(writeFailure)
      storageService.deletePayloads = jest.fn().mockResolvedValue(undefined)

      await expect(
        (
          createService() as unknown as {
            rewriteItemsKeys(): Promise<void>
          }
        ).rewriteItemsKeys(),
      ).rejects.toBe(writeFailure)

      expect(storageService.deletePayloads).not.toHaveBeenCalled()
    })
  })

  describe('sign-out lifecycle barrier', () => {
    beforeEach(() => {
      sessionManager.signOut = jest.fn().mockResolvedValue(undefined)
      encryptionService.deleteWorkspaceSpecificKeyStateFromDevice = jest.fn().mockResolvedValue(undefined)
      storageService.clearAllData = jest.fn().mockResolvedValue(undefined)
      itemManager.getDirtyItems = jest.fn().mockReturnValue([])
      internalEventBus.publish = jest.fn()
      internalEventBus.publishSync = jest.fn().mockResolvedValue(undefined)
    })

    it('drains at entry and commits the write fence before clearing storage', async () => {
      await createService().signOut(true)

      expect(internalEventBus.publishSync).toHaveBeenNthCalledWith(
        1,
        { type: ApplicationEvent.PreparingForSignOut, payload: { phase: 'begin' } },
        InternalEventPublishStrategy.SEQUENCE,
      )
      expect(internalEventBus.publishSync).toHaveBeenNthCalledWith(
        2,
        { type: ApplicationEvent.PreparingForSignOut, payload: { phase: 'commit' } },
        InternalEventPublishStrategy.SEQUENCE,
      )

      const commitOrder = jest.mocked(internalEventBus.publishSync).mock.invocationCallOrder[1]
      const sessionOrder = jest.mocked(sessionManager.signOut).mock.invocationCallOrder[0]
      const clearOrder = jest.mocked(storageService.clearAllData).mock.invocationCallOrder[0]
      expect(commitOrder).toBeLessThan(sessionOrder)
      expect(sessionOrder).toBeLessThan(clearOrder)
    })

    it('fails closed before destructive work and reopens the fence when commit preparation fails', async () => {
      const failure = new Error('appearance drain failed')
      internalEventBus.publishSync = jest.fn(async (event) => {
        if ((event.payload as { phase?: string } | undefined)?.phase === 'commit') {
          throw failure
        }
      })

      await expect(createService().signOut(true)).rejects.toBe(failure)

      expect(sessionManager.signOut).not.toHaveBeenCalled()
      expect(storageService.clearAllData).not.toHaveBeenCalled()
      expect(internalEventBus.publishSync).toHaveBeenLastCalledWith(
        { type: ApplicationEvent.PreparingForSignOut, payload: { phase: 'cancel' } },
        InternalEventPublishStrategy.SEQUENCE,
      )
    })

    it('reopens appearance writes when the user cancels an unsynced sign-out', async () => {
      itemManager.getDirtyItems = jest.fn().mockReturnValue([{ uuid: 'dirty-item' }])
      alertService.confirm = jest.fn().mockResolvedValue(false)

      await createService().signOut(false)

      expect(storageService.clearAllData).not.toHaveBeenCalled()
      expect(internalEventBus.publishSync).toHaveBeenLastCalledWith(
        { type: ApplicationEvent.PreparingForSignOut, payload: { phase: 'cancel' } },
        InternalEventPublishStrategy.SEQUENCE,
      )
    })
  })
})
