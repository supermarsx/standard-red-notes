import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { ListSharesDTO } from './ListSharesDTO'

export class ListShares implements UseCaseInterface<Share[]> {
  constructor(private shareRepository: ShareRepositoryInterface) {}

  async execute(dto: ListSharesDTO): Promise<Result<Share[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list shares: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    await this.shareRepository.revokeExpiredAndErasePayloads(new Date(), userUuid)
    const shares = await this.shareRepository.findByUserUuid(userUuid)

    return Result.ok(shares)
  }
}
