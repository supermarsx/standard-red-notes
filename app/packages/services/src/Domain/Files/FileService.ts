import { MutatorClientInterface } from './../Mutator/MutatorClientInterface'
import {
  ClientDisplayableError,
  HttpResponse,
  isClientDisplayableError,
  isErrorResponse,
  SharedVaultMoveType,
  StartUploadSessionResponse,
  ValetTokenOperation,
} from '@standardnotes/responses'
import {
  FileItem,
  FileProtocolV1Constants,
  FileMetadata,
  FileContentSpecialized,
  FillItemContentSpecialized,
  FileContent,
  EncryptedPayload,
  isEncryptedPayload,
  VaultListingInterface,
  SharedVaultListingInterface,
  DecryptedPayload,
  FillItemContent,
  PayloadVaultOverrides,
  PayloadTimestampDefaults,
  CreateItemFromPayload,
  DecryptedItemInterface,
  AppDataField,
  DefaultAppDomain,
} from '@standardnotes/models'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { LoggerInterface, UuidGenerator } from '@standardnotes/utils'
import { SNItemsKey } from '@standardnotes/encryption'
import {
  DownloadAndDecryptFileOperation,
  DownloadAndDecryptResult,
  EncryptAndUploadFileOperation,
  FileDecryptor,
  FileDownloadProgress,
  FilesClientInterface,
  readAndDecryptBackupFileUsingFileSystemAPI,
  FilesApiInterface,
  FileBackupsConstantsV1,
  FileBackupMetadataFile,
  FileSystemApi,
  FileHandleRead,
  FileSystemNoSelection,
  EncryptedBytes,
  DecryptedBytes,
  OrderedByteChunker,
  FileMemoryCache,
  readAndDecryptBackupFileUsingBackupService,
  BackupServiceInterface,
  LocalFileBackendInterface,
  LocalOnlyFileUploadOperation,
  FileSocketTransportInterface,
  SocketPreferredFilesApi,
  DownloadFileParams,
  FileOwnershipType,
  EncryptedStreamDigest,
  FileEncryptor,
  FileUploadOperation,
  planUploadSize,
  SocketFileUploadPosition,
  SocketFileUploadSession,
  SocketUploadDriver,
  UploadSizePlan,
} from '@standardnotes/files'
import { AlertService, ButtonType } from '../Alert/AlertService'
import { ChallengeServiceInterface } from '../Challenge'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { AbstractService } from '../Service/AbstractService'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { DecryptItemsKeyWithUserFallback } from '../Encryption/Functions'
import { SharedVaultServer, SharedVaultServerInterface, HttpServiceInterface } from '@standardnotes/api'
import { ContentType } from '@standardnotes/domain-core'
import { EncryptionProviderInterface } from '../Encryption/EncryptionProviderInterface'
import { diagnoseDeleteFileFailure } from './DeleteFileFailure'

const OneHundredMb = 100 * 1_000_000

/**
 * Stands in for the READ valet token for the lifetime of a download operation that
 * may never need one.
 *
 * It is never transmitted: `LazyReadValetTokenFilesApi.downloadFile` is the only
 * code that hands a token to the HTTP client, and it always substitutes the token
 * it has just minted. Deliberately non-empty and self-describing so that if some
 * future path ever did send it, the server's rejection names this bug instead of
 * reading as an ordinary expired credential.
 */
const DeferredReadValetTokenPlaceholder = 'deferred-read-valet-token-not-yet-minted'

/**
 * Wraps the HTTP files client so that a download's READ valet token is minted at
 * the moment HTTP is actually about to carry the bytes, and not a moment earlier.
 *
 * Why it sits *underneath* `SocketPreferredFilesApi` rather than over it: which
 * transport carries a download is not decided until `SocketPreferredFilesApi`
 * runs, and that decision can still land on HTTP well after the lane looked
 * available — the lane may not be negotiated, a shared vault's owner may not be
 * resolvable locally, the socket may report the lane unavailable, or it may fail
 * having delivered nothing. Every one of those paths reaches HTTP through
 * `http.downloadFile`, which is this method, so there is no window in which the
 * transport has been chosen and the mint has already been skipped.
 *
 * Minting happens once per `downloadFile` call, never once per range: the HTTP
 * client issues every range of a multi-chunk file under the single token it is
 * given, and the server consumes that single-use token on the final range.
 */
class LazyReadValetTokenFilesApi implements FilesApiInterface {
  constructor(
    private readonly http: FilesApiInterface,
    private readonly mintReadToken: () => Promise<string | ClientDisplayableError>,
  ) {}

  async downloadFile(params: DownloadFileParams): Promise<ClientDisplayableError | undefined> {
    const tokenResult = await this.mintReadToken()

    if (tokenResult instanceof ClientDisplayableError) {
      return tokenResult
    }

    // Minting is a network round trip of its own. A caller that gave up while it
    // was in flight must not then have the download it cancelled begin; matching
    // the HTTP client, an aborted download is reported as a non-error.
    if (params.abortSignal?.aborted === true || params.shouldAbort?.() === true) {
      return undefined
    }

    return this.http.downloadFile({ ...params, valetToken: tokenResult })
  }

  createUserFileValetToken(
    remoteIdentifier: string,
    operation: ValetTokenOperation,
    unencryptedFileSize?: number,
  ): Promise<string | ClientDisplayableError> {
    return this.http.createUserFileValetToken(remoteIdentifier, operation, unencryptedFileSize)
  }

  startUploadSession(
    valetToken: string,
    ownershipType: FileOwnershipType,
  ): Promise<HttpResponse<StartUploadSessionResponse>> {
    return this.http.startUploadSession(valetToken, ownershipType)
  }

  uploadFileBytes(
    valetToken: string,
    ownershipType: FileOwnershipType,
    chunkId: number,
    encryptedBytes: Uint8Array,
  ): Promise<boolean> {
    return this.http.uploadFileBytes(valetToken, ownershipType, chunkId, encryptedBytes)
  }

  closeUploadSession(valetToken: string, ownershipType: FileOwnershipType): Promise<boolean | ClientDisplayableError> {
    return this.http.closeUploadSession(valetToken, ownershipType)
  }

  moveFile(valetToken: string): Promise<boolean> {
    return this.http.moveFile(valetToken)
  }

  deleteFile(valetToken: string, ownershipType: FileOwnershipType): Promise<HttpResponse> {
    return this.http.deleteFile(valetToken, ownershipType)
  }

  getFilesDownloadUrl(ownershipType: FileOwnershipType): string {
    return this.http.getFilesDownloadUrl(ownershipType)
  }
}

export class FileService extends AbstractService implements FilesClientInterface {
  private encryptedCache: FileMemoryCache = new FileMemoryCache(OneHundredMb)
  private sharedVault: SharedVaultServerInterface
  private localFileBackend?: LocalFileBackendInterface
  private socketTransport?: FileSocketTransportInterface
  private sharedVaultOwnerResolver?: (sharedVaultUuid: string) => string | undefined

  constructor(
    private api: FilesApiInterface,
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private encryptor: EncryptionProviderInterface,
    private challengor: ChallengeServiceInterface,
    http: HttpServiceInterface,
    private alertService: AlertService,
    private crypto: PureCryptoInterface,
    protected override internalEventBus: InternalEventBusInterface,
    private logger: LoggerInterface,
    private backupsService?: BackupServiceInterface,
  ) {
    super(internalEventBus)
    this.sharedVault = new SharedVaultServer(http)
  }

  /**
   * Installs (or clears) the realtime transport that file downloads may borrow.
   *
   * Optional by design: when it is never called, or called with `undefined`,
   * every file operation continues to run over the HTTP client exactly as before.
   * The decorator itself re-checks liveness per download, so a socket that later
   * degrades silently reverts to HTTP rather than needing to be uninstalled.
   */
  public setFileSocketTransport(transport: FileSocketTransportInterface | undefined): void {
    this.socketTransport = transport
  }

  /**
   * Supplies the lookup from a shared vault's uuid to the user uuid that vault
   * listing records as its owner.
   *
   * Late-bound for the same reason `MutatorService.setFileService` is: reading
   * vaults from the constructor would close a dependency cycle. Only the socket
   * download path consumes it — HTTP sends the owner as request context and never
   * needs it resolved — and a vault this returns nothing for simply keeps its
   * downloads on HTTP.
   */
  public setSharedVaultOwnerResolver(resolve: ((sharedVaultUuid: string) => string | undefined) | undefined): void {
    this.sharedVaultOwnerResolver = resolve
  }

  /**
   * Assembles the client one download will use: socket-preferred when a transport
   * is installed, HTTP otherwise, with `http` underneath in both cases.
   *
   * Built per download rather than cached because `http` carries that download's
   * own single-use READ token mint. The decorator itself is stateless, and both
   * the liveness check and the fallback it may take happen inside it, so the
   * transport decision is still made as late as it ever was.
   */
  private downloadApiOver(http: FilesApiInterface): FilesApiInterface {
    return this.socketTransport
      ? new SocketPreferredFilesApi(http, this.socketTransport, this.sharedVaultOwnerResolver)
      : http
  }

  override deinit(): void {
    super.deinit()

    this.socketTransport = undefined
    this.sharedVaultOwnerResolver = undefined
    this.encryptedCache.clear()
    ;(this.encryptedCache as unknown) = undefined
    ;(this.api as unknown) = undefined
    ;(this.encryptor as unknown) = undefined
    ;(this.sync as unknown) = undefined
    ;(this.alertService as unknown) = undefined
    ;(this.challengor as unknown) = undefined
    ;(this.crypto as unknown) = undefined
  }

  public minimumChunkSize(): number {
    return 5_000_000
  }

  public setLocalFileBackend(backend: LocalFileBackendInterface): void {
    this.localFileBackend = backend
  }

  /**
   * Begins a "large local-only file" operation. Encrypts pushed chunks (same xchacha20 stream
   * as a server upload) and accumulates the encrypted bytes in memory. No network calls.
   */
  public beginNewLocalOnlyFileUpload(sizeInBytes: number): LocalOnlyFileUploadOperation {
    const remoteIdentifier = UuidGenerator.GenerateUuid()
    const key = this.crypto.generateRandomKey(FileProtocolV1Constants.KeySize)

    return new LocalOnlyFileUploadOperation(
      {
        key,
        remoteIdentifier,
        decryptedSize: sizeInBytes,
      },
      this.crypto,
    )
  }

  public pushBytesForLocalOnlyUpload(
    operation: LocalOnlyFileUploadOperation,
    bytes: Uint8Array,
    isFinalChunk: boolean,
  ): void {
    operation.pushBytes(bytes, isFinalChunk)
  }

  /**
   * Persists the accumulated encrypted bytes locally (NOT uploaded to the server) and creates a
   * `localOnly`-flagged file item so it is excluded from the sync upload set. The local-only
   * flag lives in appData and, because the item never uploads, never reaches the server.
   */
  public async finishLocalOnlyUpload(
    operation: LocalOnlyFileUploadOperation,
    fileMetadata: FileMetadata,
    uuid: string,
  ): Promise<FileItem | ClientDisplayableError> {
    if (!this.localFileBackend) {
      return new ClientDisplayableError('Local file storage is not available on this device')
    }

    const result = operation.getResult()
    const encryptedBytes = operation.getEncryptedBytes()

    try {
      await this.localFileBackend.persistEncryptedBytes(uuid, encryptedBytes)
    } catch (error) {
      return new ClientDisplayableError(
        error instanceof Error && error.name === 'QuotaExceededError'
          ? 'Not enough local storage space to keep this file on your device.'
          : 'Could not save the file to local storage.',
      )
    }

    const fileContent: FileContentSpecialized = {
      decryptedSize: result.finalDecryptedSize,
      encryptedChunkSizes: operation.encryptedChunkSizes,
      encryptionHeader: result.encryptionHeader,
      key: result.key,
      mimeType: fileMetadata.mimeType,
      name: fileMetadata.name,
      remoteIdentifier: result.remoteIdentifier,
    }

    const filledContent = FillItemContent<FileContent>(FillItemContentSpecialized(fileContent))
    filledContent.appData = {
      ...filledContent.appData,
      [DefaultAppDomain]: {
        ...filledContent.appData?.[DefaultAppDomain],
        [AppDataField.LocalOnly]: true,
      },
    }

    const filePayload = new DecryptedPayload<FileContent>({
      uuid,
      content_type: ContentType.TYPES.File,
      content: filledContent,
      dirty: true,
      ...PayloadTimestampDefaults(),
    })

    const fileItem = CreateItemFromPayload(filePayload) as DecryptedItemInterface<FileContent>

    const insertedItem = await this.mutator.insertItem<FileItem>(fileItem)

    /**
     * Persist the (local-only) item to the local DB. The sync upload filter excludes local-only
     * items, so this never uploads, but it does persist the metadata locally so the file
     * survives a reload.
     */
    await this.sync.sync()

    return insertedItem
  }

  /** Reads + decrypts the locally-persisted bytes for a large local-only file. */
  private async downloadLocalOnlyFile(
    file: FileItem,
    onDecryptedBytes: (decryptedBytes: Uint8Array, progress: FileDownloadProgress) => Promise<void>,
  ): Promise<ClientDisplayableError | undefined> {
    if (!this.localFileBackend) {
      return new ClientDisplayableError('Local file storage is not available on this device')
    }

    const stored = await this.localFileBackend.readEncryptedBytes(file.uuid)
    if (!stored) {
      return new ClientDisplayableError('This file is kept on another device and is not available here.')
    }

    const decrypted = await this.decryptCachedEntry(file, stored)
    if (!decrypted) {
      return new ClientDisplayableError('Local file data failed its integrity check.')
    }

    await onDecryptedBytes(decrypted.decryptedBytes, {
      encryptedFileSize: stored.encryptedBytes.length,
      encryptedBytesDownloaded: stored.encryptedBytes.length,
      encryptedBytesRemaining: 0,
      percentComplete: 100,
      source: 'local',
    })

    return undefined
  }

  private async createUserValetToken(
    remoteIdentifier: string,
    operation: ValetTokenOperation,
    unencryptedFileSizeForUpload?: number | undefined,
  ): Promise<string | ClientDisplayableError> {
    return this.api.createUserFileValetToken(remoteIdentifier, operation, unencryptedFileSizeForUpload)
  }

  private async createSharedVaultValetToken(params: {
    sharedVaultUuid: string
    remoteIdentifier: string
    operation: ValetTokenOperation
    fileUuidRequiredForExistingFiles?: string
    unencryptedFileSizeForUpload?: number | undefined
    moveOperationType?: SharedVaultMoveType
    sharedVaultToSharedVaultMoveTargetUuid?: string
    sharedVaultOwnerUuid?: string
  }): Promise<string | ClientDisplayableError> {
    if (params.operation !== ValetTokenOperation.Write && !params.fileUuidRequiredForExistingFiles) {
      throw new Error('File UUID is required for for non-write operations')
    }

    const valetTokenResponse = await this.sharedVault.createSharedVaultFileValetToken({
      sharedVaultUuid: params.sharedVaultUuid,
      sharedVaultOwnerUuid: params.sharedVaultOwnerUuid,
      fileUuid: params.fileUuidRequiredForExistingFiles,
      remoteIdentifier: params.remoteIdentifier,
      operation: params.operation,
      unencryptedFileSize: params.unencryptedFileSizeForUpload,
      moveOperationType: params.moveOperationType,
      sharedVaultToSharedVaultMoveTargetUuid: params.sharedVaultToSharedVaultMoveTargetUuid,
    })

    if (isErrorResponse(valetTokenResponse)) {
      return new ClientDisplayableError('Could not create valet token')
    }

    return valetTokenResponse.data.valetToken
  }

  /**
   * Mints the single-use READ token for one download, from whichever endpoint
   * owns the file: `POST /v1/files/valet-tokens` for a personal file, and
   * `POST /v1/shared-vaults/{uuid}/valet-tokens` for one in a shared vault.
   *
   * Both are equally deferred. A shared-vault download can take the socket too —
   * whenever its owner resolves from the vault listing — so minting it eagerly
   * would waste exactly the same round trip.
   */
  private createReadValetToken(file: FileItem): Promise<string | ClientDisplayableError> {
    return file.shared_vault_uuid
      ? this.createSharedVaultValetToken({
          sharedVaultUuid: file.shared_vault_uuid,
          remoteIdentifier: file.remoteIdentifier,
          operation: ValetTokenOperation.Read,
          fileUuidRequiredForExistingFiles: file.uuid,
        })
      : this.createUserValetToken(file.remoteIdentifier, ValetTokenOperation.Read)
  }

  public async moveFileToSharedVault(
    file: FileItem,
    sharedVault: SharedVaultListingInterface,
  ): Promise<void | ClientDisplayableError> {
    const valetTokenResult = await this.createSharedVaultValetToken({
      sharedVaultUuid: file.shared_vault_uuid ? file.shared_vault_uuid : sharedVault.sharing.sharedVaultUuid,
      sharedVaultOwnerUuid: sharedVault.sharing.ownerUserUuid,
      remoteIdentifier: file.remoteIdentifier,
      operation: ValetTokenOperation.Move,
      fileUuidRequiredForExistingFiles: file.uuid,
      moveOperationType: file.shared_vault_uuid ? 'shared-vault-to-shared-vault' : 'user-to-shared-vault',
      sharedVaultToSharedVaultMoveTargetUuid: file.shared_vault_uuid ? sharedVault.sharing.sharedVaultUuid : undefined,
    })

    if (isClientDisplayableError(valetTokenResult)) {
      return valetTokenResult
    }

    const moveResult = await this.api.moveFile(valetTokenResult)

    if (!moveResult) {
      return new ClientDisplayableError('Could not move file')
    }
  }

  public async moveFileOutOfSharedVault(file: FileItem): Promise<void | ClientDisplayableError> {
    if (!file.shared_vault_uuid) {
      return new ClientDisplayableError('File is not in a shared vault')
    }

    const valetTokenResult = await this.createSharedVaultValetToken({
      sharedVaultUuid: file.shared_vault_uuid,
      remoteIdentifier: file.remoteIdentifier,
      operation: ValetTokenOperation.Move,
      fileUuidRequiredForExistingFiles: file.uuid,
      moveOperationType: 'shared-vault-to-user',
    })

    if (isClientDisplayableError(valetTokenResult)) {
      return valetTokenResult
    }

    const moveResult = await this.api.moveFile(valetTokenResult)

    if (!moveResult) {
      return new ClientDisplayableError('Could not move file')
    }
  }

  /**
   * Begins an upload, over the realtime socket when the server accepts one there
   * and over HTTP otherwise.
   *
   * The ordering is the whole point. The socket open is tried FIRST, and the
   * WRITE valet token and the HTTP upload session are minted only on the branch
   * that actually needs them — the same shape as the download path, where the
   * READ token is minted underneath `SocketPreferredFilesApi` rather than in
   * front of it. Deciding on an accepted open rather than on `isFileLaneAvailable()`
   * also closes the window a liveness check leaves open: the lane can drop
   * between a check and the first byte, but an open the server answered cannot
   * be stale in that way.
   */
  public async beginNewFileUpload(
    sizeInBytes: number,
    vault?: VaultListingInterface,
  ): Promise<FileUploadOperation | ClientDisplayableError> {
    const remoteIdentifier = UuidGenerator.GenerateUuid()
    const key = this.crypto.generateRandomKey(FileProtocolV1Constants.KeySize)
    const fileParams = {
      key,
      remoteIdentifier,
      decryptedSize: sizeInBytes,
    }
    const ownershipType: FileOwnershipType = vault && vault.isSharedVaultListing() ? 'shared-vault' : 'user'

    const beginOverHttp = () => this.beginHttpFileUpload(fileParams, sizeInBytes, ownershipType, vault)

    const socketUpload = await this.openSocketUpload(remoteIdentifier, sizeInBytes, ownershipType, vault)
    if (!socketUpload) {
      return beginOverHttp()
    }

    const encryptor = new FileEncryptor(fileParams, this.crypto)

    return new SocketUploadDriver({
      plan: socketUpload.plan,
      file: fileParams,
      encryptionHeader: encryptor.initializeHeader(),
      encryptor,
      digest: new EncryptedStreamDigest(this.crypto),
      session: socketUpload.session,
      position: socketUpload.position,
      vault,
      beginHttpFallback: beginOverHttp,
    })
  }

  /**
   * Asks the socket-preferred client to open this upload on the lane.
   *
   * `declaredSize` is the PLANNED ENCRYPTED total, never the file's own size: the
   * 5 GiB transfer cap bounds the encrypted stream, so the per-chunk overhead
   * eats into it, and at a 5 MB chunk size the largest decrypted file that still
   * fits is 5,368,690,862 bytes. Sending the decrypted size instead would wave
   * roughly 18 KB worth of files past this point and have them refused at the open.
   *
   * The mime type is deliberately generic. The gateway only requires a legal
   * non-empty value, and the real type is not known until the reader finishes —
   * strictly after the open. The file item still records the real type.
   */
  private async openSocketUpload(
    remoteIdentifier: string,
    sizeInBytes: number,
    ownershipType: FileOwnershipType,
    vault?: VaultListingInterface,
  ): Promise<
    { plan: UploadSizePlan; position: SocketFileUploadPosition; session: SocketFileUploadSession } | undefined
  > {
    if (!this.socketTransport) {
      return undefined
    }

    let plan: UploadSizePlan
    try {
      plan = planUploadSize(sizeInBytes, this.minimumChunkSize())
    } catch {
      return undefined
    }

    const api = new SocketPreferredFilesApi(this.api, this.socketTransport, this.sharedVaultOwnerResolver)
    const opened = await api.openSocketUpload({
      remoteIdentifier,
      fileUuid: remoteIdentifier,
      ownershipType,
      ...(vault && vault.isSharedVaultListing() ? { sharedVaultUuid: vault.sharing.sharedVaultUuid } : {}),
      decryptedSize: plan.decryptedSize,
      declaredSize: plan.encryptedSize,
      mimeType: 'application/octet-stream',
    })

    return opened ? { plan, position: opened.position, session: opened.session } : undefined
  }

  private async beginHttpFileUpload(
    fileParams: { key: string; remoteIdentifier: string; decryptedSize: number },
    sizeInBytes: number,
    ownershipType: FileOwnershipType,
    vault?: VaultListingInterface,
  ): Promise<EncryptAndUploadFileOperation | ClientDisplayableError> {
    const valetTokenResult =
      vault && vault.isSharedVaultListing()
        ? await this.createSharedVaultValetToken({
            sharedVaultUuid: vault.sharing.sharedVaultUuid,
            sharedVaultOwnerUuid: vault.sharing.ownerUserUuid,
            remoteIdentifier: fileParams.remoteIdentifier,
            operation: ValetTokenOperation.Write,
            unencryptedFileSizeForUpload: sizeInBytes,
          })
        : await this.createUserValetToken(fileParams.remoteIdentifier, ValetTokenOperation.Write, sizeInBytes)

    if (valetTokenResult instanceof ClientDisplayableError) {
      return valetTokenResult
    }

    const uploadOperation = new EncryptAndUploadFileOperation(
      fileParams,
      valetTokenResult,
      this.crypto,
      this.api,
      vault,
    )

    const uploadSessionStarted = await this.api.startUploadSession(valetTokenResult, ownershipType)

    if (isErrorResponse(uploadSessionStarted)) {
      return ClientDisplayableError.FromNetworkError(uploadSessionStarted)
    }

    if (!uploadSessionStarted.data.uploadId) {
      return new ClientDisplayableError('Could not start upload session')
    }

    return uploadOperation
  }

  public async pushBytesForUpload(
    operation: FileUploadOperation,
    bytes: Uint8Array,
    chunkId: number,
    isFinalChunk: boolean,
  ): Promise<ClientDisplayableError | undefined> {
    if (operation instanceof SocketUploadDriver) {
      const pushed = await operation.pushBytes(bytes, chunkId, isFinalChunk)

      if (pushed.outcome === 'failed') {
        return new ClientDisplayableError(`Failed to push file bytes to server (${pushed.code})`)
      }

      return undefined
    }

    const success = await operation.pushBytes(bytes, chunkId, isFinalChunk)

    if (!success) {
      return new ClientDisplayableError('Failed to push file bytes to server')
    }

    return undefined
  }

  public async finishUpload(
    operation: FileUploadOperation,
    fileMetadata: FileMetadata,
    uuid: string,
  ): Promise<FileItem | ClientDisplayableError> {
    /**
     * A socket upload is already published: `FILES_UPLOAD_FINISH` is its commit,
     * and it was written as soon as the last acknowledged byte reached
     * `declaredSize`. There is no HTTP session to close, and closing one would
     * need a WRITE valet token that was deliberately never minted.
     */
    const closable = operation.getValetToken()

    if (operation instanceof SocketUploadDriver && operation.transport === 'socket') {
      if (operation.completedSha256 === undefined) {
        return new ClientDisplayableError('File upload ended before the server published it')
      }
    } else if (closable === undefined) {
      return new ClientDisplayableError('Could not close upload session')
    } else {
      const uploadSessionClosed = await this.api.closeUploadSession(
        closable,
        operation.vault && operation.vault.isSharedVaultListing() ? 'shared-vault' : 'user',
      )

      if (uploadSessionClosed instanceof ClientDisplayableError) {
        return uploadSessionClosed
      }

      if (!uploadSessionClosed) {
        return new ClientDisplayableError('Could not close upload session')
      }
    }

    const result = operation.getResult()

    const fileContent: FileContentSpecialized = {
      decryptedSize: result.finalDecryptedSize,
      encryptedChunkSizes: operation.encryptedChunkSizes,
      encryptionHeader: result.encryptionHeader,
      key: result.key,
      mimeType: fileMetadata.mimeType,
      name: fileMetadata.name,
      remoteIdentifier: result.remoteIdentifier,
    }

    const filePayload = new DecryptedPayload<FileContent>({
      uuid,
      content_type: ContentType.TYPES.File,
      content: FillItemContent<FileContent>(FillItemContentSpecialized(fileContent)),
      dirty: true,
      ...PayloadVaultOverrides(operation.vault),
      ...PayloadTimestampDefaults(),
    })

    const fileItem = CreateItemFromPayload(filePayload) as DecryptedItemInterface<FileContent>

    const insertedItem = await this.mutator.insertItem<FileItem>(fileItem)

    await this.sync.sync()

    return insertedItem
  }

  private async decryptCachedEntry(file: FileItem, entry: EncryptedBytes): Promise<DecryptedBytes | undefined> {
    try {
      const decryptOperation = new FileDecryptor(file, this.crypto)
      const decryptedChunks: Uint8Array[] = []
      let decryptedSize = 0
      let authenticatedChunks = 0
      let finalSeen = false
      let integrityFailed = false

      const orderedChunker = new OrderedByteChunker(file.encryptedChunkSizes, 'memcache', async (chunk) => {
        if (integrityFailed || finalSeen) {
          integrityFailed = true
          return
        }

        const decryptedBytes = decryptOperation.decryptBytes(chunk.data)
        if (!decryptedBytes || decryptedBytes.isFinalChunk !== chunk.isLast) {
          integrityFailed = true
          return
        }

        decryptedChunks.push(decryptedBytes.decryptedBytes)
        decryptedSize += decryptedBytes.decryptedBytes.byteLength
        authenticatedChunks += 1
        finalSeen = decryptedBytes.isFinalChunk
      })

      await orderedChunker.addBytes(entry.encryptedBytes)
      orderedChunker.finish()

      if (integrityFailed || !finalSeen || authenticatedChunks !== file.encryptedChunkSizes.length) {
        return undefined
      }

      const decryptedAggregate = new Uint8Array(decryptedSize)
      let offset = 0
      for (const chunk of decryptedChunks) {
        decryptedAggregate.set(chunk, offset)
        offset += chunk.byteLength
      }

      return { decryptedBytes: decryptedAggregate }
    } catch {
      return undefined
    }
  }

  public async downloadFile(
    file: FileItem,
    onDecryptedBytes: (decryptedBytes: Uint8Array, progress: FileDownloadProgress) => Promise<void>,
    options?: { signal?: AbortSignal },
  ): Promise<ClientDisplayableError | undefined> {
    // Honor an already-cancelled request before doing any work. This single entry pre-check
    // also covers the cache/backup branches below (both are local and fast — there is no
    // in-flight network operation to tear down there).
    if (options?.signal?.aborted) {
      return undefined
    }

    if (file.localOnly) {
      return this.downloadLocalOnlyFile(file, onDecryptedBytes)
    }

    const cachedBytes = this.encryptedCache.get(file.uuid)

    if (cachedBytes) {
      const decryptedBytes = await this.decryptCachedEntry(file, cachedBytes)
      if (!decryptedBytes) {
        return new ClientDisplayableError('Cached file data failed its integrity check.')
      }

      await onDecryptedBytes(decryptedBytes.decryptedBytes, {
        encryptedFileSize: cachedBytes.encryptedBytes.length,
        encryptedBytesDownloaded: cachedBytes.encryptedBytes.length,
        encryptedBytesRemaining: 0,
        percentComplete: 100,
        source: 'memcache',
      })

      return undefined
    }

    const fileBackup = await this.backupsService?.getFileBackupInfo(file)

    if (this.backupsService && fileBackup) {
      this.logger.info('Downloading file from backup', fileBackup)

      const backupResult = await readAndDecryptBackupFileUsingBackupService(
        file,
        this.backupsService,
        this.crypto,
        async (chunk) => {
          this.logger.info('Got local file chunk', chunk.progress)

          return onDecryptedBytes(chunk.data, chunk.progress)
        },
      )

      if (backupResult === 'aborted') {
        return undefined
      }
      if (backupResult === 'failed') {
        return new ClientDisplayableError('Backup file data failed its integrity check.')
      }

      this.logger.info('Finished downloading file from backup')

      return undefined
    } else {
      this.logger.info('Downloading file from network')

      const addToCache = file.encryptedSize < this.encryptedCache.maxSize

      const cacheEntryChunks: Uint8Array[] = []
      let cacheEntrySize = 0

      if (options?.signal?.aborted) {
        return undefined
      }

      /**
       * The READ token is minted lazily, by the wrapper below, only if the HTTP
       * client is actually reached. A socket download never mints one — it is the
       * gateway, not this client, that authorizes that lane — and an eager mint
       * there is a wasted authenticated round trip on every single image view.
       *
       * The decision cannot be taken here: `isFileLaneAvailable()` answers for
       * this instant, and the lane can still be gone by the time the bytes move.
       * Deferring the mint all the way down to the one call that transmits a
       * token means every fallback — lane never negotiated, owner unresolvable,
       * socket failed with nothing delivered — still mints, just later.
       */
      const downloadApi = this.downloadApiOver(
        new LazyReadValetTokenFilesApi(this.api, () => this.createReadValetToken(file)),
      )

      const operation = new DownloadAndDecryptFileOperation(
        file,
        this.crypto,
        downloadApi,
        DeferredReadValetTokenPlaceholder,
      )

      // Tear down the in-flight download/decrypt if the caller aborts (e.g. the preview modal
      // is closed mid-download). Always remove the listener when this run settles;
      // `{ once: true }` only cleans up the path where the signal actually fires.
      const abortOperation = () => operation.abort()
      options?.signal?.addEventListener('abort', abortOperation, { once: true })

      let result: DownloadAndDecryptResult
      try {
        result = await operation.run(async ({ decrypted, encrypted, progress }): Promise<void> => {
          if (addToCache) {
            cacheEntryChunks.push(encrypted.encryptedBytes)
            cacheEntrySize += encrypted.encryptedBytes.byteLength
          }
          return onDecryptedBytes(decrypted.decryptedBytes, progress)
        })
      } finally {
        options?.signal?.removeEventListener('abort', abortOperation)
      }

      if (result.success && addToCache && cacheEntrySize > 0) {
        const cacheEntryAggregate = new Uint8Array(cacheEntrySize)
        let offset = 0
        for (const chunk of cacheEntryChunks) {
          cacheEntryAggregate.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.encryptedCache.add(file.uuid, { encryptedBytes: cacheEntryAggregate })
      }

      return result.error
    }
  }

  public async deleteFile(file: FileItem): Promise<ClientDisplayableError | undefined> {
    this.encryptedCache.remove(file.uuid)

    if (file.localOnly) {
      if (this.localFileBackend) {
        await this.localFileBackend.removeEncryptedBytes(file.uuid).catch(() => undefined)
      }
      await this.mutator.setItemToBeDeleted(file)
      await this.sync.sync()
      return undefined
    }

    const tokenResult = file.shared_vault_uuid
      ? await this.createSharedVaultValetToken({
          sharedVaultUuid: file.shared_vault_uuid,
          remoteIdentifier: file.remoteIdentifier,
          operation: ValetTokenOperation.Delete,
          fileUuidRequiredForExistingFiles: file.uuid,
        })
      : await this.createUserValetToken(file.remoteIdentifier, ValetTokenOperation.Delete)

    if (tokenResult instanceof ClientDisplayableError) {
      return tokenResult
    }

    const result = await this.api.deleteFile(tokenResult, file.shared_vault_uuid ? 'shared-vault' : 'user')

    if (isErrorResponse(result)) {
      const failure = diagnoseDeleteFileFailure(result)

      this.logger.error(
        `Server delete failed for file ${file.uuid} (remote identifier ${file.remoteIdentifier}): ` +
          `${failure.kind}, status ${result.status}, server said "${failure.serverMessage}"`,
      )

      // A transport failure or an expired credential is no evidence that the
      // file is gone, so removing the item locally would silently orphan it.
      // Report what actually happened and stop.
      if (!failure.offerLocalRemoval) {
        await this.alertService.alert(failure.text, failure.title)

        return new ClientDisplayableError(failure.text, failure.title, failure.kind)
      }

      const deleteAnyway = await this.alertService.confirm(
        failure.text,
        failure.title,
        'Remove From Account',
        ButtonType.Danger,
      )

      if (!deleteAnyway) {
        return new ClientDisplayableError(failure.text, failure.title, failure.kind)
      }
    }

    await this.mutator.setItemToBeDeleted(file)
    await this.sync.sync()

    return undefined
  }

  public isFileNameFileBackupRelated(name: string): 'metadata' | 'binary' | false {
    if (name === FileBackupsConstantsV1.MetadataFileName) {
      return 'metadata'
    } else if (name === FileBackupsConstantsV1.BinaryFileName) {
      return 'binary'
    }

    return false
  }

  public async decryptBackupMetadataFile(metdataFile: FileBackupMetadataFile): Promise<FileItem | undefined> {
    const encryptedItemsKey = new EncryptedPayload({
      ...metdataFile.itemsKey,
      waitingForKey: false,
      errorDecrypting: false,
    })

    const decryptedItemsKeyResult = await DecryptItemsKeyWithUserFallback(
      encryptedItemsKey,
      this.encryptor,
      this.challengor,
    )

    if (decryptedItemsKeyResult === 'failed' || decryptedItemsKeyResult === 'aborted') {
      return undefined
    }

    const encryptedFile = new EncryptedPayload({ ...metdataFile.file, waitingForKey: false, errorDecrypting: false })

    const itemsKey = new SNItemsKey(decryptedItemsKeyResult)

    const decryptedFile = await this.encryptor.decryptSplitSingle<FileContent>({
      usesItemsKey: {
        items: [encryptedFile],
        key: itemsKey,
      },
    })

    if (isEncryptedPayload(decryptedFile)) {
      return undefined
    }

    return new FileItem(decryptedFile)
  }

  public async selectFile(fileSystem: FileSystemApi): Promise<FileHandleRead | FileSystemNoSelection> {
    const result = await fileSystem.selectFile()

    return result
  }

  public async readBackupFileAndSaveDecrypted(
    fileHandle: FileHandleRead,
    file: FileItem,
    fileSystem: FileSystemApi,
  ): Promise<'success' | 'aborted' | 'failed'> {
    const destinationDirectoryHandle = await fileSystem.selectDirectory()

    if (destinationDirectoryHandle === 'aborted' || destinationDirectoryHandle === 'failed') {
      return destinationDirectoryHandle
    }

    const destinationFileHandle = await fileSystem.createFile(destinationDirectoryHandle, file.name)

    if (destinationFileHandle === 'aborted' || destinationFileHandle === 'failed') {
      return destinationFileHandle
    }

    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      fileHandle,
      file,
      fileSystem,
      this.crypto,
      async (decryptedBytes) => {
        await fileSystem.saveBytes(destinationFileHandle, decryptedBytes)
      },
    )

    const closeResult = await fileSystem.closeFileWriteStream(destinationFileHandle)
    if (result === 'success' && closeResult !== 'success') {
      return 'failed'
    }

    return result
  }

  public async readBackupFileBytesDecrypted(
    fileHandle: FileHandleRead,
    file: FileItem,
    fileSystem: FileSystemApi,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let totalSize = 0

    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      fileHandle,
      file,
      fileSystem,
      this.crypto,
      async (decryptedBytes) => {
        chunks.push(decryptedBytes)
        totalSize += decryptedBytes.byteLength
      },
    )

    if (result !== 'success') {
      throw new Error(`Unable to authenticate and decrypt backup file: ${result}`)
    }

    const bytes = new Uint8Array(totalSize)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return bytes
  }
}
