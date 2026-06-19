import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { ListAppPasswordsDTO } from './ListAppPasswordsDTO'

export class ListAppPasswords implements UseCaseInterface<AppPassword[]> {
  constructor(private appPasswordRepository: AppPasswordRepositoryInterface) {}

  async execute(dto: ListAppPasswordsDTO): Promise<Result<AppPassword[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list app passwords: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const appPasswords = await this.appPasswordRepository.findByUserUuid(userUuid)

    return Result.ok(appPasswords)
  }
}
