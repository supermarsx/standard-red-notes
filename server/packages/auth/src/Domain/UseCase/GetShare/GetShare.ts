import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'

import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { GetShareDTO } from './GetShareDTO'
import { GetShareResult } from './GetShareResult'

/**
 * PUBLIC, unauthenticated read path. Anyone holding the share link id can fetch
 * the opaque ciphertext. Returns the payload ONLY when the share exists and has
 * not been revoked. Never leaks the owning user's uuid.
 */
export class GetShare implements UseCaseInterface<GetShareResult> {
  constructor(private shareRepository: ShareRepositoryInterface) {}

  async execute(dto: GetShareDTO): Promise<Result<GetShareResult>> {
    const share = await this.shareRepository.findById(new UniqueEntityId(dto.shareId))

    if (!share || share.props.revoked) {
      return Result.fail('Share not found')
    }

    return Result.ok({
      type: share.props.type,
      encryptedPayload: share.props.encryptedPayload,
    })
  }
}
