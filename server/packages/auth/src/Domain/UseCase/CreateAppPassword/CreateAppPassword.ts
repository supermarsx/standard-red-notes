import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateAppPasswordDTO } from './CreateAppPasswordDTO'
import { CreateAppPasswordResult } from './CreateAppPasswordResult'

export class CreateAppPassword implements UseCaseInterface<CreateAppPasswordResult> {
  /**
   * Number of random bytes for the generated secret. 32 bytes (256 bits) of
   * entropy, base64url-encoded into a ~43 character secret.
   */
  private readonly APP_PASSWORD_BYTE_LENGTH = 32

  constructor(
    private appPasswordRepository: AppPasswordRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: CreateAppPasswordDTO): Promise<Result<CreateAppPasswordResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create app password: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not create app password: user not found.')
    }

    const label = (dto.label ?? '').trim()
    if (label.length === 0) {
      return Result.fail('Could not create app password: a label is required.')
    }

    // High-entropy, server-generated secret. Stored only as a bcrypt hash; the
    // plaintext is returned to the caller exactly once below.
    const plaintextPassword = crypto.randomBytes(this.APP_PASSWORD_BYTE_LENGTH).toString('base64url')

    const hashedPassword = await bcrypt.hash(plaintextPassword, User.PASSWORD_HASH_COST)

    const createdAt = new Date()

    const appPasswordOrError = AppPassword.create({
      userUuid: userUuid.value,
      label,
      hashedPassword,
      createdAt,
      lastUsedAt: null,
    })
    if (appPasswordOrError.isFailed()) {
      return Result.fail(`Could not create app password: ${appPasswordOrError.getError()}`)
    }
    const appPassword = appPasswordOrError.getValue()

    await this.appPasswordRepository.save(appPassword)

    return Result.ok({
      uuid: appPassword.id.toString(),
      label,
      password: plaintextPassword,
      createdAt,
    })
  }
}
