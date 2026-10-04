import { GetVaultUsers } from './GetVaultUsers'
import { TrustedContactInterface } from '@standardnotes/models'
import { isNotUndefined } from '@standardnotes/utils'
import { FindContact } from '../../Contacts/UseCase/FindContact'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'

export class GetVaultContacts implements UseCaseInterface<TrustedContactInterface[]> {
  constructor(
    private _findContact: FindContact,
    private _getVaultUsers: GetVaultUsers,
  ) {}

  async execute(dto: { sharedVaultUuid: string; readFromCache: boolean }): Promise<Result<TrustedContactInterface[]>> {
    const users = await this._getVaultUsers.execute({
      sharedVaultUuid: dto.sharedVaultUuid,
      readFromCache: dto.readFromCache,
    })
    if (users.isFailed()) {
      // GetVaultUsers already carries the server's own reason for the refusal. Flattening it into a
      // fixed 'Failed to get vault users' threw that away, and the string then travelled verbatim
      // into the invite alert as a fourth message the user could not act on or tell apart.
      return Result.fail(users.getError())
    }

    const contacts = users
      .getValue()
      .map((user) => this._findContact.execute({ userUuid: user.user_uuid }))
      .map((result) => (result.isFailed() ? undefined : result.getValue()))
      .filter(isNotUndefined)

    return Result.ok(contacts)
  }
}
