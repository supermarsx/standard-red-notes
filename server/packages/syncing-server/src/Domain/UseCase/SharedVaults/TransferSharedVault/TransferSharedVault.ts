import { Result, SharedVaultUserPermission, Timestamps, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'

import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { TransferSharedVaultDTO } from './TransferSharedVaultDTO'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { TransferSharedVaultItems } from '../TransferSharedVaultItems/TransferSharedVaultItems'

export class TransferSharedVault implements UseCaseInterface<void> {
  constructor(
    private sharedVaultRepository: SharedVaultRepositoryInterface,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
    private transferSharedVaultItems: TransferSharedVaultItems,
    private timer: TimerInterface,
    private domainEventPublisher?: DomainEventPublisherInterface,
    private domainEventFactory?: DomainEventFactoryInterface,
  ) {}

  async execute(dto: TransferSharedVaultDTO): Promise<Result<void>> {
    const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUid)
    if (sharedVaultUuidOrError.isFailed()) {
      return Result.fail(sharedVaultUuidOrError.getError())
    }
    const sharedVaultUuid = sharedVaultUuidOrError.getValue()

    const fromUserUuidOrError = Uuid.create(dto.fromUserUuid)
    if (fromUserUuidOrError.isFailed()) {
      return Result.fail(fromUserUuidOrError.getError())
    }
    const fromUserUuid = fromUserUuidOrError.getValue()

    const toUserUuidOrError = Uuid.create(dto.toUserUuid)
    if (toUserUuidOrError.isFailed()) {
      return Result.fail(toUserUuidOrError.getError())
    }
    const toUserUuid = toUserUuidOrError.getValue()

    const sharedVault = await this.sharedVaultRepository.findByUuid(sharedVaultUuid)
    if (!sharedVault) {
      return Result.fail('Shared vault not found')
    }

    if (!sharedVault.props.userUuid.equals(fromUserUuid)) {
      return Result.fail('Shared vault does not belong to this user')
    }

    const newOwner = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid: toUserUuid,
      sharedVaultUuid: sharedVaultUuid,
    })
    if (!newOwner) {
      return Result.fail('New owner is not a member of this shared vault')
    }

    const transferingItemsResult = await this.transferSharedVaultItems.execute({
      fromUserUuid: fromUserUuid.value,
      toUserUuid: toUserUuid.value,
      sharedVaultUuid: sharedVaultUuid.value,
    })
    if (transferingItemsResult.isFailed()) {
      return Result.fail(`Could not transfer items: ${transferingItemsResult.getError()}`)
    }

    const previousPermission = newOwner.props.permission.value
    newOwner.props.isDesignatedSurvivor = false
    newOwner.props.permission = SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Admin).getValue()
    newOwner.props.timestamps = Timestamps.create(
      newOwner.props.timestamps.createdAt,
      this.timer.getTimestampInMicroseconds(),
    ).getValue()

    await this.sharedVaultUserRepository.save(newOwner)

    sharedVault.props.userUuid = toUserUuid
    sharedVault.props.timestamps = Timestamps.create(
      sharedVault.props.timestamps.createdAt,
      this.timer.getTimestampInMicroseconds(),
    ).getValue()

    await this.sharedVaultRepository.save(sharedVault)

    if (this.domainEventPublisher && this.domainEventFactory) {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createUserPermissionChangedInSharedVaultEvent({
          sharedVaultUuid: sharedVaultUuid.value,
          userUuid: toUserUuid.value,
          permission: newOwner.props.permission.value,
          previousPermission,
          originatorUuid: fromUserUuid.value,
          updatedAt: newOwner.props.timestamps.updatedAt,
        }),
      )
    }
    return Result.ok()
  }
}
