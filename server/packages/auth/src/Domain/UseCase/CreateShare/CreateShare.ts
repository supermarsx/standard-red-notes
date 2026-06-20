import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateShareDTO } from './CreateShareDTO'
import { CreateShareResult } from './CreateShareResult'

export class CreateShare implements UseCaseInterface<CreateShareResult> {
  constructor(
    private shareRepository: ShareRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: CreateShareDTO): Promise<Result<CreateShareResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create share: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not create share: user not found.')
    }

    if (dto.type !== 'note' && dto.type !== 'tag' && dto.type !== 'account') {
      return Result.fail('Could not create share: type must be one of note, tag or account.')
    }
    const type = dto.type as 'note' | 'tag' | 'account'

    if (typeof dto.encryptedPayload !== 'string' || dto.encryptedPayload.length === 0) {
      return Result.fail('Could not create share: encrypted payload is required.')
    }

    const nickname =
      dto.nickname !== undefined && dto.nickname !== null && dto.nickname.trim().length > 0
        ? dto.nickname.trim()
        : null

    const oneTimeView = dto.oneTimeView === true

    let viewExpiresMinutes: number | null = null
    if (dto.viewExpiresMinutes !== undefined && dto.viewExpiresMinutes !== null) {
      const minutes = Number(dto.viewExpiresMinutes)
      if (!Number.isInteger(minutes) || minutes <= 0) {
        return Result.fail('Could not create share: view expiry minutes must be a positive integer.')
      }
      viewExpiresMinutes = minutes
    }

    const createdAt = new Date()

    const shareOrError = Share.create({
      userUuid: userUuid.value,
      type,
      encryptedPayload: dto.encryptedPayload,
      nickname,
      createdAt,
      revoked: false,
      oneTimeView,
      viewExpiresMinutes,
      firstOpenedAt: null,
    })
    if (shareOrError.isFailed()) {
      return Result.fail(`Could not create share: ${shareOrError.getError()}`)
    }
    const share = shareOrError.getValue()

    await this.shareRepository.save(share)

    return Result.ok({
      shareId: share.id.toString(),
      type,
      nickname,
      createdAt,
      oneTimeView,
      viewExpiresMinutes,
    })
  }
}
