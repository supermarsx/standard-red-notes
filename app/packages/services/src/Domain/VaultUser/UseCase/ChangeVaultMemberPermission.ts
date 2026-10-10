import { getErrorFromErrorResponse, isErrorResponse } from '@standardnotes/responses'
import { SharedVaultUsersServerInterface, SharedVaultUserPermissionValue } from '@standardnotes/api'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'

/**
 * Changes an existing member's permission in place. The alternative this replaces was
 * remove + re-invite + wait for them to accept, which evicted the person from the vault
 * and rotated its key for what the server stores as one column.
 *
 * The error is surfaced rather than swallowed: every refusal the server can give here is
 * something the actor needs to read ("Only the owner can grant admin permission in a
 * shared vault", "Cannot change your own permission in a shared vault"), and a failed
 * `Result` with the server's message is how the modal shows it.
 */
export class ChangeVaultMemberPermission implements UseCaseInterface<void> {
  constructor(private vaultUserServer: SharedVaultUsersServerInterface) {}

  async execute(params: {
    sharedVaultUuid: string
    userUuid: string
    permission: SharedVaultUserPermissionValue
  }): Promise<Result<void>> {
    const response = await this.vaultUserServer.updateSharedVaultUserPermission({
      sharedVaultUuid: params.sharedVaultUuid,
      userUuid: params.userUuid,
      permission: params.permission,
    })

    if (isErrorResponse(response)) {
      return Result.fail(getErrorFromErrorResponse(response).message)
    }

    return Result.ok()
  }
}
