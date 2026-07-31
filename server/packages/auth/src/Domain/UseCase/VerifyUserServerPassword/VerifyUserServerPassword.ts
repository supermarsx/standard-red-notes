import * as bcrypt from 'bcryptjs'
import { Uuid, Result, UseCaseInterface } from '@standardnotes/domain-core'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { VerifyUserServerPasswordDTO } from './VerifyUserServerPasswordDTO'
import { User } from '../../User/User'
import { SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE, supportsPasswordStepUp } from '../../Auth/SecurityStepUp'

export class VerifyUserServerPassword implements UseCaseInterface<void> {
  constructor(private userRepository: UserRepositoryInterface) {}
  async execute(dto: VerifyUserServerPasswordDTO): Promise<Result<void>> {
    if (!supportsPasswordStepUp(dto.authTokenVersion)) {
      return Result.fail(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)
    }

    if (!dto.serverPassword) {
      return Result.fail(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)
    }

    let user: User | undefined | null = dto.user

    if (!user) {
      const userUuidOrError = Uuid.create(dto.userUuid as string)
      if (userUuidOrError.isFailed()) {
        return Result.fail(userUuidOrError.getError())
      }
      const userUuid = userUuidOrError.getValue()
      user = await this.userRepository.findOneByUuid(userUuid)

      if (!user) {
        return Result.fail('User not found.')
      }
    }

    const passwordMatch = await bcrypt.compare(dto.serverPassword, user.encryptedPassword)

    if (!passwordMatch) {
      return Result.fail('The password you entered is incorrect. Please try again.')
    }

    return Result.ok()
  }
}
