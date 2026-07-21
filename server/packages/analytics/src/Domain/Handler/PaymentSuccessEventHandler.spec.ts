import 'reflect-metadata'

import { PaymentType, SubscriptionBillingFrequency, SubscriptionName } from '@standardnotes/common'
import { Result } from '@standardnotes/domain-core'
import { PaymentSuccessEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'
import { Logger } from 'winston'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { StatisticsStoreInterface } from '../Statistics/StatisticsStoreInterface'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'

import { PaymentSuccessEventHandler } from './PaymentSuccessEventHandler'

describe('PaymentSuccessEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let logger: Logger
  let mixpanelClient: Mixpanel | null

  const ALL_PERIODS = [Period.Today, Period.ThisWeek, Period.ThisMonth]

  const createHandler = () =>
    new PaymentSuccessEventHandler(getUserAnalyticsId, analyticsStore, statisticsStore, logger, mixpanelClient)

  const createEvent = (payload: Record<string, unknown>) =>
    ({
      type: 'PAYMENT_SUCCESS',
      payload: {
        userEmail: 'test@test.te',
        amount: 12.5,
        subscriptionName: SubscriptionName.PlusPlan,
        paymentType: PaymentType.Initial,
        billingFrequency: SubscriptionBillingFrequency.Monthly,
        ...payload,
      },
    }) as jest.Mocked<PaymentSuccessEvent>

  beforeEach(() => {
    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest
      .fn()
      .mockResolvedValue(Result.ok<GetUserAnalyticsIdResponse>({ analyticsId: 123 } as GetUserAnalyticsIdResponse))

    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.incrementMeasure = jest.fn().mockResolvedValue(undefined)

    logger = { warn: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = {
      track: jest.fn(),
      people: { track_charge: jest.fn(), set: jest.fn() },
    } as unknown as jest.Mocked<Mixpanel>
  })

  it('marks the payment-success activity for today, this week and this month', async () => {
    await createHandler().handle(createEvent({}))

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.PaymentSuccess], 123, ALL_PERIODS)
  })

  it('always increments the general income measure by the paid amount', async () => {
    await createHandler().handle(createEvent({}))

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.Income, 12.5, ALL_PERIODS)
  })

  it.each([
    [
      SubscriptionName.PlusPlan,
      PaymentType.Initial,
      SubscriptionBillingFrequency.Monthly,
      StatisticMeasureName.NAMES.PlusSubscriptionInitialMonthlyPaymentsIncome,
    ],
    [
      SubscriptionName.PlusPlan,
      PaymentType.Initial,
      SubscriptionBillingFrequency.Annual,
      StatisticMeasureName.NAMES.PlusSubscriptionInitialAnnualPaymentsIncome,
    ],
    [
      SubscriptionName.PlusPlan,
      PaymentType.Renewal,
      SubscriptionBillingFrequency.Monthly,
      StatisticMeasureName.NAMES.PlusSubscriptionRenewingMonthlyPaymentsIncome,
    ],
    [
      SubscriptionName.PlusPlan,
      PaymentType.Renewal,
      SubscriptionBillingFrequency.Annual,
      StatisticMeasureName.NAMES.PlusSubscriptionRenewingAnnualPaymentsIncome,
    ],
    [
      SubscriptionName.ProPlan,
      PaymentType.Initial,
      SubscriptionBillingFrequency.Monthly,
      StatisticMeasureName.NAMES.ProSubscriptionInitialMonthlyPaymentsIncome,
    ],
    [
      SubscriptionName.ProPlan,
      PaymentType.Initial,
      SubscriptionBillingFrequency.Annual,
      StatisticMeasureName.NAMES.ProSubscriptionInitialAnnualPaymentsIncome,
    ],
    [
      SubscriptionName.ProPlan,
      PaymentType.Renewal,
      SubscriptionBillingFrequency.Monthly,
      StatisticMeasureName.NAMES.ProSubscriptionRenewingMonthlyPaymentsIncome,
    ],
    [
      SubscriptionName.ProPlan,
      PaymentType.Renewal,
      SubscriptionBillingFrequency.Annual,
      StatisticMeasureName.NAMES.ProSubscriptionRenewingAnnualPaymentsIncome,
    ],
  ])(
    'increments the detailed income measure for %s / %s / frequency %s',
    async (subscriptionName, paymentType, billingFrequency, expectedMeasure) => {
      await createHandler().handle(createEvent({ subscriptionName, paymentType, billingFrequency }))

      expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(expectedMeasure, 12.5, ALL_PERIODS)
      expect(statisticsStore.incrementMeasure).toHaveBeenCalledTimes(2)
      expect(logger.warn).not.toHaveBeenCalled()
    },
  )

  it('warns and increments only the general income measure for an unmapped combination', async () => {
    await createHandler().handle(createEvent({ billingFrequency: SubscriptionBillingFrequency.FiveYear }))

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledTimes(1)
    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.Income, 12.5, ALL_PERIODS)
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not find detailed measure for: subscription - PLUS_PLAN, payment type - initial, billing frequency - 60',
    )
  })

  it('warns for an unknown subscription name', async () => {
    await createHandler().handle(createEvent({ subscriptionName: 'UNKNOWN_PLAN' }))

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns for an unknown payment type', async () => {
    await createHandler().handle(createEvent({ paymentType: 'chargeback' }))

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('reports the charge and the current plan to mixpanel', async () => {
    await createHandler().handle(createEvent({}))

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('PAYMENT_SUCCESS', {
      distinct_id: '123',
      amount: 12.5,
      billing_frequency: SubscriptionBillingFrequency.Monthly,
      payment_type: PaymentType.Initial,
      subscription_name: SubscriptionName.PlusPlan,
    })
    expect((mixpanelClient as Mixpanel).people.track_charge).toHaveBeenCalledWith('123', 12.5)
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith(
      '123',
      'subscription',
      SubscriptionName.PlusPlan,
    )
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(createEvent({}))

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
  })

  it('still increments the measures when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(createEvent({}))

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledTimes(2)
  })
})
