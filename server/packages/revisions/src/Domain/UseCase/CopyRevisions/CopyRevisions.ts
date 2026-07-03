import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Revision } from '../../Revision/Revision'

import { CopyRevisionsDTO } from './CopyRevisionsDTO'
import { RevisionRepositoryInterface } from '../../Revision/RevisionRepositoryInterface'

export class CopyRevisions implements UseCaseInterface<string> {
  constructor(private revisionRepository: RevisionRepositoryInterface) {}

  async execute(dto: CopyRevisionsDTO): Promise<Result<string>> {
    const orignalItemUuidOrError = Uuid.create(dto.originalItemUuid)
    if (orignalItemUuidOrError.isFailed()) {
      return Result.fail<string>(`Could not copy revisions: ${orignalItemUuidOrError.getError()}`)
    }
    const originalItemUuid = orignalItemUuidOrError.getValue()

    const newItemUuidOrError = Uuid.create(dto.newItemUuid)
    if (newItemUuidOrError.isFailed()) {
      return Result.fail<string>(`Could not copy revisions: ${newItemUuidOrError.getError()}`)
    }
    const newItemUuid = newItemUuidOrError.getValue()

    // Idempotency guard: event delivery is at-least-once, so a redelivered copy
    // request must not duplicate revisions. If the target item already has any
    // revisions, a previous copy already completed (mid-copy failures roll back the
    // whole batch below, leaving the target empty), so treat this as a no-op.
    const existingCopiesCount = await this.revisionRepository.countByItemUuid(newItemUuid)
    if (existingCopiesCount > 0) {
      return Result.ok<string>('Revisions already copied')
    }

    const revisions = await this.revisionRepository.findByItemUuid(originalItemUuid)

    const revisionCopies: Revision[] = []
    for (const existingRevision of revisions) {
      const revisionCopyOrError = Revision.create({
        ...existingRevision.props,
        itemUuid: newItemUuid,
      })

      if (revisionCopyOrError.isFailed()) {
        return Result.fail<string>(`Could not create revision copy: ${revisionCopyOrError.getError()}`)
      }

      revisionCopies.push(revisionCopyOrError.getValue())
    }

    // Transactional, batched insert: all copies land atomically or none do.
    await this.revisionRepository.insertMany(revisionCopies)

    return Result.ok<string>('Revisions copied')
  }
}
