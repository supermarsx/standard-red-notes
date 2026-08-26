import {
  ClientDisplayableError,
  HttpResponse,
  StartUploadSessionResponse,
  ValetTokenOperation,
} from '@standardnotes/responses'
import { DownloadFileParams } from './DownloadFileParams'
import { FileOwnershipType } from './FileOwnershipType'
import { FilesApiInterface } from './FilesApiInterface'
import { FileSocketTransportInterface } from './FileSocketTransportInterface'
import { OrderedByteChunker } from '../Chunker/OrderedByteChunker'

/**
 * Prefers an already-negotiated realtime socket for file downloads, and is a
 * transparent pass-through to the HTTP client for everything else.
 *
 * Shape of the decision, in order of how much it matters:
 *
 * 1. **The lane is used only when the server says it exists.** `isFileLaneAvailable()`
 *    reads the operation list the gateway sent at AUTHENTICATED. Absent — which is
 *    what nearly every deployment reports — this class does nothing but delegate,
 *    so the HTTP path is not merely still available, it is still the only code
 *    that runs.
 * 2. **HTTP remains the fallback, but never a replay.** The file decryptor is
 *    stateful and chunk-ordered. Falling back after bytes have been handed to it
 *    would decrypt the head of the file twice, so fallback is permitted only
 *    while the transport proves nothing was delivered.
 * 3. **Uploads are not on this lane yet.** They are delegated unchanged. An upload
 *    that dies mid-flight may already have been applied server-side, and honest
 *    recovery for that needs the resume protocol, not a retry.
 * 4. **Shared-vault downloads need the vault's owner, and will not invent one.**
 *    HTTP carries the owner as request context; the socket must name it in the
 *    resource itself. When it cannot be resolved from the vault listing that
 *    records it, the download goes over HTTP rather than guessing.
 *
 * Authorization is unchanged: the socket path sends only a resource reference and
 * the gateway mints its own single-use credential per operation, so nothing here
 * can move bytes that the HTTP path would have refused.
 */
export class SocketPreferredFilesApi implements FilesApiInterface {
  constructor(
    private readonly http: FilesApiInterface,
    private readonly socket: FileSocketTransportInterface,
    /**
     * Resolves a shared vault's owner from the vault listing that records it.
     * Returning `undefined` — no such vault known locally — sends the download
     * over HTTP. It must never guess: the owner is cross-checked server-side
     * against the credential the gateway mints, so a fabricated value would fail
     * closed and read as a permissions bug rather than as the missing lookup it is.
     */
    private readonly resolveSharedVaultOwnerUuid?: (sharedVaultUuid: string) => string | undefined,
  ) {}

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

  async downloadFile(params: DownloadFileParams): Promise<ClientDisplayableError | undefined> {
    if (!this.canUseSocketFor(params)) {
      return this.http.downloadFile(params)
    }

    const sharedVault = this.sharedVaultReferenceFor(params)
    if (params.ownershipType === 'shared-vault' && !sharedVault) {
      // The vault's owner is not known locally, so there is nothing honest to
      // send. HTTP carries the owner as request context instead and does not
      // need it resolved here.
      return this.http.downloadFile(params)
    }

    const declaredSize = params.file.encryptedChunkSizes.reduce((total, size) => total + size, 0)

    let chunker: OrderedByteChunker
    try {
      // The socket's frame size (256 KiB) has nothing to do with this file's
      // encrypted chunk boundaries, so the arriving stream is re-cut to the exact
      // sizes the decryptor authenticated. Downstream therefore cannot tell which
      // transport delivered the bytes.
      chunker = new OrderedByteChunker(params.file.encryptedChunkSizes.slice(), 'network', async (chunk) => {
        await params.onBytesReceived(chunk.data)
      })
    } catch {
      return this.http.downloadFile(params)
    }

    let delivered = false
    const result = await this.socket.downloadFileOverSocket({
      remoteIdentifier: params.file.remoteIdentifier,
      fileUuid: params.file.uuid,
      declaredSize,
      ...(sharedVault ? { sharedVault } : {}),
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      onBytes: async (bytes) => {
        delivered = true
        await chunker.addBytes(bytes)
      },
    })

    if (result.outcome === 'completed') {
      try {
        chunker.finish()
      } catch (error) {
        return new ClientDisplayableError(
          error instanceof Error ? error.message : 'File download ended before its declared final chunk.',
        )
      }
      return undefined
    }

    if (result.outcome === 'aborted') {
      // Matches the HTTP path, which also reports an aborted download as a
      // non-error so the caller can distinguish cancellation from failure.
      return undefined
    }

    if (result.outcome === 'unavailable') {
      return this.http.downloadFile(params)
    }

    if (result.safeToFallback && !delivered) {
      return this.http.downloadFile(params)
    }

    return new ClientDisplayableError(`File download over the realtime transport failed (${result.code}).`)
  }

  /**
   * The shared-vault half of the wire reference, or `undefined` when it cannot be
   * established from local state.
   *
   * The owner comes from the vault listing's own `sharing.ownerUserUuid` and from
   * nowhere else. There is deliberately no fallback: the gateway cross-checks this
   * against the credential it mints itself, so a guessed value fails closed and
   * would surface as an inexplicable permission error instead of the plain
   * "this vault isn't loaded yet" that it actually is.
   */
  private sharedVaultReferenceFor(
    params: DownloadFileParams,
  ): { sharedVaultUuid: string; sharedVaultOwnerUuid: string } | undefined {
    const sharedVaultUuid = params.file.shared_vault_uuid
    if (params.ownershipType !== 'shared-vault' || !sharedVaultUuid) {
      return undefined
    }
    const sharedVaultOwnerUuid = this.resolveSharedVaultOwnerUuid?.(sharedVaultUuid)
    return sharedVaultOwnerUuid ? { sharedVaultUuid, sharedVaultOwnerUuid } : undefined
  }

  private canUseSocketFor(params: DownloadFileParams): boolean {
    return (
      this.socket.isFileLaneAvailable() &&
      (params.ownershipType === 'user' || params.ownershipType === 'shared-vault') &&
      // Only a whole-file download from byte zero. A resumed or partial range has
      // no socket equivalent yet, and reinterpreting one as a full download would
      // silently return the wrong bytes.
      params.chunkIndex === 0 &&
      params.contentRangeStart === 0 &&
      params.file.encryptedChunkSizes.length > 0 &&
      params.shouldAbort?.() !== true
    )
  }
}
