import 'reflect-metadata'

import { Result, Username, Uuid } from '@standardnotes/domain-core'
import { SubscriptionRenewedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Mixpanel } from 'mixpanel'
import { Logger } from 'winston'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { RevenueModification } from '../Revenue/RevenueModification'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'
import { SaveRevenueModification } from '../UseCase/SaveRevenueModification/SaveRevenueModification'

import { SubscriptionRenewedEventHandler } from './SubscriptionRenewedEventHandler'

describe('SubscriptionRenewedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let saveRevenueModification: SaveRevenueModification
  let logger: Logger
  let mixpanelClient: Mixpanel | null
  let timer: TimerInterface

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()
  const ALL_PERIODS = [Period.Today, Period.ThisWeek, Period.ThisMonth]

  const createHandler = () =>
    new SubscriptionRenewedEventHandler(
      getUserAnalyticsId,
      analyticsStore,
      saveRevenueModification,
      logger,
      mixpanelClient,
      timer,
    )

  const createEvent = (payload: Record<string, unknown> = {}) =>
    ({
      type: 'SUBSCRIPTION_RENEWED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionId: 5,
        subscriptionName: 'PRO_PLAN',
        billingFrequency: 12,
        payAmount: 119.99,
        subscriptionExpiresAt: 9000,
        offline: true,
        ...payload,
      },
    }) as jest.Mocked<SubscriptionRenewedEvent>

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

    saveRevenueModification = {} as jest.Mocked<SaveRevenueModification>
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.ok({} as RevenueModification))

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>

    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToDate = jest.fn().mockImplementation((microseconds: number) => new Date(microseconds))
  })

  it('marks the subscription-renewed activity', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.SubscriptionRenewed], 123, ALL_PERIODS)
  })

  it('clears any churn marks the user picked up earlier', async () => {
    await createHandler().handle(createEvent())

    expect(analyticsStore.unmarkActivity).toHaveBeenCalledWith(
      [AnalyticsActivity.ExistingCustomersChurn, AnalyticsActivity.NewCustomersChurn],
      123,
      ALL_PERIODS,
    )
  })

  it('always saves the revenue modification as a returning subscriber', async () => {
    await createHandler().handle(createEvent())

    const dto = (saveRevenueModification.execute as jest.Mock).mock.calls[0][0]
    expect(dto.newSubscriber).toEqual(false)
    expect(dto.eventType.value).toEqual('SUBSCRIPTION_RENEWED')
    expect(dto.planName.value).toEqual('PRO_PLAN')
    expect(dto.billingFrequency).toEqual(12)
    expect(dto.payedAmount).toEqual(119.99)
    expect(dto.subscriptionId).toEqual(5)
  })

  it('logs the reason when the revenue modification cannot be saved', async () => {
    saveRevenueModification.execute = jest.fn().mockResolvedValue(Result.fail('database is down'))

    await createHandler().handle(createEvent())

    expect(logger.error).toHaveBeenCalledWith(
      '[SUBSCRIPTION_RENEWED][5] Could not save revenue modification: database is down',
    )
  })

  it('tracks the renewal and keeps the mixpanel profile plan up to date', async () => {
    await createHandler().handle(createEvent())

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_RENEWED', {
      distinct_id: '123',
      subscription_name: 'PRO_PLAN',
      subscription_expires_at: new Date(9000),
      offline: true,
      billing_frequency: 12,
      pay_amount: 119.99,
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('123', 'subscription', 'PRO_PLAN')
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
