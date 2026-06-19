import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { DeleteAppPasswordDTO } from './DeleteAppPasswordDTO'

export class DeleteAppPassword implements UseCaseInterface<string> {
  constructor(private appPasswordRepository: AppPasswordRepositoryInterface) {}

  async execute(dto: DeleteAppPasswordDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete app password: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const appPassword = await this.appPasswordRepository.findById(new UniqueEntityId(dto.appPasswordId))
    // Ownership check: never allow deleting another user's app password.
    if (!appPassword || appPassword.props.userUuid !== userUuid.value) {
      return Result.fail('App password not found')
    }

    await this.appPasswordRepository.remove(appPassword)

    return Result.ok('App password deleted')
  }
}
