import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { inject, injectable } from 'inversify'
import { Logger } from 'winston'

import TYPES from '../../../Bootstrap/Types'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { FileRemoverInterface } from '../../Services/FileRemoverInterface'
import { isObjectAbsentError } from '../../Services/isObjectAbsentError'
import { RemoveFileDTO } from './RemoveFileDTO'
import { FileRemovalOutcome } from './FileRemovalOutcome'
import { safeErrorLogMetadata, Result, UseCaseInterface } from '@standardnotes/domain-core'
import { ValetTokenRepositoryInterface } from '../../ValetToken/ValetTokenRepositoryInterface'

export const REMOVE_FILE_STORAGE_FAILURE_MESSAGE = 'Could not remove the file from server storage'
export const REMOVE_FILE_NO_INPUT_MESSAGE = 'Could not remove file'

@injectable()
export class RemoveFile implements UseCaseInterface<FileRemovalOutcome> {
  constructor(
    @inject(TYPES.Files_FileRemover) private fileRemover: FileRemoverInterface,
    @inject(TYPES.Files_DomainEventPublisher) private domainEventPublisher: DomainEventPublisherInterface,
    @inject(TYPES.Files_DomainEventFactory) private domainEventFactory: DomainEventFactoryInterface,
    @inject(TYPES.Files_ValetTokenRepository) private valetTokenRepository: ValetTokenRepositoryInterface,
    @inject(TYPES.Files_Logger) private logger: Logger,
  ) {}

  async execute(dto: RemoveFileDTO): Promise<Result<FileRemovalOutcome>> {
    const resourceUuid = dto.userInput?.resourceRemoteIdentifier ?? dto.vaultInput?.resourceRemoteIdentifier

    const ownerUuid = dto.userInput?.userUuid ?? dto.vaultInput?.sharedVaultUuid

    if (dto.userInput === undefined && dto.vaultInput === undefined) {
      return Result.fail(REMOVE_FILE_NO_INPUT_MESSAGE)
    }

    try {
      this.logger.debug(`Removing file: ${resourceUuid}`)

      const filePath = `${ownerUuid}/${resourceUuid}`

      // Delete is idempotent. An authorized caller asking us to remove an object
      // that storage no longer holds has already got what it asked for, so this
      // reports success rather than the opaque failure it used to — that failure
      // is what drove the client to accuse the user of owning someone else's
      // file. Absence is read from the storage error and nothing else: a real
      // outage still fails loudly below.
      let removedFileSize: number | undefined
      try {
        removedFileSize = await this.fileRemover.remove(filePath)
      } catch (error) {
        if (!isObjectAbsentError(error)) {
          throw error
        }

        this.logger.debug(`File was already absent from storage: ${filePath}`)

        // No bytes left storage, so no quota event is published — emitting one
        // would credit the account for a file it is not being charged for.
        await this.valetTokenRepository.markAsUsed(dto.valetToken)

        return Result.ok('already-absent')
      }

      if (dto.userInput !== undefined) {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createFileRemovedEvent({
            userUuid: dto.userInput.userUuid,
            filePath: `${dto.userInput.userUuid}/${dto.userInput.resourceRemoteIdentifier}`,
            fileName: dto.userInput.resourceRemoteIdentifier,
            fileByteSize: removedFileSize,
          }),
        )
      } else if (dto.vaultInput !== undefined) {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createSharedVaultFileRemovedEvent({
            sharedVaultUuid: dto.vaultInput.sharedVaultUuid,
            vaultOwnerUuid: dto.vaultInput.vaultOwnerUuid,
            filePath: `${dto.vaultInput.sharedVaultUuid}/${dto.vaultInput.resourceRemoteIdentifier}`,
            fileName: dto.vaultInput.resourceRemoteIdentifier,
            fileByteSize: removedFileSize,
          }),
        )
      }

      await this.valetTokenRepository.markAsUsed(dto.valetToken)

      return Result.ok('removed')
    } catch (error) {
      this.logger.error(`Could not remove resource: ${resourceUuid}.`, safeErrorLogMetadata(error))

      return Result.fail(REMOVE_FILE_STORAGE_FAILURE_MESSAGE)
    }
  }
}
