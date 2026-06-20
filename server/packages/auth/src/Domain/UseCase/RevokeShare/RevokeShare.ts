import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
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

    // Soft-revoke: keep the row but stop it resolving from the public read path.
    const revokedOrError = Share.create(
      {
        userUuid: share.props.userUuid,
        type: share.props.type,
        encryptedPayload: share.props.encryptedPayload,
        nickname: share.props.nickname,
        createdAt: share.props.createdAt,
        revoked: true,
        oneTimeView: share.props.oneTimeView,
        viewExpiresMinutes: share.props.viewExpiresMinutes,
        firstOpenedAt: share.props.firstOpenedAt,
      },
      new UniqueEntityId(share.id.toString()),
    )
    if (revokedOrError.isFailed()) {
      return Result.fail(`Could not revoke share: ${revokedOrError.getError()}`)
    }

    await this.shareRepository.save(revokedOrError.getValue())

    return Result.ok('Share revoked')
  }
}
