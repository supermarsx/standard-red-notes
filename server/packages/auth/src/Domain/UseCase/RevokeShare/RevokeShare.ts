import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { RevokeShareDTO } from './RevokeShareDTO'

export class RevokeShare implements UseCaseInterface<string> {
  constructor(private shareRepository: ShareRepositoryInterface) {}

  async execute(dto: RevokeShareDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not revoke share: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const share = await this.shareRepository.findById(new UniqueEntityId(dto.shareId))
    // Ownership check: never allow revoking another user's share.
    if (!share || share.props.userUuid !== userUuid.value) {
      return Result.fail('Share not found')
    }

    // Keep metadata for the owner's history, erase the served ciphertext atomically.
    await this.shareRepository.markRevoked(new UniqueEntityId(share.id.toString()))

    return Result.ok('Share revoked')
  }
}
