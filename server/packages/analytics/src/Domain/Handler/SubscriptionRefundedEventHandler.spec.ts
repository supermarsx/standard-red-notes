import 'reflect-metadata'

import { Result, Username, Uuid } from '@standardnotes/domain-core'
import { SubscriptionRefundedEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'
import { Logger } from 'winston'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { RevenueModification } from '../Revenue/RevenueModification'
import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { StatisticsStoreInterface } from '../Statistics/StatisticsStoreInterface'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'
import { SaveRevenueModification } from '../UseCase/SaveRevenueModification/SaveRevenueModification'

import { SubscriptionRefundedEventHandler } from './SubscriptionRefundedEventHandler'

describe('SubscriptionRefundedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let saveRevenueModification: SaveRevenueModification
  let logger: Logger
  let mixpanelClient: Mixpanel | null

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()

  const createHandler = () =>
    new SubscriptionRefundedEventHandler(
      getUserAnalyticsId,
      analyticsStore,
      statisticsStore,
      saveRevenueModification,
      logger,
      mixpanelClient,
    )

  const createEvent = (payload: Record<string, unknown> = {}) =>
    ({
      type: 'SUBSCRIPTION_REFUNDED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionId: 11,
        subscriptionName: 'PLUS_PLAN',
        billingFrequency: 1,
        payAmount: 12.99,
        userExistingSubscriptionsCount: 1,
        totalActiveSubscriptionsCount: 4999,
        offline: false,
        ...payload,
      },
    }) as jest.Mocked<SubscriptionRefundedEvent>

  beforeEach(() => {
    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(
      Result.ok<GetUserAnalyticsIdResponse>({
        analyticsId: 123,
        userUuid,
        username: Username.create('test@test.te').getValue(),
      }),
    )

    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)
    analyticsStore.wasActivityDone = jest.fn().mockResolvedValue(true)

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.setMeasure = jest.fn().mockResolvedValue(undefined)

    saveRevenueModification = {} as jest.Mocked<SaveRevenueModification>
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.ok({} as RevenueModification))

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>
  })

  it('marks the subscription-refunded activity for today, this week and this month', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.SubscriptionRefunded], 123, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('checks each period separately for an earlier purchase', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.wasActivityDone).toHaveBeenCalledTimes(3)
    for (const period of [Period.ThisMonth, Period.ThisWeek, Period.Today]) {
      expect(analyticsStore.wasActivityDone).toHaveBeenCalledWith(AnalyticsActivity.SubscriptionPurchased, 123, period)
    }
  })

  it('marks a new-customer churn for a user on their first subscription', async () => {
    await createHandler().handle(createEvent({ userExistingSubscriptionsCount: 1 }))

    for (const period of [Period.ThisMonth, Period.ThisWeek, Period.Today]) {
      expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.NewCustomersChurn], 123, [period])
    }
  })

  it('marks an existing-customer churn for a user with more than one subscription', async () => {
    await createHandler().handle(createEvent({ userExistingSubscriptionsCount: 2 }))

    for (const period of [Period.ThisMonth, Period.ThisWeek, Period.Today]) {
      expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.ExistingCustomersChurn], 123, [
        period,
      ])
    }
  })

  it('marks churn only in the periods where the user had actually purchased', async () => {
    analyticsStore.wasActivityDone = jest
      .fn()
      .mockImplementation(async (_activity, _id, period) => period === Period.Today)

    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.NewCustomersChurn], 123, [Period.Today])
    expect(analyticsStore.markActivity).not.toHaveBeenCalledWith([AnalyticsActivity.NewCustomersChurn], 123, [
      Period.ThisWeek,
    ])
    expect(analyticsStore.markActivity).not.toHaveBeenCalledWith([AnalyticsActivity.NewCustomersChurn], 123, [
      Period.ThisMonth,
    ])
  })

  it('marks no churn at all when the user never purchased in any tracked period', async () => {
    analyticsStore.wasActivityDone = jest.fn().mockResolvedValue(false)

    await createHandler().handle(createEvent())

    // only the subscription-refunded mark remains
    expect(analyticsStore.markActivity).toHaveBeenCalledTimes(1)
  })

  it('sets the total-customers measure even when no churn was marked', async () => {
    analyticsStore.wasActivityDone = jest.fn().mockResolvedValue(false)

    await createHandler().handle(createEvent())

    expect(statisticsStore.setMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.TotalCustomers, 4999, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
      Period.ThisYear,
    ])
  })

  it('saves a revenue modification for the refunded subscription', async () => {
    await createHandler().handle(createEvent())

    const dto = (saveRevenueModification.execute as jest.Mock).mock.calls[0][0]
    expect(dto.eventType.value).toEqual('SUBSCRIPTION_REFUNDED')
    expect(dto.planName.value).toEqual('PLUS_PLAN')
    expect(dto.subscriptionId).toEqual(11)
    expect(dto.newSubscriber).toEqual(true)
  })

  it('logs the reason when the revenue modification cannot be saved', async () => {
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.fail('database is down'))

    await createHandler().handle(createEvent())

    expect(logger.error).toHaveBeenCalledWith(
      '[SUBSCRIPTION_REFUNDED][11] Could not save revenue modification: database is down',
    )
  })

  it('downgrades the mixpanel profile to the free plan', async () => {
    await createHandler().handle(createEvent())

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_REFUNDED', {
      distinct_id: '123',
      subscription_name: 'PLUS_PLAN',
      user_existing_subscriptions_count: 1,
      offline: false,
      billing_frequency: 1,
      pay_amount: 12.99,
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('123', 'subscription', 'free')
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(analyticsStore.wasActivityDone).not.toHaveBeenCalled()
    expect(saveRevenueModification.execute).not.toHaveBeenCalled()
  })

  it('still saves the revenue modification when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(createEvent())

    expect(saveRevenueModification.execute).toHaveBeenCalled()
  })
})
