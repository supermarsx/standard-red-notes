import {
  NotificationPayload,
  NotificationPayloadIdentifierType,
  NotificationType,
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UseCaseInterface,
  Uuid,
} from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { AddUserToSharedVaultDTO } from './AddUserToSharedVaultDTO'
import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { AddNotificationsForUsers } from '../../Messaging/AddNotificationsForUsers/AddNotificationsForUsers'

/**
 * KNOWN GAP — shared-vault membership is NOT written to the security audit log.
 *
 * Granting someone membership of a shared vault determines who can read another
 * user's notes, which makes it among the most security-relevant events in the
 * product. It is nevertheless absent from the admin "Recent security events"
 * surface, and from the audit log entirely.
 *
 * The reason is structural, not an oversight: the audit log
 * (`AuditLogWriter` / `AuditAction`) lives in the `auth` package, and
 * `syncing-server` has NO audit writer bound at all. Recording these events is
 * therefore a piece of cross-service infrastructure, not a call-site addition —
 * which is why the pass that added credential, sensitive-setting, MFA and RBAC
 * group-attribution events deliberately stopped short of it.
 *
 * When that infrastructure is built, the natural seam is the domain event bus
 * rather than these call sites: this use case and its siblings already publish
 * `UserAddedToSharedVault` / `UserRemovedFromSharedVault` /
 * `UserInvitedToSharedVault`, so an audit consumer can subscribe to those and
 * pick up every membership and permission change without touching the use
 * cases. Record the vault uuid, the affected user, the permission level and the
 * actor — never vault key material or any item content, both of which are
 * end-to-end encrypted and must stay outside the log.
 */
export class AddUserToSharedVault implements UseCaseInterface<SharedVaultUser> {
  constructor(
    private sharedVaultRepository: SharedVaultRepositoryInterface,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
    private timer: TimerInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private addNotificationForUsers: AddNotificationsForUsers,
  ) {}

  async execute(dto: AddUserToSharedVaultDTO): Promise<Result<SharedVaultUser>> {
    const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUuid)
    if (sharedVaultUuidOrError.isFailed()) {
      return Result.fail(sharedVaultUuidOrError.getError())
    }
    const sharedVaultUuid = sharedVaultUuidOrError.getValue()

    if (!dto.skipSharedVaultExistenceCheck) {
      const sharedVault = await this.sharedVaultRepository.findByUuid(sharedVaultUuid)
      if (!sharedVault) {
        return Result.fail('Attempting to add a shared vault user to a non-existent shared vault')
      }
    }

    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const permissionOrError = SharedVaultUserPermission.create(dto.permission)
    if (permissionOrError.isFailed()) {
      return Result.fail(permissionOrError.getError())
    }
    const permission = permissionOrError.getValue()

    const timestamps = Timestamps.create(
      this.timer.getTimestampInMicroseconds(),
      this.timer.getTimestampInMicroseconds(),
    ).getValue()

    const sharedVaultUserOrError = SharedVaultUser.create({
      userUuid,
      sharedVaultUuid,
      permission,
      timestamps,
      isDesignatedSurvivor: false,
    })
    if (sharedVaultUserOrError.isFailed()) {
      return Result.fail(sharedVaultUserOrError.getError())
    }
    const sharedVaultUser = sharedVaultUserOrError.getValue()

    await this.sharedVaultUserRepository.save(sharedVaultUser)

    const notificationPayloadOrError = NotificationPayload.create({
      primaryIdentifier: sharedVaultUuid,
      primaryIndentifierType: NotificationPayloadIdentifierType.create(
        NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
      ).getValue(),
      type: NotificationType.create(NotificationType.TYPES.UserAddedToSharedVault).getValue(),
      version: '1.0',
    })
    if (notificationPayloadOrError.isFailed()) {
      return Result.fail(notificationPayloadOrError.getError())
    }
    const notificationPayload = notificationPayloadOrError.getValue()

    const result = await this.addNotificationForUsers.execute({
      sharedVaultUuid: sharedVaultUuid.value,
      type: NotificationType.TYPES.UserAddedToSharedVault,
      payload: notificationPayload,
      version: '1.0',
    })
    if (result.isFailed()) {
      return Result.fail(result.getError())
    }

    await this.domainEventPublisher.publish(
      this.domainEventFactory.createUserAddedToSharedVaultEvent({
        sharedVaultUuid: sharedVaultUser.props.sharedVaultUuid.value,
        userUuid: sharedVaultUser.props.userUuid.value,
        permission: sharedVaultUser.props.permission.value,
        createdAt: sharedVaultUser.props.timestamps.createdAt,
        updatedAt: sharedVaultUser.props.timestamps.updatedAt,
      }),
    )

    return Result.ok(sharedVaultUser)
  }
}
