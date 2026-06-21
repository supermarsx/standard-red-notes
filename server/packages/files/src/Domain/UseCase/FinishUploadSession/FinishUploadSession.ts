import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { FinishUploadSessionDTO } from './FinishUploadSessionDTO'
import { FileUploaderInterface } from '../../Services/FileUploaderInterface'
import { UploadRepositoryInterface } from '../../Upload/UploadRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { ValetTokenRepositoryInterface } from '../../ValetToken/ValetTokenRepositoryInterface'

export class FinishUploadSession implements UseCaseInterface<void> {
  constructor(
    private fileUploader: FileUploaderInterface,
    private uploadRepository: UploadRepositoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private valetTokenRepository: ValetTokenRepositoryInterface,
    // Standard Red Notes: operator-configurable ABSOLUTE cap on the size of a single
    // uploaded file (bytes). Unlike the per-user subscription quota (uploadBytesLimit),
    // this applies even to "unlimited" accounts (uploadBytesLimit === -1), giving
    // self-hosted operators a hard per-file bound on disk/bandwidth use. A value <= 0
    // disables the cap (unlimited per-file size, prior behaviour).
    private maxAttachmentByteSize: number = 0,
  ) {}

  async execute(dto: FinishUploadSessionDTO): Promise<Result<void>> {
    try {
      const userUuidOrError = Uuid.create(dto.userUuid)
      if (userUuidOrError.isFailed()) {
        return Result.fail(userUuidOrError.getError())
      }
      const userUuid = userUuidOrError.getValue()

      let sharedVaultUuid: Uuid | undefined
      if (dto.sharedVaultUuid !== undefined) {
        const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUuid)
        if (sharedVaultUuidOrError.isFailed()) {
          return Result.fail(sharedVaultUuidOrError.getError())
        }
        sharedVaultUuid = sharedVaultUuidOrError.getValue()
      }

      const filePath = `${sharedVaultUuid ? sharedVaultUuid.value : userUuid.value}/${dto.resourceRemoteIdentifier}`

      const uploadId = await this.uploadRepository.retrieveUploadSessionId(filePath)
      if (uploadId === undefined) {
        return Result.fail('Could not finish upload session')
      }

      const uploadChunkResults = await this.uploadRepository.retrieveUploadChunkResults(uploadId)

      let totalFileSize = 0
      for (const uploadChunkResult of uploadChunkResults) {
        totalFileSize += uploadChunkResult.chunkSize
      }

      // Absolute per-file cap enforced regardless of subscription/unlimited status.
      if (this.maxAttachmentByteSize > 0 && totalFileSize > this.maxAttachmentByteSize) {
        return Result.fail(
          `Could not finish upload session. The file exceeds the maximum allowed size of ` +
            `${this.maxAttachmentByteSize} bytes.`,
        )
      }

      const userHasUnlimitedStorage = dto.uploadBytesLimit === -1
      const remainingSpaceLeft = dto.uploadBytesLimit - dto.uploadBytesUsed
      if (!userHasUnlimitedStorage && remainingSpaceLeft < totalFileSize) {
        return Result.fail('Could not finish upload session. You are out of space.')
      }

      await this.fileUploader.finishUploadSession(uploadId, filePath, uploadChunkResults)

      if (sharedVaultUuid !== undefined) {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createSharedVaultFileUploadedEvent({
            sharedVaultUuid: sharedVaultUuid.value,
            vaultOwnerUuid: userUuid.value,
            filePath,
            fileName: dto.resourceRemoteIdentifier,
            fileByteSize: totalFileSize,
          }),
        )
      } else {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createFileUploadedEvent({
            userUuid: userUuid.value,
            filePath,
            fileName: dto.resourceRemoteIdentifier,
            fileByteSize: totalFileSize,
          }),
        )
      }

      await this.valetTokenRepository.markAsUsed(dto.valetToken)

      return Result.ok()
    } catch (_error) {
      return Result.fail('Could not finish upload session')
    }
  }
}
