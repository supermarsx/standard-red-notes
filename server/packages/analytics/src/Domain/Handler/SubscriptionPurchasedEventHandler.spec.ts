import 'reflect-metadata'

import { Result, Username, Uuid } from '@standardnotes/domain-core'
import { SubscriptionPurchasedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
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

import { SubscriptionPurchasedEventHandler } from './SubscriptionPurchasedEventHandler'

describe('SubscriptionPurchasedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let saveRevenueModification: SaveRevenueModification
  let logger: Logger
  let mixpanelClient: Mixpanel | null
  let timer: TimerInterface

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()
  const ALL_PERIODS = [Period.Today, Period.ThisWeek, Period.ThisMonth]

  const createHandler = () =>
    new SubscriptionPurchasedEventHandler(
      getUserAnalyticsId,
      analyticsStore,
      statisticsStore,
      saveRevenueModification,
      logger,
      mixpanelClient,
      timer,
    )

  const createEvent = (payload: Record<string, unknown> = {}) =>
    ({
      type: 'SUBSCRIPTION_PURCHASED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionId: 3,
        subscriptionName: 'PLUS_PLAN',
        billingFrequency: 1,
        payAmount: 12.99,
        newSubscriber: true,
        limitedDiscountPurchased: false,
        totalActiveSubscriptionsCount: 5000,
        offline: false,
        discountCode: null,
        timestamp: 3000,
        userRegisteredAt: 1000,
        subscriptionExpiresAt: 9000,
        ...payload,
      },
    }) as jest.Mocked<SubscriptionPurchasedEvent>

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
    analyticsStore.unmarkActivity = jest.fn().mockResolvedValue(undefined)

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.incrementMeasure = jest.fn().mockResolvedValue(undefined)
    statisticsStore.setMeasure = jest.fn().mockResolvedValue(undefined)

    saveRevenueModification = {} as jest.Mocked<SaveRevenueModification>
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.ok({} as RevenueModification))

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>

    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToDate = jest.fn().mockImplementation((microseconds: number) => new Date(microseconds))
  })

  it('marks the subscription-purchased activity', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith(
      [AnalyticsActivity.SubscriptionPurchased],
      123,
      ALL_PERIODS,
    )
  })

  it('clears any churn marks the user picked up earlier', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.unmarkActivity).toHaveBeenCalledWith(
      [AnalyticsActivity.ExistingCustomersChurn, AnalyticsActivity.NewCustomersChurn],
      123,
      ALL_PERIODS,
    )
  })

  it('marks the limited-discount activity for today only when the offer was purchased', async () => {
    await createHandler().handle(createEvent({ limitedDiscountPurchased: true }))

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.LimitedDiscountOfferPurchased], 123, [
      Period.Today,
    ])
  })

  it('does not mark the limited-discount activity when the offer was not purchased', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledTimes(1)
  })

  it('records registration-to-subscription time and customer counts for a new subscriber', async () => {
    await createHandler().handle(createEvent())

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.RegistrationToSubscriptionTime,
      2000,
      ALL_PERIODS,
    )
    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.NewCustomers, 1, [
      ...ALL_PERIODS,
      Period.ThisYear,
    ])
    expect(statisticsStore.setMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.TotalCustomers, 5000, [
      ...ALL_PERIODS,
      Period.ThisYear,
    ])
  })

  it('records no customer statistics for a returning subscriber', async () => {
    await createHandler().handle(createEvent({ newSubscriber: false }))

    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
    expect(statisticsStore.setMeasure).not.toHaveBeenCalled()
  })

  it('saves a revenue modification carrying the new-subscriber flag from the event', async () => {
    await createHandler().handle(createEvent({ newSubscriber: false }))

    const dto = (saveRevenueModification.execute as jest.Mock).mock.calls[0][0]
    expect(dto.eventType.value).toEqual('SUBSCRIPTION_PURCHASED')
    expect(dto.planName.value).toEqual('PLUS_PLAN')
    expect(dto.newSubscriber).toEqual(false)
    expect(dto.subscriptionId).toEqual(3)
    expect(dto.payedAmount).toEqual(12.99)
  })

  it('logs a safe classification when the revenue modification cannot be saved', async () => {
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.fail('database is down'))

    await createHandler().handle(createEvent())

    expect(logger.error).toHaveBeenCalledWith(
      '[SUBSCRIPTION_PURCHASED][3] Could not save revenue modification.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('database is down')
  })

  it('tracks the purchase and sets the mixpanel profile plan', async () => {
    await createHandler().handle(createEvent())

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_PURCHASED', {
      distinct_id: '123',
      subscription_name: 'PLUS_PLAN',
      subscription_expires_at: new Date(9000),
      offline: false,
      discount_code: null,
      limited_discount_purchased: false,
      new_subscriber: true,
      user_registered_at: new Date(1000),
      billing_frequency: 1,
      pay_amount: 12.99,
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('123', 'subscription', 'PLUS_PLAN')
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(saveRevenueModification.execute).not.toHaveBeenCalled()
  })

  it('still saves the revenue modification when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(createEvent())

    expect(saveRevenueModification.execute).toHaveBeenCalled()
  })
})
