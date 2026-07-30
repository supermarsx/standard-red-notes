import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { RemoveUserFromSharedVault } from '../RemoveUserFromSharedVault/RemoveUserFromSharedVault'
import { Logger } from 'winston'
import { RemoveUserFromSharedVaultsDTO } from './RemoveUserFromSharedVaultsDTO'

export class RemoveUserFromSharedVaults implements UseCaseInterface<void> {
  constructor(
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
    private removeUserFromSharedVault: RemoveUserFromSharedVault,
    private logger: Logger,
  ) {}

  async execute(dto: RemoveUserFromSharedVaultsDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const sharedVaultUsers = await this.sharedVaultUserRepository.findByUserUuid(userUuid)
    let firstFailure: string | undefined
    for (const sharedVaultUser of sharedVaultUsers) {
      try {
        const result = await this.removeUserFromSharedVault.execute({
          sharedVaultUuid: sharedVaultUser.props.sharedVaultUuid.value,
          originatorUuid: userUuid.value,
          userUuid: userUuid.value,
          forceRemoveOwner: true,
        })

        if (result.isFailed()) {
          const error = result.getError()
          this.logger.error(
            `Failed to remove user: ${userUuid.value} from shared vault: ${
              sharedVaultUser.props.sharedVaultUuid.value
            }: ${error}`,
          )
          firstFailure ??= error
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error(
          `Failed to remove user: ${userUuid.value} from shared vault: ${
            sharedVaultUser.props.sharedVaultUuid.value
          }: ${message}`,
        )
        firstFailure ??= message
      }
    }

    if (firstFailure !== undefined) {
      return Result.fail(firstFailure)
    }

    return Result.ok()
  }
}
