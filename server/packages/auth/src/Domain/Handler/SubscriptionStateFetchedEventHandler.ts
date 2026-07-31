import { Username } from '@standardnotes/domain-core'
import { DomainEventHandlerInterface, SubscriptionStateFetchedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { UserSubscriptionRepositoryInterface } from '../Subscription/UserSubscriptionRepositoryInterface'
import { OfflineUserSubscriptionRepositoryInterface } from '../Subscription/OfflineUserSubscriptionRepositoryInterface'

export class SubscriptionStateFetchedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private userRepository: UserRepositoryInterface,
    private userSubscriptionRepository: UserSubscriptionRepositoryInterface,
    private offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface,
    private logger: Logger,
  ) {}

  async handle(event: SubscriptionStateFetchedEvent): Promise<void> {
    const subscriptionId = event.payload.subscriptionId
    if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
      this.logger.error('Subscription ID is missing', {
        codeTag: 'SubscriptionStateFetchedEventHandler.handle',
        subscriptionId,
      })

      return
    }

    this.logger.info('Subscription state update fetched', {
      subscriptionId,
    })

    if (event.payload.offline) {
      this.logger.info('Updating offline subscription', {
        subscriptionId,
      })

      const subscription = await this.offlineUserSubscriptionRepository.findOneByEmailAndSubscriptionId(
        event.payload.userEmail,
        subscriptionId,
      )
      if (!subscription) {
        this.logger.error('Offline subscription not found', {
          subscriptionId,
        })

        return
      }

      subscription.planName = event.payload.subscriptionName
      subscription.email = event.payload.userEmail
      subscription.endsAt = event.payload.subscriptionExpiresAt
      subscription.cancelled = event.payload.canceled
      if (subscription.subscriptionId !== subscriptionId) {
        this.logger.warn('Subscription IDs do not match', {
          previousSubscriptionId: subscription.subscriptionId,
          subscriptionId,
        })
      }
      subscription.subscriptionId = subscriptionId

      await this.offlineUserSubscriptionRepository.save(subscription)

      this.logger.info('Offline subscription updated', {
        subscriptionId,
      })

      return
    }

    const usernameOrError = Username.create(event.payload.userEmail)
    if (usernameOrError.isFailed()) {
      this.logger.warn('Could not update a subscription because the user identifier was invalid.', {
        subscriptionId,
      })

      return
    }
    const username = usernameOrError.getValue()

    const user = await this.userRepository.findOneByUsernameOrEmail(username)

    if (user === null) {
      this.logger.warn(`Could not find user with email: ${username.value}`, {
        subscriptionId,
      })

      return
    }

    this.logger.info('Updating subscription', {
      userId: user.uuid,
      subscriptionId,
    })

    const subscription = await this.userSubscriptionRepository.findOneByUserUuidAndSubscriptionId(
      user.uuid,
      subscriptionId,
    )
    if (!subscription) {
      this.logger.error('Subscription not found', {
        userId: user.uuid,
        subscriptionId,
      })

      return
    }

    subscription.planName = event.payload.subscriptionName
    subscription.endsAt = event.payload.subscriptionExpiresAt
    subscription.cancelled = event.payload.canceled
    if (subscription.subscriptionId !== subscriptionId) {
      this.logger.warn('Subscription IDs do not match', {
        previousSubscriptionId: subscription.subscriptionId,
        subscriptionId,
      })
    }
    subscription.subscriptionId = subscriptionId

    await this.userSubscriptionRepository.save(subscription)

    this.logger.info('Subscription updated to current state', {
      userId: user.uuid,
      subscriptionId,
    })
  }
}
