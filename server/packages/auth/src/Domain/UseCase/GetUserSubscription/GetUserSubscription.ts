import { UseCaseInterface } from '../UseCaseInterface'
import { inject, injectable } from 'inversify'
import TYPES from '../../../Bootstrap/Types'
import { GetUserSubscriptionDto } from './GetUserSubscriptionDto'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetUserSubscriptionResponse } from './GetUserSubscriptionResponse'
import { UserSubscriptionRepositoryInterface } from '../../Subscription/UserSubscriptionRepositoryInterface'
import { Uuid } from '@standardnotes/domain-core'
import { SubscriptionName } from '@standardnotes/common'
import { TimerInterface } from '@standardnotes/time'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { UserSubscriptionType } from '../../Subscription/UserSubscriptionType'

@injectable()
export class GetUserSubscription implements UseCaseInterface {
  constructor(
    @inject(TYPES.Auth_UserRepository) private userRepository: UserRepositoryInterface,
    @inject(TYPES.Auth_UserSubscriptionRepository)
    private userSubscriptionRepository: UserSubscriptionRepositoryInterface,
    private standardRedFeaturesMode = 'legacy',
    private timer?: TimerInterface,
    private standardRedFullFeatureDurationDays = 36500,
  ) {}

  async execute(dto: GetUserSubscriptionDto): Promise<GetUserSubscriptionResponse> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return {
        success: false,
        error: {
          message: userUuidOrError.getError(),
        },
      }
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)

    if (user === null) {
      return {
        success: false,
        error: {
          message: `User ${userUuid.value} not found.`,
        },
      }
    }

    const userSubscription = this.shouldReturnIncludedSubscription()
      ? this.createIncludedSubscription(user.uuid)
      : await this.userSubscriptionRepository.findOneByUserUuid(userUuid.value)

    return {
      success: true,
      user: { uuid: user.uuid, email: user.email },
      subscription: userSubscription,
    }
  }

  private shouldReturnIncludedSubscription(): boolean {
    return ['included', 'full'].includes(this.standardRedFeaturesMode)
  }

  private createIncludedSubscription(userUuid: string): UserSubscription {
    const now = this.timer?.getTimestampInMicroseconds() ?? Date.now() * 1_000
    const endsAt =
      this.timer !== undefined
        ? this.timer.convertDateToMicroseconds(this.timer.getUTCDateNDaysAhead(this.standardRedFullFeatureDurationDays))
        : now + this.standardRedFullFeatureDurationDays * 24 * 60 * 60 * 1_000 * 1_000

    return {
      uuid: userUuid,
      planName: SubscriptionName.ProPlan,
      endsAt,
      createdAt: now,
      updatedAt: now,
      renewedAt: now,
      cancelled: false,
      subscriptionId: this.standardRedSubscriptionIdForUser(userUuid),
      subscriptionType: UserSubscriptionType.Regular,
      userUuid,
    }
  }

  private standardRedSubscriptionIdForUser(userUuid: string): number {
    let hash = 0
    for (const character of userUuid) {
      hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000_000
    }

    return 1_000_000_000 + hash
  }
}
