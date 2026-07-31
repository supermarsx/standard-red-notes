import { Result, UseCaseInterface, Username, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { RenewSharedSubscriptionsDTO } from './RenewSharedSubscriptionsDTO'
import { ListSharedSubscriptionInvitations } from '../ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'
import { InvitationStatus } from '../../SharedSubscription/InvitationStatus'
import { SharedSubscriptionInvitationRepositoryInterface } from '../../SharedSubscription/SharedSubscriptionInvitationRepositoryInterface'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { UserSubscriptionType } from '../../Subscription/UserSubscriptionType'
import { UserSubscriptionRepositoryInterface } from '../../Subscription/UserSubscriptionRepositoryInterface'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { InviteeIdentifierType } from '../../SharedSubscription/InviteeIdentifierType'
import { RoleServiceInterface } from '../../Role/RoleServiceInterface'
import { User } from '../../User/User'

export class RenewSharedSubscriptions implements UseCaseInterface<void> {
  constructor(
    private listSharedSubscriptionInvitations: ListSharedSubscriptionInvitations,
    private sharedSubscriptionInvitationRepository: SharedSubscriptionInvitationRepositoryInterface,
    private userSubscriptionRepository: UserSubscriptionRepositoryInterface,
    private userRepository: UserRepositoryInterface,
    private roleService: RoleServiceInterface,
    private logger: Logger,
  ) {}

  async execute(dto: RenewSharedSubscriptionsDTO): Promise<Result<void>> {
    const result = await this.listSharedSubscriptionInvitations.execute({
      inviterEmail: dto.inviterEmail,
    })

    const acceptedInvitations = result.invitations.filter(
      (invitation) => invitation.status === InvitationStatus.Accepted,
    )

    for (const invitation of acceptedInvitations) {
      try {
        const user = await this.getInviteeUserUuid(invitation.inviteeIdentifier, invitation.inviteeIdentifierType)
        if (user === null) {
          this.logger.error('Could not renew a shared subscription because the invitee was not found.', {
            subscriptionId: dto.newSubscriptionId,
            invitationId: invitation.uuid,
          })
          continue
        }

        await this.createSharedSubscription({
          subscriptionId: dto.newSubscriptionId,
          subscriptionName: dto.newSubscriptionName,
          userUuid: user.uuid,
          timestamp: dto.timestamp,
          subscriptionExpiresAt: dto.newSubscriptionExpiresAt,
        })

        await this.roleService.addUserRoleBasedOnSubscription(user, dto.newSubscriptionName)

        invitation.subscriptionId = dto.newSubscriptionId
        invitation.updatedAt = dto.timestamp

        await this.sharedSubscriptionInvitationRepository.save(invitation)
      } catch (error) {
        this.logger.error('Could not renew a shared subscription invitation.', {
          subscriptionId: dto.newSubscriptionId,
          invitationId: invitation.uuid,
          ...safeErrorLogMetadata(error),
        })
      }
    }

    return Result.ok()
  }

  private async createSharedSubscription(dto: {
    subscriptionId: number
    subscriptionName: string
    userUuid: string
    subscriptionExpiresAt: number
    timestamp: number
  }): Promise<UserSubscription> {
    const subscription = new UserSubscription()
    subscription.planName = dto.subscriptionName
    subscription.userUuid = dto.userUuid
    subscription.createdAt = dto.timestamp
    subscription.updatedAt = dto.timestamp
    subscription.endsAt = dto.subscriptionExpiresAt
    subscription.cancelled = false
    subscription.subscriptionId = dto.subscriptionId
    subscription.subscriptionType = UserSubscriptionType.Shared

    return this.userSubscriptionRepository.save(subscription)
  }

  private async getInviteeUserUuid(inviteeIdentifier: string, inviteeIdentifierType: string): Promise<User | null> {
    if (inviteeIdentifierType === InviteeIdentifierType.Email) {
      const usernameOrError = Username.create(inviteeIdentifier)
      if (usernameOrError.isFailed()) {
        return null
      }
      const username = usernameOrError.getValue()

      return this.userRepository.findOneByUsernameOrEmail(username)
    } else if (inviteeIdentifierType === InviteeIdentifierType.Uuid) {
      const uuidOrError = Uuid.create(inviteeIdentifier)
      if (uuidOrError.isFailed()) {
        return null
      }
      const uuid = uuidOrError.getValue()
      return this.userRepository.findOneByUuid(uuid)
    }

    return null
  }
}
