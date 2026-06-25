import { Email, Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateDeadManSwitchDTO } from './CreateDeadManSwitchDTO'
import { CreateDeadManSwitchResult } from './CreateDeadManSwitchResult'

const MS_PER_DAY = 86_400_000

export class CreateDeadManSwitch implements UseCaseInterface<CreateDeadManSwitchResult> {
  constructor(
    private deadManSwitchRepository: DeadManSwitchRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: CreateDeadManSwitchDTO): Promise<Result<CreateDeadManSwitchResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create dead man switch: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not create dead man switch: user not found.')
    }

    const recipientEmailOrError = Email.create(dto.recipientEmail)
    if (recipientEmailOrError.isFailed()) {
      return Result.fail(`Could not create dead man switch: ${recipientEmailOrError.getError()}`)
    }
    const recipientEmail = recipientEmailOrError.getValue()

    if (typeof dto.shareUrl !== 'string' || dto.shareUrl.trim().length === 0) {
      return Result.fail('Could not create dead man switch: share url is required.')
    }

    // The shareUrl is later embedded verbatim into an outbound email, so it must
    // be a well-formed https URL. Reject non-https (incl. javascript:, data:,
    // http:) so it can never become a hostile link in the delivered message.
    const trimmedShareUrl = dto.shareUrl.trim()
    let parsedShareUrl: URL
    try {
      parsedShareUrl = new URL(trimmedShareUrl)
    } catch {
      return Result.fail('Could not create dead man switch: share url must be a valid URL.')
    }
    if (parsedShareUrl.protocol !== 'https:') {
      return Result.fail('Could not create dead man switch: share url must be an https URL.')
    }

    if (typeof dto.intervalDays !== 'number' || !Number.isInteger(dto.intervalDays) || dto.intervalDays < 1) {
      return Result.fail('Could not create dead man switch: interval must be a whole number of at least 1 day.')
    }

    const message =
      dto.message !== undefined && dto.message !== null && dto.message.trim().length > 0 ? dto.message.trim() : null

    const now = Date.now()
    const deadline = now + dto.intervalDays * MS_PER_DAY

    const switchOrError = DeadManSwitch.create({
      userUuid: userUuid.value,
      recipientEmail: recipientEmail.value,
      shareUrl: trimmedShareUrl,
      message,
      intervalDays: dto.intervalDays,
      deadline,
      triggered: false,
      lastCheckInAt: null,
      createdAt: now,
      sendAttempts: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastError: null,
    })
    if (switchOrError.isFailed()) {
      return Result.fail(`Could not create dead man switch: ${switchOrError.getError()}`)
    }
    const deadManSwitch = switchOrError.getValue()

    await this.deadManSwitchRepository.save(deadManSwitch)

    return Result.ok({
      uuid: deadManSwitch.id.toString(),
      recipientEmail: recipientEmail.value,
      message,
      intervalDays: dto.intervalDays,
      deadline,
      triggered: false,
      lastCheckInAt: null,
      createdAt: now,
    })
  }
}
