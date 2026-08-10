import { Base64String } from '@standardnotes/sncrypto-common'
import { SNRootKey, SNRootKeyParams } from '@standardnotes/encryption'
import {
  HttpResponse,
  SignInResponse,
  User,
  getErrorFromErrorResponse,
  isErrorResponse,
} from '@standardnotes/responses'
import { KeyParamsOrigination, UserRequestType } from '@standardnotes/common'
import { UuidGenerator } from '@standardnotes/utils'
import { UserApiServiceInterface, UserRegistrationResponseBody } from '@standardnotes/api'
import * as Messages from '../Strings/Messages'
import { InfoStrings } from '../Strings/InfoStrings'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { ItemManagerInterface } from '../Item/ItemManagerInterface'
import { AlertService } from '../Alert/AlertService'
import {
  Challenge,
  ChallengePrompt,
  ChallengeReason,
  ChallengeServiceInterface,
  ChallengeValidation,
} from '../Challenge'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { AbstractService } from '../Service/AbstractService'
import { UserServiceInterface } from './UserServiceInterface'
import { DeinitSource } from '../Application/DeinitSource'
import { StoragePersistencePolicies } from '../Storage/StorageTypes'
import { SessionsClientInterface } from '../Session/SessionsClientInterface'
import { ProtectionsClientInterface } from '../Protection/ProtectionClientInterface'
import { InternalEventHandlerInterface } from '../Internal/InternalEventHandlerInterface'
import { InternalEventInterface } from '../Internal/InternalEventInterface'
import { AccountEventData } from './AccountEventData'
import { AccountEvent } from './AccountEvent'
import { SignedInOrRegisteredEventPayload } from './SignedInOrRegisteredEventPayload'
import { CredentialsChangeFunctionResponse } from './CredentialsChangeFunctionResponse'
import { EncryptionProviderInterface } from '../Encryption/EncryptionProviderInterface'
import { ReencryptTypeAItems } from '../Encryption/UseCase/TypeA/ReencryptTypeAItems'
import { DecryptErroredPayloads } from '../Encryption/UseCase/DecryptErroredPayloads'
import { ApplicationEvent } from '../Event/ApplicationEvent'
import { ApplicationStageChangedEventPayload } from '../Event/ApplicationStageChangedEventPayload'
import { ApplicationStage } from '../Application/ApplicationStage'
import {
  CredentialRotationJournal,
  CredentialRotationPhase,
  CredentialRotationSecrets,
} from '../RootKeyManager/CredentialRotationJournal'
import {
  ContentTypesUsingRootKeyEncryption,
  EncryptedPayload,
  isDecryptedPayload,
  isEncryptedTransferPayload,
  RootKeyInterface,
} from '@standardnotes/models'

const cleanedEmailString = (email: string) => {
  return email.trim().toLowerCase()
}

export class UserService
  extends AbstractService<AccountEvent, AccountEventData>
  implements UserServiceInterface, InternalEventHandlerInterface
{
  private signingIn = false
  private registering = false
  private resumingCredentialRotation = false

  private readonly MINIMUM_PASSCODE_LENGTH = 1
  private readonly MINIMUM_PASSWORD_LENGTH = 8

  constructor(
    private sessions: SessionsClientInterface,
    private sync: SyncServiceInterface,
    private storage: StorageServiceInterface,
    private items: ItemManagerInterface,
    private encryption: EncryptionProviderInterface,
    private alerts: AlertService,
    private challenges: ChallengeServiceInterface,
    private protections: ProtectionsClientInterface,
    private userApi: UserApiServiceInterface,
    private _reencryptTypeAItems: ReencryptTypeAItems,
    private _decryptErroredPayloads: DecryptErroredPayloads,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  public override deinit(): void {
    super.deinit()
    ;(this.sessions as unknown) = undefined
    ;(this.sync as unknown) = undefined
    ;(this.storage as unknown) = undefined
    ;(this.items as unknown) = undefined
    ;(this.encryption as unknown) = undefined
    ;(this.alerts as unknown) = undefined
    ;(this.challenges as unknown) = undefined
    ;(this.protections as unknown) = undefined
    ;(this.userApi as unknown) = undefined
    ;(this._reencryptTypeAItems as unknown) = undefined
    ;(this._decryptErroredPayloads as unknown) = undefined
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === AccountEvent.SignedInOrRegistered) {
      const payload = (event.payload as AccountEventData).payload as SignedInOrRegisteredEventPayload
      this.sync.resetSyncState()

      try {
        await this.storage.setPersistencePolicy(
          payload.ephemeral ? StoragePersistencePolicies.Ephemeral : StoragePersistencePolicies.Default,
        )

        if (payload.mergeLocal) {
          await this.sync.markAllItemsAsNeedingSyncAndPersist()
        } else {
          void this.items.removeAllItemsFromMemory()
          await this.clearDatabase()
        }
      } finally {
        /**
         * This event is the success-path handoff for register/sign-in. Storage
         * preparation can fail before the download sync begins; never leave the
         * caller's client lock set when that happens.
         */
        this.unlockSyncing()
      }

      const syncPromise = this.sync
        .downloadFirstSync(1_000, {
          checkIntegrity: payload.checkIntegrity,
          awaitAll: payload.awaitSync,
        })
        .then(() => {
          if (!payload.awaitSync) {
            void this._decryptErroredPayloads.execute()
          }
        })

      if (payload.awaitSync) {
        await syncPromise

        await this._decryptErroredPayloads.execute()
      }
    } else if (event.type === ApplicationEvent.ApplicationStageChanged) {
      const stage = (event.payload as ApplicationStageChangedEventPayload).stage
      if (stage === ApplicationStage.Launched_10) {
        await this.resumeCredentialRotationBeforeDatabaseLoad()
      } else if (stage === ApplicationStage.LoadedDatabase_12) {
        await this.resumeCredentialRotationAfterDatabaseLoad()
      }
    }
  }

  get user(): User | undefined {
    return this.sessions.getUser()
  }

  get sureUser(): User {
    return this.sessions.getSureUser()
  }

  getUserUuid(): string {
    return this.sessions.userUuid
  }

  isSignedIn(): boolean {
    return this.sessions.isSignedIn()
  }

  /**
   *  @param mergeLocal  Whether to merge existing offline data into account. If false,
   *                     any pre-existing data will be fully deleted upon success.
   */
  public async register(
    email: string,
    password: string,
    hvmToken: string,
    ephemeral = false,
    mergeLocal = true,
    // Standard Red Notes: optional workspace name for "multiple accounts per
    // email" (WORKSPACES_PER_EMAIL_ENABLED). Trailing optional param so existing
    // callers are unaffected; ignored by the server unless the flag is on.
    workspaceIdentifier?: string,
    // Standard Red Notes: optional invite-URL token (INVITE-URL signup control).
    // Trailing optional param so existing callers are unaffected.
    inviteToken?: string,
  ): Promise<UserRegistrationResponseBody> {
    if (this.encryption.hasAccount()) {
      throw Error('Tried to register when an account already exists.')
    }

    if (this.registering) {
      throw Error('Already registering.')
    }

    this.registering = true

    try {
      this.lockSyncing()
      const response = await this.sessions.register(
        email,
        password,
        hvmToken,
        ephemeral,
        workspaceIdentifier,
        inviteToken,
      )

      // Standard Red Notes: APPROVAL / waitlist queue. A pending-approval signup
      // never established a session (SessionManager returned early with no root
      // key), so there is nothing to sync or set up — skip the account-setup event
      // and hand the terminal response back for the UI to show "awaiting approval".
      if (response.pendingApproval || response.emailConfirmationRequired) {
        this.unlockSyncing()
        this.registering = false

        return response
      }

      await this.notifyEventSync(AccountEvent.SignedInOrRegistered, {
        payload: {
          ephemeral,
          mergeLocal,
          awaitSync: true,
          checkIntegrity: false,
        },
      })

      this.registering = false

      return response
    } catch (error) {
      this.unlockSyncing()
      this.registering = false

      throw error
    }
  }

  /**
   * @param mergeLocal  Whether to merge existing offline data into account.
   * If false, any pre-existing data will be fully deleted upon success.
   */
  public async signIn(
    email: string,
    password: string,
    strict = false,
    ephemeral = false,
    mergeLocal = true,
    awaitSync = false,
    hvmToken?: string,
    // Standard Red Notes: optional workspace name for "multiple accounts per
    // email" (WORKSPACES_PER_EMAIL_ENABLED). Trailing optional param so existing
    // callers are unaffected; ignored by the server unless the flag is on.
    workspaceIdentifier?: string,
  ): Promise<HttpResponse<SignInResponse>> {
    if (this.encryption.hasAccount()) {
      throw Error('Tried to sign in when an account already exists.')
    }

    if (this.signingIn) {
      throw Error('Already signing in.')
    }

    this.signingIn = true

    try {
      /** Prevent a timed sync from occuring while signing in. */
      this.lockSyncing()

      const { response } = await this.sessions.signIn(
        email,
        password,
        strict,
        ephemeral,
        undefined,
        hvmToken,
        workspaceIdentifier,
      )

      if (!isErrorResponse(response)) {
        const notifyingFunction = awaitSync ? this.notifyEventSync.bind(this) : this.notifyEvent.bind(this)
        await notifyingFunction(AccountEvent.SignedInOrRegistered, {
          payload: {
            mergeLocal,
            awaitSync,
            ephemeral,
            checkIntegrity: true,
          },
        })
      } else {
        this.unlockSyncing()
      }

      return response
    } catch (error) {
      /**
       * A successful SignedInOrRegistered event unlocks syncing from handleEvent
       * after account storage has been prepared. Rejections never complete that
       * handoff, so release the client lock before propagating the failure.
       */
      this.unlockSyncing()
      throw error
    } finally {
      this.signingIn = false
    }
  }

  public async signInWithRecoveryRootKey(
    identifier: string,
    rootKey: RootKeyInterface,
    workspaceIdentifier: string,
    mergeLocal: boolean,
    awaitSync = true,
  ): Promise<HttpResponse<SignInResponse>> {
    if (this.encryption.hasAccount()) {
      throw Error('Tried to recover an account when an account already exists.')
    }
    if (this.signingIn) {
      throw Error('Already signing in.')
    }

    this.signingIn = true
    this.lockSyncing()
    try {
      const response = await this.sessions.reconcileCredentialRotationSignIn(
        identifier,
        rootKey,
        undefined,
        workspaceIdentifier,
      )
      if (isErrorResponse(response)) {
        this.unlockSyncing()
        return response
      }

      const notifyingFunction = awaitSync ? this.notifyEventSync.bind(this) : this.notifyEvent.bind(this)
      await notifyingFunction(AccountEvent.SignedInOrRegistered, {
        payload: {
          mergeLocal,
          awaitSync,
          ephemeral: false,
          checkIntegrity: true,
        },
      })

      return response
    } catch (error) {
      this.unlockSyncing()
      throw error
    } finally {
      this.signingIn = false
    }
  }

  public async deleteAccount(): Promise<{
    error: boolean
    message?: string
  }> {
    const { success, challengeResponse } = await this.protections.authorizeAccountDeletion()

    if (!success) {
      return {
        error: true,
        message: Messages.INVALID_PASSWORD,
      }
    }

    const uuid = this.sessions.getSureUser().uuid
    const password = challengeResponse?.getValueForType(ChallengeValidation.AccountPassword).value as string
    const currentRootKey = await this.encryption.computeRootKey(
      password,
      this.encryption.getRootKeyParams() as SNRootKeyParams,
    )
    const serverPassword = currentRootKey.serverPassword
    const response = await this.userApi.deleteAccount({ userUuid: uuid, serverPassword: serverPassword })
    if (isErrorResponse(response)) {
      return {
        error: true,
        message: getErrorFromErrorResponse(response).message,
      }
    }

    await this.signOut(true)

    if (this.alerts) {
      void this.alerts.alert(InfoStrings.AccountDeleted)
    }

    return {
      error: false,
    }
  }

  async submitUserRequest(requestType: UserRequestType): Promise<boolean> {
    const userUuid = this.sessions.getSureUser().uuid
    try {
      const result = await this.userApi.submitUserRequest({
        userUuid,
        requestType,
      })

      if (isErrorResponse(result)) {
        return false
      }

      return result.data.success
    } catch {
      return false
    }
  }

  /**
   * A sign in request that occurs while the user was previously signed in, to correct
   * for missing keys or storage values. Unlike regular sign in, this doesn't worry about
   * performing one of marking all items as needing sync or deleting all local data.
   */
  public async correctiveSignIn(rootKey: SNRootKey): Promise<HttpResponse<SignInResponse>> {
    this.lockSyncing()
    try {
      const response = await this.sessions.bypassChecksAndSignInWithRootKey(
        rootKey.keyParams.identifier,
        rootKey,
        false,
      )

      if (!isErrorResponse(response)) {
        await this.notifyEvent(AccountEvent.SignedInOrRegistered, {
          payload: {
            mergeLocal: true,
            awaitSync: true,
            ephemeral: false,
            checkIntegrity: true,
          },
        })
      }

      return response
    } finally {
      /**
       * handleEvent also unlocks on the successful event path; the underlying
       * boolean lock is idempotent. The finally protects rejected auth/event
       * paths that otherwise leave all subsequent sync attempts disabled.
       */
      this.unlockSyncing()
    }
  }

  /**
   * @param passcode - Changing the account password or email requires the local
   * passcode if configured (to rewrap the account key with passcode). If the passcode
   * is not passed in, the user will be prompted for the passcode. However if the consumer
   * already has reference to the passcode, they can pass it in here so that the user
   * is not prompted again.
   */
  public async changeCredentials(parameters: {
    currentPassword: string
    origination: KeyParamsOrigination
    validateNewPasswordStrength: boolean
    newEmail?: string
    newPassword?: string
    passcode?: string
  }): Promise<CredentialsChangeFunctionResponse> {
    const result = await this.performCredentialsChange(parameters)
    if (result.error) {
      void this.alerts.alert(result.error.message)
    }
    return result
  }

  public async changeCredentialsUsingProvenRootKey(parameters: {
    currentRootKey: RootKeyInterface
    newPassword: string
    passcode?: string
  }): Promise<CredentialsChangeFunctionResponse> {
    return this.performCredentialsChange({
      currentPassword: undefined,
      provenCurrentRootKey: parameters.currentRootKey,
      origination: KeyParamsOrigination.PasswordChange,
      validateNewPasswordStrength: true,
      newPassword: parameters.newPassword,
      passcode: parameters.passcode,
    })
  }

  public async signOut(force = false, source = DeinitSource.SignOut): Promise<void> {
    const performSignOut = async () => {
      await this.sessions.signOut()
      await this.encryption.deleteWorkspaceSpecificKeyStateFromDevice()
      await this.storage.clearAllData()
      await this.notifyEvent(AccountEvent.SignedOut, { payload: { source } })
    }

    if (force) {
      await performSignOut()

      return
    }

    const dirtyItems = this.items.getDirtyItems()
    if (dirtyItems.length > 0) {
      const singular = dirtyItems.length === 1
      const didConfirm = await this.alerts.confirm(
        `There ${singular ? 'is' : 'are'} ${dirtyItems.length} ${
          singular ? 'item' : 'items'
        } with unsynced changes. If you sign out, these changes will be lost forever. Are you sure you want to sign out?`,
      )
      if (didConfirm) {
        await performSignOut()
      }
    } else {
      await performSignOut()
    }
  }

  async updateAccountWithFirstTimeKeyPair(): Promise<{
    success?: true
    canceled?: true
    error?: { message: string }
  }> {
    if (!this.sessions.isUserMissingKeyPair()) {
      throw Error('Cannot update account with first time keypair if user already has a keypair')
    }

    const result = await this.performProtocolUpgrade()

    return result
  }

  public async performProtocolUpgrade(): Promise<{
    success?: true
    canceled?: true
    error?: { message: string }
  }> {
    const hasPasscode = this.encryption.hasPasscode()
    const hasAccount = this.encryption.hasAccount()
    const prompts = []
    if (hasPasscode) {
      prompts.push(
        new ChallengePrompt(
          ChallengeValidation.LocalPasscode,
          undefined,
          Messages.ChallengeStrings.LocalPasscodePlaceholder,
        ),
      )
    }
    if (hasAccount) {
      prompts.push(
        new ChallengePrompt(
          ChallengeValidation.AccountPassword,
          undefined,
          Messages.ChallengeStrings.AccountPasswordPlaceholder,
        ),
      )
    }
    const challenge = new Challenge(prompts, ChallengeReason.ProtocolUpgrade, true)
    const response = await this.challenges.promptForChallengeResponse(challenge)
    if (!response) {
      return { canceled: true }
    }
    const dismissBlockingDialog = await this.alerts.blockingDialog(
      Messages.DO_NOT_CLOSE_APPLICATION,
      Messages.UPGRADING_ENCRYPTION,
    )
    try {
      let passcode: string | undefined
      if (hasPasscode) {
        /* Upgrade passcode version */
        const value = response.getValueForType(ChallengeValidation.LocalPasscode)
        passcode = value.value as string
      }
      if (hasAccount) {
        /* Upgrade account version */
        const value = response.getValueForType(ChallengeValidation.AccountPassword)
        const password = value.value as string
        const changeResponse = await this.changeCredentials({
          currentPassword: password,
          newPassword: password,
          passcode,
          origination: KeyParamsOrigination.ProtocolUpgrade,
          validateNewPasswordStrength: false,
        })
        if (changeResponse?.error) {
          return { error: changeResponse.error }
        }
      }
      if (hasPasscode) {
        /* Upgrade passcode version */
        await this.removePasscodeWithoutWarning()
        await this.setPasscodeWithoutWarning(passcode as string, KeyParamsOrigination.ProtocolUpgrade)
      }
      return { success: true }
    } catch (error) {
      return { error: error as Error }
    } finally {
      dismissBlockingDialog()
    }
  }

  public async addPasscode(passcode: string): Promise<boolean> {
    if (passcode.length < this.MINIMUM_PASSCODE_LENGTH) {
      return false
    }
    if (!(await this.protections.authorizeAddingPasscode())) {
      return false
    }

    const dismissBlockingDialog = await this.alerts.blockingDialog(
      Messages.DO_NOT_CLOSE_APPLICATION,
      Messages.SETTING_PASSCODE,
    )
    try {
      await this.setPasscodeWithoutWarning(passcode, KeyParamsOrigination.PasscodeCreate)
      return true
    } finally {
      dismissBlockingDialog()
    }
  }

  public async removePasscode(): Promise<boolean> {
    if (!(await this.protections.authorizeRemovingPasscode())) {
      return false
    }

    const dismissBlockingDialog = await this.alerts.blockingDialog(
      Messages.DO_NOT_CLOSE_APPLICATION,
      Messages.REMOVING_PASSCODE,
    )
    try {
      await this.removePasscodeWithoutWarning()
      return true
    } finally {
      dismissBlockingDialog()
    }
  }

  /**
   * @returns whether the passcode was successfuly changed or not
   */
  public async changePasscode(
    newPasscode: string,
    origination = KeyParamsOrigination.PasscodeChange,
  ): Promise<boolean> {
    if (newPasscode.length < this.MINIMUM_PASSCODE_LENGTH) {
      return false
    }
    if (!(await this.protections.authorizeChangingPasscode())) {
      return false
    }

    const dismissBlockingDialog = await this.alerts.blockingDialog(
      Messages.DO_NOT_CLOSE_APPLICATION,
      origination === KeyParamsOrigination.ProtocolUpgrade
        ? Messages.ProtocolUpgradeStrings.UpgradingPasscode
        : Messages.CHANGING_PASSCODE,
    )
    try {
      await this.removePasscodeWithoutWarning()
      await this.setPasscodeWithoutWarning(newPasscode, origination)
      return true
    } finally {
      dismissBlockingDialog()
    }
  }

  public async populateSessionFromDemoShareToken(token: Base64String): Promise<void> {
    await this.sessions.populateSessionFromDemoShareToken(token)
    await this.notifyEvent(AccountEvent.SignedInOrRegistered, {
      payload: {
        ephemeral: false,
        mergeLocal: false,
        checkIntegrity: false,
        awaitSync: true,
      },
    })
  }

  private async setPasscodeWithoutWarning(passcode: string, origination: KeyParamsOrigination) {
    const identifier = UuidGenerator.GenerateUuid()
    const key = await this.encryption.createRootKey(identifier, passcode, origination)
    await this.encryption.setNewRootKeyWrapper(key)
    await this.rewriteItemsKeys()
    await this.sync.sync()
  }

  private async removePasscodeWithoutWarning() {
    await this.encryption.removePasscode()
    await this.rewriteItemsKeys()
  }

  /**
   * Rewrites items keys in place after a local credential-status change. The
   * storage save replaces records with the same UUID, so deleting the only
   * durable copies first is both unnecessary and unsafe: a quota/transaction
   * failure between delete and save could make the vault undecryptable.
   */
  private async rewriteItemsKeys(): Promise<void> {
    const itemsKeys = this.items.getDisplayableItemsKeys()
    const payloads = itemsKeys.map((key) => key.payloadRepresentation())
    await this.sync.persistPayloads(payloads)
  }

  /**
   * A root-key transition affects every Type-A payload, not only the default
   * items key. Persist their current decrypted representations before relying on
   * a network sync so a process restart never depends on an in-memory rewrite.
   */
  private async persistTypeAItems(): Promise<void> {
    const items = this.items.getItems(ContentTypesUsingRootKeyEncryption())
    await this.sync.persistPayloads(items.map((item) => item.payloadRepresentation()))
  }

  private lockSyncing(): void {
    this.sync.lockSyncing()
  }

  private unlockSyncing(): void {
    this.sync.unlockSyncing()
  }

  private clearDatabase(): Promise<void> {
    return this.storage.clearAllPayloads()
  }

  private async performCredentialsChange(parameters: {
    currentPassword: string | undefined
    provenCurrentRootKey?: RootKeyInterface
    origination: KeyParamsOrigination
    validateNewPasswordStrength: boolean
    newEmail?: string
    newPassword?: string
    passcode?: string
  }): Promise<CredentialsChangeFunctionResponse> {
    const { wrappingKey, canceled } = await this.challenges.getWrappingKeyIfApplicable(parameters.passcode)

    if (canceled) {
      return { error: Error(Messages.CredentialsChangeStrings.PasscodeRequired) }
    }

    if (parameters.newPassword !== undefined && parameters.validateNewPasswordStrength) {
      if (parameters.newPassword.length < this.MINIMUM_PASSWORD_LENGTH) {
        return {
          error: Error(Messages.InsufficientPasswordMessage(this.MINIMUM_PASSWORD_LENGTH)),
        }
      }
    }

    if (parameters.provenCurrentRootKey) {
      if (!this.sessions.isSignedIn() || !this.encryption.getSureRootKey().compare(parameters.provenCurrentRootKey)) {
        return { error: Error(Messages.INVALID_PASSWORD) }
      }
    } else {
      const accountPasswordValidation = await this.encryption.validateAccountPassword(
        parameters.currentPassword as string,
      )
      if (!accountPasswordValidation.valid) {
        return {
          error: Error(Messages.INVALID_PASSWORD),
        }
      }
    }

    const newEmail = parameters.newEmail ? cleanedEmailString(parameters.newEmail) : undefined

    const user = this.sessions.getUser() as User
    const currentEmail = user.email
    const { currentRootKey, newRootKey } = await this.recomputeRootKeysForCredentialChange({
      currentPassword: parameters.currentPassword,
      currentRootKey: parameters.provenCurrentRootKey,
      currentEmail,
      origination: parameters.origination,
      newEmail: newEmail,
      newPassword: parameters.newPassword,
    })

    this.lockSyncing()
    let response
    try {
      /**
       * Flush the pre-rotation Type-A state first, then snapshot its exact
       * ciphertext. The snapshot is the rollback half of the transaction and is
       * also enough to stage new-root ciphertext before database load on resume.
       */
      await this.persistTypeAItems()
      const typeAUuids = this.items.getItems(ContentTypesUsingRootKeyEncryption()).map((item) => item.uuid)
      const rawRollbackPayloads = await this.storage.getRawPayloads(typeAUuids)
      if (!rawRollbackPayloads.every(isEncryptedTransferPayload)) {
        throw Error('Unable to create an encrypted credential rotation rollback snapshot.')
      }
      const rollbackPayloads = rawRollbackPayloads
      await this.encryption.prepareCredentialRotationJournal({
        currentEmail,
        newEmail: newEmail ?? currentEmail,
        currentRootKey,
        newRootKey,
        wrappingKey,
        rollbackPayloads,
      })

      ;({ response } = await this.sessions.changeCredentials({
        currentServerPassword: currentRootKey.serverPassword as string,
        newRootKey: newRootKey,
        wrappingKey,
        newEmail: newEmail,
      }))
    } finally {
      this.unlockSyncing()
    }

    if (isErrorResponse(response)) {
      await this.encryption.clearCredentialRotationJournal()
      return { error: Error(response.data.error?.message) }
    }

    await this.encryption.updateCredentialRotationJournal({
      phase: CredentialRotationPhase.ServerConfirmed,
    })

    const rollback = await this.encryption.createNewItemsKeyWithRollback()
    const newDefaultItemsKey = this.encryption.getSureDefaultItemsKey()
    await this.encryption.updateCredentialRotationJournal({
      phase: CredentialRotationPhase.ServerConfirmed,
      newItemsKeyUuid: newDefaultItemsKey.uuid,
    })
    await this._reencryptTypeAItems.execute()
    await this.persistTypeAItems()
    await this.encryption.updateCredentialRotationJournal({
      phase: CredentialRotationPhase.LocalItemsPersisted,
      newItemsKeyUuid: newDefaultItemsKey.uuid,
    })
    await this.sync.sync({ awaitAll: true })

    const defaultItemsKey = this.encryption.getSureDefaultItemsKey()
    const itemsKeyWasSynced = !defaultItemsKey.neverSynced

    if (!itemsKeyWasSynced) {
      await this.encryption.updateCredentialRotationJournal({
        phase: CredentialRotationPhase.RollbackPending,
        newItemsKeyUuid: newDefaultItemsKey.uuid,
      })
      this.lockSyncing()
      let serverRollbackConfirmed = false
      try {
        const { response: rollbackResponse } = await this.sessions.changeCredentials({
          currentServerPassword: newRootKey.serverPassword as string,
          newRootKey: currentRootKey,
          wrappingKey,
          newEmail: newEmail !== undefined ? currentEmail : undefined,
        })

        if (isErrorResponse(rollbackResponse)) {
          await this.encryption.updateCredentialRotationJournal({
            phase: CredentialRotationPhase.ServerConfirmed,
            newItemsKeyUuid: newDefaultItemsKey.uuid,
          })
          return { error: Error(Messages.CredentialsChangeStrings.RollbackRejected) }
        }

        serverRollbackConfirmed = true
        await this.encryption.updateCredentialRotationJournal({
          phase: CredentialRotationPhase.RollbackConfirmed,
          newItemsKeyUuid: newDefaultItemsKey.uuid,
        })
        await this._reencryptTypeAItems.execute()
        await rollback()
        await this.persistTypeAItems()
      } catch {
        return {
          error: Error(
            serverRollbackConfirmed
              ? Messages.CredentialsChangeStrings.LocalRollbackFailed
              : Messages.CredentialsChangeStrings.RollbackUnconfirmed,
          ),
        }
      } finally {
        this.unlockSyncing()
      }

      await this.sync.sync({ awaitAll: true })
      await this.encryption.clearCredentialRotationJournal()

      return { error: Error(Messages.CredentialsChangeStrings.Failed) }
    }

    await this.encryption.clearCredentialRotationJournal()
    return {}
  }

  private async resumeCredentialRotationBeforeDatabaseLoad(): Promise<void> {
    if (this.resumingCredentialRotation) {
      return
    }

    const journal = this.encryption.getCredentialRotationJournal()
    if (!journal) {
      return
    }

    this.resumingCredentialRotation = true
    try {
      const secrets = await this.encryption.getCredentialRotationSecrets()
      if (!secrets) {
        return
      }

      if (journal.phase === CredentialRotationPhase.Prepared) {
        if (await this.tryCredentialRotationSignIn(secrets.newEmail, secrets.newRootKey, secrets.wrappingKey)) {
          const updated =
            (await this.encryption.updateCredentialRotationJournal({
              phase: CredentialRotationPhase.ServerConfirmed,
              newItemsKeyUuid: journal.newItemsKeyUuid,
            })) ?? journal
          await this.stageCredentialRotationPayloadsForNewRoot(updated, secrets)
        } else if (
          await this.tryCredentialRotationSignIn(secrets.currentEmail, secrets.currentRootKey, secrets.wrappingKey)
        ) {
          /**
           * The old credentials are authoritative, so the interrupted request
           * did not commit. No local Type-A mutation was performed before the
           * request and the journal can be discarded.
           */
          await this.encryption.clearCredentialRotationJournal()
        }
        return
      }

      if (journal.phase === CredentialRotationPhase.RollbackPending) {
        if (await this.tryCredentialRotationSignIn(secrets.currentEmail, secrets.currentRootKey, secrets.wrappingKey)) {
          const updated =
            (await this.encryption.updateCredentialRotationJournal({
              phase: CredentialRotationPhase.RollbackConfirmed,
              newItemsKeyUuid: journal.newItemsKeyUuid,
            })) ?? journal
          await this.restoreCredentialRotationRollbackSnapshot(updated, secrets)
          await this.encryption.clearCredentialRotationJournal()
        } else if (await this.tryCredentialRotationSignIn(secrets.newEmail, secrets.newRootKey, secrets.wrappingKey)) {
          const updated =
            (await this.encryption.updateCredentialRotationJournal({
              phase: CredentialRotationPhase.ServerConfirmed,
              newItemsKeyUuid: journal.newItemsKeyUuid,
            })) ?? journal
          await this.stageCredentialRotationPayloadsForNewRoot(updated, secrets)
        }
        return
      }

      const targetRoot =
        journal.phase === CredentialRotationPhase.RollbackConfirmed ? secrets.currentRootKey : secrets.newRootKey
      if (!this.encryption.getSureRootKey().compare(targetRoot)) {
        await this.encryption.setRootKey(targetRoot, secrets.wrappingKey)
      }

      if (journal.phase === CredentialRotationPhase.RollbackConfirmed) {
        await this.restoreCredentialRotationRollbackSnapshot(journal, secrets)
        await this.encryption.clearCredentialRotationJournal()
      } else if (journal.phase === CredentialRotationPhase.ServerConfirmed) {
        await this.stageCredentialRotationPayloadsForNewRoot(journal, secrets)
      }
    } finally {
      this.resumingCredentialRotation = false
    }
  }

  private async tryCredentialRotationSignIn(
    email: string,
    rootKey: RootKeyInterface,
    wrappingKey?: RootKeyInterface,
  ): Promise<boolean> {
    try {
      const response = await this.sessions.reconcileCredentialRotationSignIn(email, rootKey, wrappingKey)
      return !isErrorResponse(response)
    } catch {
      return false
    }
  }

  private async stageCredentialRotationPayloadsForNewRoot(
    journal: CredentialRotationJournal,
    secrets: CredentialRotationSecrets,
  ): Promise<void> {
    const encryptedPayloads = journal.rollbackPayloads.map((payload) => new EncryptedPayload(payload))
    if (encryptedPayloads.length === 0) {
      return
    }

    if (await this.credentialRotationSnapshotUsesRoot(journal, secrets.newRootKey)) {
      return
    }

    const decryptedPayloads = await this.encryption.decryptSplit({
      usesRootKey: {
        items: encryptedPayloads,
        key: secrets.currentRootKey,
      },
    })
    if (!this.payloadSetMatchesCredentialRotationSnapshot(decryptedPayloads, journal)) {
      throw Error('Unable to decrypt the credential rotation rollback snapshot.')
    }
    const verifiedDecryptedPayloads = decryptedPayloads.filter(isDecryptedPayload)

    const reencryptedPayloads = await this.encryption.encryptSplit({
      usesRootKey: {
        items: verifiedDecryptedPayloads,
        key: secrets.newRootKey,
      },
    })
    if (
      !reencryptedPayloads.every(isEncryptedTransferPayload) ||
      !this.payloadSetHasCredentialRotationSnapshotMetadata(reencryptedPayloads, journal)
    ) {
      throw Error('Unable to encrypt the complete credential rotation snapshot.')
    }

    await this.storage.savePayloads(reencryptedPayloads)

    if (!(await this.credentialRotationSnapshotUsesRoot(journal, secrets.newRootKey))) {
      throw Error('Unable to verify the persisted credential rotation snapshot.')
    }
  }

  private async credentialRotationSnapshotUsesRoot(
    journal: CredentialRotationJournal,
    rootKey: RootKeyInterface,
  ): Promise<boolean> {
    const rollbackUuids = journal.rollbackPayloads.map((payload) => payload.uuid)
    const persistedPayloads = await this.storage.getRawPayloads(rollbackUuids)
    if (
      !persistedPayloads.every(isEncryptedTransferPayload) ||
      !this.payloadSetHasCredentialRotationSnapshotMetadata(persistedPayloads, journal)
    ) {
      return false
    }

    try {
      const decryptedPayloads = await this.encryption.decryptSplit({
        usesRootKey: {
          items: persistedPayloads.map((payload) => new EncryptedPayload(payload)),
          key: rootKey,
        },
      })
      return this.payloadSetMatchesCredentialRotationSnapshot(decryptedPayloads, journal)
    } catch {
      return false
    }
  }

  private payloadSetMatchesCredentialRotationSnapshot(
    payloads: Awaited<ReturnType<EncryptionProviderInterface['decryptSplit']>>,
    journal: CredentialRotationJournal,
  ): boolean {
    return payloads.every(isDecryptedPayload) && this.payloadSetHasCredentialRotationSnapshotMetadata(payloads, journal)
  }

  private payloadSetHasCredentialRotationSnapshotMetadata(
    payloads: readonly { uuid: string; content_type: string }[],
    journal: CredentialRotationJournal,
  ): boolean {
    if (payloads.length !== journal.rollbackPayloads.length) {
      return false
    }

    const expectedPayloadsByUuid = new Map(
      journal.rollbackPayloads.map((payload) => [payload.uuid, payload.content_type]),
    )
    if (expectedPayloadsByUuid.size !== journal.rollbackPayloads.length) {
      return false
    }

    const seenUuids = new Set<string>()
    return payloads.every((payload) => {
      if (seenUuids.has(payload.uuid)) {
        return false
      }
      seenUuids.add(payload.uuid)

      return expectedPayloadsByUuid.get(payload.uuid) === payload.content_type
    })
  }

  private async restoreCredentialRotationRollbackSnapshot(
    journal: CredentialRotationJournal,
    secrets: CredentialRotationSecrets,
  ): Promise<void> {
    if (!this.encryption.getSureRootKey().compare(secrets.currentRootKey)) {
      await this.encryption.setRootKey(secrets.currentRootKey, secrets.wrappingKey)
    }
    await this.storage.savePayloads(journal.rollbackPayloads.map((payload) => new EncryptedPayload(payload)))
    if (journal.newItemsKeyUuid) {
      await this.storage.deletePayloadsWithUuids([journal.newItemsKeyUuid])
    }
  }

  private async resumeCredentialRotationAfterDatabaseLoad(): Promise<void> {
    if (this.resumingCredentialRotation) {
      return
    }

    const journal = this.encryption.getCredentialRotationJournal()
    if (
      !journal ||
      (journal.phase !== CredentialRotationPhase.ServerConfirmed &&
        journal.phase !== CredentialRotationPhase.LocalItemsPersisted)
    ) {
      return
    }

    this.resumingCredentialRotation = true
    try {
      const secrets = await this.encryption.getCredentialRotationSecrets()
      if (!secrets) {
        return
      }

      if (!this.encryption.getSureRootKey().compare(secrets.newRootKey)) {
        await this.encryption.setRootKey(secrets.newRootKey, secrets.wrappingKey)
      }

      let updatedJournal: CredentialRotationJournal = journal
      const preparedItemsKey = journal.newItemsKeyUuid ? this.items.findItem(journal.newItemsKeyUuid) : undefined
      if (!preparedItemsKey) {
        await this.encryption.createNewItemsKeyWithRollback()
        const newDefaultItemsKey = this.encryption.getSureDefaultItemsKey()
        updatedJournal =
          (await this.encryption.updateCredentialRotationJournal({
            phase: CredentialRotationPhase.ServerConfirmed,
            newItemsKeyUuid: newDefaultItemsKey.uuid,
          })) ?? journal
      }

      await this._reencryptTypeAItems.execute()
      await this.persistTypeAItems()
      await this.encryption.updateCredentialRotationJournal({
        phase: CredentialRotationPhase.LocalItemsPersisted,
        newItemsKeyUuid: updatedJournal.newItemsKeyUuid,
      })
      await this.sync.sync({ awaitAll: true })

      if (!this.encryption.getSureDefaultItemsKey().neverSynced) {
        await this.encryption.clearCredentialRotationJournal()
      }
    } catch {
      /**
       * Recovery is deliberately retryable. Keep the durable journal intact and
       * let the next launch or foreground credential flow resume from the last
       * confirmed phase instead of failing application startup.
       */
    } finally {
      this.resumingCredentialRotation = false
    }
  }

  private async recomputeRootKeysForCredentialChange(parameters: {
    currentPassword: string | undefined
    currentRootKey?: RootKeyInterface
    currentEmail: string
    origination: KeyParamsOrigination
    newEmail?: string
    newPassword?: string
  }): Promise<{ currentRootKey: RootKeyInterface; newRootKey: SNRootKey }> {
    const currentRootKey =
      parameters.currentRootKey ??
      (await this.encryption.computeRootKey(
        parameters.currentPassword as string,
        this.encryption.getRootKeyParams() as SNRootKeyParams,
      ))
    const newRootKey = await this.encryption.createRootKey(
      parameters.newEmail ?? parameters.currentEmail,
      parameters.newPassword ?? (parameters.currentPassword as string),
      parameters.origination,
    )

    return {
      currentRootKey,
      newRootKey,
    }
  }
}
