import { Result, UseCaseInterface, Uuid, Validator } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { DumpRepositoryInterface } from '../../Dump/DumpRepositoryInterface'
import { CreateRevisionFromDumpDTO } from './CreateRevisionFromDumpDTO'
import { RevisionRepositoryInterface } from '../../Revision/RevisionRepositoryInterface'

export class CreateRevisionFromDump implements UseCaseInterface<void> {
  constructor(
    private dumpRepository: DumpRepositoryInterface,
    private revisionRepository: RevisionRepositoryInterface,
    private timer: TimerInterface,
    private retentionDays: number,
    private maxCountPerItem: number,
  ) {}

  async execute(dto: CreateRevisionFromDumpDTO): Promise<Result<void>> {
    const filePathValidationResult = Validator.isNotEmptyString(dto.filePath)
    if (filePathValidationResult.isFailed()) {
      return Result.fail(`Could not create revision from dump: ${filePathValidationResult.getError()}`)
    }

    const revisionOrError = await this.dumpRepository.getRevisionFromDumpPath(dto.filePath)
    if (revisionOrError.isFailed()) {
      await this.dumpRepository.removeDump(dto.filePath)

      return Result.fail(`Could not create revision from dump: ${revisionOrError.getError()}`)
    }
    const revision = revisionOrError.getValue()

    const successfullyInserted = await this.revisionRepository.insert(revision)
    if (!successfullyInserted) {
      await this.dumpRepository.removeDump(dto.filePath)

      return Result.fail(`Could not insert revision from dump: ${revision.id.toString()}`)
    }

    await this.pruneRevisions(revision.props.itemUuid)

    await this.dumpRepository.removeDump(dto.filePath)

    return Result.ok()
  }

  private async pruneRevisions(itemUuid: Uuid): Promise<void> {
    if (this.retentionDays > 0) {
      const nowInMilliseconds = this.timer.getTimestampInMicroseconds() / 1000
      const cutoffDate = new Date(nowInMilliseconds - this.retentionDays * 24 * 60 * 60 * 1000)
      await this.revisionRepository.removeByItemUuidOlderThan(itemUuid, cutoffDate)
    }

    if (this.maxCountPerItem > 0) {
      await this.revisionRepository.removeByItemUuidBeyondCount(itemUuid, this.maxCountPerItem)
    }
  }
}
