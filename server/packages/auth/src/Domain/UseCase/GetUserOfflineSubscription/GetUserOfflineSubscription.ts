import { UseCaseInterface } from '../UseCaseInterface'
import { inject, injectable } from 'inversify'
import TYPES from '../../../Bootstrap/Types'
import { GetUserOfflineSubscriptionDto } from './GetUserOfflineSubscriptionDto'
import { GetUserOfflineSubscriptionResponse } from './GetUserOfflineSubscriptionResponse'
import { OfflineUserSubscriptionRepositoryInterface } from '../../Subscription/OfflineUserSubscriptionRepositoryInterface'
import { SubscriptionName } from '@standardnotes/common'
import { TimerInterface } from '@standardnotes/time'
import { OfflineUserSubscription } from '../../Subscription/OfflineUserSubscription'

@injectable()
export class GetUserOfflineSubscription implements UseCaseInterface {
  constructor(
    @inject(TYPES.Auth_OfflineUserSubscriptionRepository)
    private offlineUserSubscriptionRepository: OfflineUserSubscriptionRepositoryInterface,
    private standardRedFeaturesMode = 'legacy',
    private timer?: TimerInterface,
    private standardRedFullFeatureDurationDays = 36500,
  ) {}

  async execute(dto: GetUserOfflineSubscriptionDto): Promise<GetUserOfflineSubscriptionResponse> {
    const userSubscription = this.shouldReturnIncludedSubscription()
      ? this.createIncludedSubscription(dto.userEmail)
      : await this.offlineUserSubscriptionRepository.findOneByEmail(dto.userEmail)

    return {
      success: true,
      subscription: userSubscription,
    }
  }

  private shouldReturnIncludedSubscription(): boolean {
    return ['included', 'full'].includes(this.standardRedFeaturesMode)
  }

  private createIncludedSubscription(email: string): OfflineUserSubscription {
    const now = this.timer?.getTimestampInMicroseconds() ?? Date.now() * 1_000
    const endsAt =
      this.timer !== undefined
        ? this.timer.convertDateToMicroseconds(this.timer.getUTCDateNDaysAhead(this.standardRedFullFeatureDurationDays))
        : now + this.standardRedFullFeatureDurationDays * 24 * 60 * 60 * 1_000 * 1_000

    return {
      uuid: '00000000-0000-0000-0000-000000000000',
      email,
      planName: SubscriptionName.ProPlan,
      endsAt,
      createdAt: now,
      updatedAt: now,
      cancelled: false,
      subscriptionId: this.standardRedSubscriptionIdForUser(email),
      roles: Promise.resolve([]),
    }
  }

  private standardRedSubscriptionIdForUser(identifier: string): number {
    let hash = 0
    for (const character of identifier) {
      hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000_000
    }

    return 1_000_000_000 + hash
  }
}
