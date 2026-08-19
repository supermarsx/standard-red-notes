import { Email, Username } from '@standardnotes/domain-core'

import { UserRepositoryInterface } from '../User/UserRepositoryInterface'

export class AuthInviteAffectedUserResolver {
  constructor(private readonly userRepository: UserRepositoryInterface) {}

  async resolve(knownUserUuids: readonly string[], identifiers: readonly string[]): Promise<string[]> {
    const resolved = new Set(knownUserUuids)
    for (const identifier of identifiers) {
      const email = Email.create(identifier)
      const username = email.isFailed() ? Username.create(identifier) : undefined
      const value = email.isFailed() ? username : email
      if (!value || value.isFailed()) {
        continue
      }
      const users = await this.userRepository.findAllByUsernameOrEmail(value.getValue())
      for (const user of users) {
        resolved.add(user.uuid)
      }
    }
    return [...resolved]
  }
}
