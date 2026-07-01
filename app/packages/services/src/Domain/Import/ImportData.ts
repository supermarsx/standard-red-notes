import { DecryptBackupFile } from './DecryptBackupFile'
import { HistoryServiceInterface } from '../History/HistoryServiceInterface'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { ProtectionsClientInterface } from '../Protection/ProtectionClientInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { ItemManagerInterface } from '../Item/ItemManagerInterface'
import { ProtocolVersion } from '@standardnotes/common'
import {
  compareVersions,
  BackupFile,
  BackupFileDecryptedContextualPayload,
  CreateDecryptedBackupFileContextPayload,
  CreateEncryptedBackupFileContextPayload,
  DecryptedItemInterface,
  DecryptedPayloadInterface,
  EncryptedPayloadInterface,
  isDecryptedPayload,
  isEncryptedPayload,
  isEncryptedTransferPayload,
} from '@standardnotes/models'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { EncryptionProviderInterface } from '../Encryption/EncryptionProviderInterface'
import { Strings } from './Strings'
import { ImportDataResult } from './ImportDataResult'
import { GetFilePassword } from './GetFilePassword'

export class ImportData implements UseCaseInterface<ImportDataResult> {
  constructor(
    private items: ItemManagerInterface,
    private sync: SyncServiceInterface,
    private protections: ProtectionsClientInterface,
    private encryption: EncryptionProviderInterface,
    private payloads: PayloadManagerInterface,
    private history: HistoryServiceInterface,
    private _decryptBackFile: DecryptBackupFile,
    private _getFilePassword: GetFilePassword,
  ) {}

  async execute(data: BackupFile, awaitSync = false): Promise<Result<ImportDataResult>> {
    const versionValidation = this.validateFileVersion(data)
    if (versionValidation.isFailed()) {
      return Result.fail(versionValidation.getError())
    }

    const decryptedPayloadsOrError = await this.decryptData(data)
    if (decryptedPayloadsOrError.isFailed()) {
      return Result.fail(decryptedPayloadsOrError.getError())
    }

    const { valid, encryptedItemUuids } = this.getValidPayloadsToImportFromDecryptedResult(
      decryptedPayloadsOrError.getValue(),
    )

    if (!(await this.protections.authorizeFileImport())) {
      return Result.fail('Import aborted')
    }

    const affectedUuids = await this.payloads.importPayloads(valid, this.history.getHistoryMapCopy())

    const promise = this.sync.sync()
    if (awaitSync) {
      await promise
    }

    const affectedItems = this.items.findItems(affectedUuids) as DecryptedItemInterface[]

    return Result.ok({
      affectedItems: affectedItems,
      // PERSIST-H2: nothing is silently dropped anymore. Un-decryptable items are
      // imported as encrypted, so there is no decrypt-failure loss to report here.
      errorCount: 0,
      encryptedItemUuids,
    })
  }

  private validateFileVersion(data: BackupFile): Result<void> {
    if (data.version) {
      const result = this.validateVersion(data.version)
      if (result.isFailed()) {
        return Result.fail(result.getError())
      }
    }
    return Result.ok()
  }

  private async decryptData(
    data: BackupFile,
  ): Promise<Result<(DecryptedPayloadInterface | EncryptedPayloadInterface)[]>> {
    let password: string | undefined

    if (data.auth_params || data.keyParams) {
      const passwordResult = await this._getFilePassword.execute()
      if (passwordResult.isFailed()) {
        return Result.fail(passwordResult.getError())
      }
      password = passwordResult.getValue()
    }

    this.cleanImportData(data)

    const decryptedPayloadsOrError = await this._decryptBackFile.execute(data, password)
    if (decryptedPayloadsOrError.isFailed()) {
      return Result.fail(decryptedPayloadsOrError.getError())
    }

    return Result.ok(decryptedPayloadsOrError.getValue())
  }

  private getValidPayloadsToImportFromDecryptedResult(
    results: (DecryptedPayloadInterface | EncryptedPayloadInterface)[],
  ): {
    valid: (EncryptedPayloadInterface | DecryptedPayloadInterface)[]
    encryptedItemUuids: string[]
  } {
    const decrypted = results.filter(isDecryptedPayload)
    const encrypted = results.filter(isEncryptedPayload)

    /**
     * PERSIST-H2: previously only vault-scoped (key_system_identifier !== undefined)
     * encrypted payloads were kept; any encrypted payload that failed to decrypt and
     * was NOT vault-scoped (e.g. a regular note under an items-key that didn't decrypt)
     * was filtered out and only counted in errorCount — i.e. silently dropped on restore.
     *
     * We now import ALL encrypted payloads, preserving their ciphertext, so they land in
     * the database and can be decrypted later when the right key becomes available. This
     * mirrors how vault-scoped encrypted payloads were already kept, and is safe: an
     * encrypted payload stays encrypted at rest and is decrypted on the next key
     * availability (e.g. items-key sync, passcode/account key entry), without violating
     * the lite/persist invariants. We surface the still-encrypted uuids to the caller.
     */
    const valid = [...decrypted, ...encrypted]
    const encryptedItemUuids = encrypted.map((payload) => payload.uuid)

    return { valid, encryptedItemUuids }
  }

  private cleanImportData(data: BackupFile): void {
    data.items = data.items.map((item) => {
      if (isEncryptedTransferPayload(item)) {
        return CreateEncryptedBackupFileContextPayload(item)
      } else {
        return CreateDecryptedBackupFileContextPayload(item as BackupFileDecryptedContextualPayload)
      }
    })
  }

  /**
   * Prior to 003 backup files did not have a version field so we cannot
   * stop importing if there is no backup file version, only if there is
   * an unsupported version.
   */
  private validateVersion(version: ProtocolVersion): Result<void> {
    const supportedVersions = this.encryption.supportedVersions()
    if (!supportedVersions.includes(version)) {
      return Result.fail(Strings.UnsupportedBackupFileVersion)
    }

    const userVersion = this.encryption.getUserVersion()
    if (userVersion && compareVersions(version, userVersion) === 1) {
      /** File was made with a greater version than the user's account */
      return Result.fail(Strings.BackupFileMoreRecentThanAccount)
    }

    return Result.ok()
  }
}
