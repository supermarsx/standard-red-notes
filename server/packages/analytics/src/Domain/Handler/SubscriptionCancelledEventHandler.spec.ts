import 'reflect-metadata'

import { Result, Username, Uuid } from '@standardnotes/domain-core'
import { SubscriptionCancelledEvent } from '@standardnotes/domain-events'
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

import { SubscriptionCancelledEventHandler } from './SubscriptionCancelledEventHandler'

describe('SubscriptionCancelledEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let saveRevenueModification: SaveRevenueModification
  let logger: Logger
  let mixpanelClient: Mixpanel | null
  let timer: TimerInterface

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()
  const ALL_PERIODS = [Period.Today, Period.ThisWeek, Period.ThisMonth]
  const ONE_YEAR_IN_MICROSECONDS = 31_557_600_000_000

  const createHandler = () =>
    new SubscriptionCancelledEventHandler(
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
      type: 'SUBSCRIPTION_CANCELLED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionId: 1,
        subscriptionName: 'PLUS_PLAN',
        billingFrequency: 1,
        payAmount: 12.99,
        userExistingSubscriptionsCount: 1,
        offline: false,
        replaced: false,
        timestamp: 5 * ONE_YEAR_IN_MICROSECONDS,
        subscriptionCreatedAt: 4 * ONE_YEAR_IN_MICROSECONDS,
        subscriptionUpdatedAt: 5 * ONE_YEAR_IN_MICROSECONDS,
        lastPayedAt: 4 * ONE_YEAR_IN_MICROSECONDS,
        subscriptionEndsAt: 6 * ONE_YEAR_IN_MICROSECONDS,
        ...payload,
      },
    }) as jest.Mocked<SubscriptionCancelledEvent>

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
    statisticsStore.incrementMeasure = jest.fn().mockResolvedValue(undefined)

    saveRevenueModification = {} as jest.Mocked<SaveRevenueModification>
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.ok({} as RevenueModification))

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn() } as unknown as jest.Mocked<Mixpanel>

    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToDate = jest.fn().mockImplementation((microseconds: number) => new Date(microseconds))
  })

  it('marks the subscription-cancelled activity for today, this week and this month', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.SubscriptionCancelled], 123, ALL_PERIODS)
  })

  it('records the subscription length as the time between creation and cancellation', async () => {
    await createHandler().handle(createEvent())

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.SubscriptionLength,
      ONE_YEAR_IN_MICROSECONDS,
      ALL_PERIODS,
    )
  })

  it('records the unused share of the paid-for period as a floored percentage', async () => {
    await createHandler().handle(createEvent())

    // 1 remaining year out of the 2 paid-for years
    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage,
      50,
      ALL_PERIODS,
    )
  })

  it('floors a fractional remaining-time percentage instead of rounding it', async () => {
    await createHandler().handle(
      createEvent({
        lastPayedAt: 4 * ONE_YEAR_IN_MICROSECONDS,
        timestamp: 4 * ONE_YEAR_IN_MICROSECONDS + 999,
        subscriptionEndsAt: 4 * ONE_YEAR_IN_MICROSECONDS + 3000,
      }),
    )

    // 2001 / 3000 == 66.7%
    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage,
      66,
      ALL_PERIODS,
    )
  })

  it('skips subscription statistics entirely for a legacy five-year plan', async () => {
    await createHandler().handle(
      createEvent({
        subscriptionCreatedAt: 0,
        subscriptionEndsAt: 5 * ONE_YEAR_IN_MICROSECONDS,
      }),
    )

    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
    // the rest of the handler still runs
    expect(saveRevenueModification.execute).toHaveBeenCalled()
  })

  it('records statistics for a subscription just under the four-year legacy cut-off', async () => {
    await createHandler().handle(
      createEvent({
        subscriptionCreatedAt: 0,
        subscriptionEndsAt: 126_230_400_000_000,
      }),
    )

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.SubscriptionLength,
      5 * ONE_YEAR_IN_MICROSECONDS,
      ALL_PERIODS,
    )
  })

  it('saves a revenue modification for the cancelled subscription', async () => {
    await createHandler().handle(createEvent())

    expect(saveRevenueModification.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        billingFrequency: 1,
        newSubscriber: true,
        payedAmount: 12.99,
        subscriptionId: 1,
        userUuid,
      }),
    )
    const dto = (saveRevenueModification.execute as jest.Mock).mock.calls[0][0]
    expect(dto.eventType.value).toEqual('SUBSCRIPTION_CANCELLED')
    expect(dto.planName.value).toEqual('PLUS_PLAN')
    expect(dto.username.value).toEqual('test@test.te')
  })

  it('treats a user with more than one subscription as an existing subscriber', async () => {
    await createHandler().handle(createEvent({ userExistingSubscriptionsCount: 2 }))

    expect(saveRevenueModification.execute).toHaveBeenCalledWith(expect.objectContaining({ newSubscriber: false }))
  })

  it('logs the reason when the revenue modification cannot be saved', async () => {
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.fail('database is down'))

    await createHandler().handle(createEvent())

    expect(logger.error).toHaveBeenCalledWith(
      '[SUBSCRIPTION_CANCELLED][1] Could not save revenue modification: database is down',
    )
  })

  it('does not log an error when the revenue modification is saved', async () => {
    await createHandler().handle(createEvent())

    expect(logger.error).not.toHaveBeenCalled()
  })

  it('tracks the cancellation in mixpanel with the timestamps converted to dates', async () => {
    await createHandler().handle(createEvent())

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_CANCELLED', {
      distinct_id: '123',
      subscription_name: 'PLUS_PLAN',
      subscription_created_at: new Date(4 * ONE_YEAR_IN_MICROSECONDS),
      subscription_updated_at: new Date(5 * ONE_YEAR_IN_MICROSECONDS),
      last_payed_at: new Date(4 * ONE_YEAR_IN_MICROSECONDS),
      subscription_ends_at: new Date(6 * ONE_YEAR_IN_MICROSECONDS),
      offline: false,
      replaced: false,
      user_existing_subscriptions_count: 1,
      billing_frequency: 1,
      pay_amount: 12.99,
    })
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
    expect(saveRevenueModification.execute).not.toHaveBeenCalled()
  })

  it('still saves the revenue modification when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(createEvent())

    expect(saveRevenueModification.execute).toHaveBeenCalled()
  })
})
