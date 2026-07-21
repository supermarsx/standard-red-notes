import 'reflect-metadata'

import { Result, Username, Uuid } from '@standardnotes/domain-core'
import { SubscriptionExpiredEvent } from '@standardnotes/domain-events'
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

import { SubscriptionExpiredEventHandler } from './SubscriptionExpiredEventHandler'

describe('SubscriptionExpiredEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let saveRevenueModification: SaveRevenueModification
  let logger: Logger
  let mixpanelClient: Mixpanel | null

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()

  const createHandler = () =>
    new SubscriptionExpiredEventHandler(
      getUserAnalyticsId,
      analyticsStore,
      statisticsStore,
      saveRevenueModification,
      logger,
      mixpanelClient,
    )

  const createEvent = (payload: Record<string, unknown> = {}) =>
    ({
      type: 'SUBSCRIPTION_EXPIRED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionId: 7,
        subscriptionName: 'PRO_PLAN',
        billingFrequency: 12,
        payAmount: 119.99,
        userExistingSubscriptionsCount: 1,
        totalActiveSubscriptionsCount: 5000,
        offline: false,
        ...payload,
      },
    }) as jest.Mocked<SubscriptionExpiredEvent>

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

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.setMeasure = jest.fn().mockResolvedValue(undefined)

    saveRevenueModification = {} as jest.Mocked<SaveRevenueModification>
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.ok({} as RevenueModification))

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>
  })

  it('marks an expiry as both a subscription expiry and an existing-customer churn', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith(
      [AnalyticsActivity.SubscriptionExpired, AnalyticsActivity.ExistingCustomersChurn],
      123,
      [Period.Today, Period.ThisWeek, Period.ThisMonth],
    )
  })

  it('sets the total-customers measure from the event, including this year', async () => {
    await createHandler().handle(createEvent())

    expect(statisticsStore.setMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.TotalCustomers, 5000, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
      Period.ThisYear,
    ])
  })

  it('saves a revenue modification for the expired subscription', async () => {
    await createHandler().handle(createEvent())

    const dto = (saveRevenueModification.execute as jest.Mock).mock.calls[0][0]
    expect(dto.eventType.value).toEqual('SUBSCRIPTION_EXPIRED')
    expect(dto.planName.value).toEqual('PRO_PLAN')
    expect(dto.billingFrequency).toEqual(12)
    expect(dto.payedAmount).toEqual(119.99)
    expect(dto.newSubscriber).toEqual(true)
    expect(dto.subscriptionId).toEqual(7)
    expect(dto.userUuid).toEqual(userUuid)
  })

  it('treats a user with more than one subscription as an existing subscriber', async () => {
    await createHandler().handle(createEvent({ userExistingSubscriptionsCount: 3 }))

    expect(saveRevenueModification.execute).toHaveBeenCalledWith(expect.objectContaining({ newSubscriber: false }))
  })

  it('logs the reason when the revenue modification cannot be saved', async () => {
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.fail('database is down'))

    await createHandler().handle(createEvent())

    expect(logger.error).toHaveBeenCalledWith(
      '[SUBSCRIPTION_EXPIRED][7] Could not save revenue modification: database is down',
    )
  })

  it('downgrades the mixpanel profile to the free plan', async () => {
    await createHandler().handle(createEvent())

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_EXPIRED', {
      distinct_id: '123',
      subscription_name: 'PRO_PLAN',
      offline: false,
      user_existing_subscriptions_count: 1,
      billing_frequency: 12,
      pay_amount: 119.99,
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('123', 'subscription', 'free')
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(statisticsStore.setMeasure).not.toHaveBeenCalled()
    expect(saveRevenueModification.execute).not.toHaveBeenCalled()
  })

  it('still saves the revenue modification when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(createEvent())

    expect(saveRevenueModification.execute).toHaveBeenCalled()
  })
})
