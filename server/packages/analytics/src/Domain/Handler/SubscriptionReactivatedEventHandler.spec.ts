import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { SubscriptionReactivatedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Mixpanel } from 'mixpanel'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'

import { SubscriptionReactivatedEventHandler } from './SubscriptionReactivatedEventHandler'

describe('SubscriptionReactivatedEventHandler', () => {
  let analyticsStore: AnalyticsStoreInterface
  let getUserAnalyticsId: GetUserAnalyticsId
  let mixpanelClient: Mixpanel | null
  let timer: TimerInterface
  let event: SubscriptionReactivatedEvent

  const createHandler = () =>
    new SubscriptionReactivatedEventHandler(analyticsStore, getUserAnalyticsId, mixpanelClient, timer)

  beforeEach(() => {
    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)

    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest
      .fn()
      .mockResolvedValue(Result.ok<GetUserAnalyticsIdResponse>({ analyticsId: 123 } as GetUserAnalyticsIdResponse))

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>

    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToDate = jest.fn().mockReturnValue(new Date(9000))

    event = {
      type: 'SUBSCRIPTION_REACTIVATED',
      payload: {
        userEmail: 'test@test.te',
        subscriptionName: 'PRO_PLAN',
        subscriptionExpiresAt: 9000,
        discountCode: 'WELCOME_BACK',
      },
    } as jest.Mocked<SubscriptionReactivatedEvent>
  })

  it('marks the subscription-reactivated activity for today, this week and this month', async () => {
    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.SubscriptionReactivated], 123, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('tracks the reactivation and restores the mixpanel profile plan', async () => {
    await createHandler().handle(event)

    expect(timer.convertMicrosecondsToDate).toHaveBeenCalledWith(9000)
    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('SUBSCRIPTION_REACTIVATED', {
      distinct_id: '123',
      subscription_name: 'PRO_PLAN',
      subscription_expires_at: new Date(9000),
      discount_code: 'WELCOME_BACK',
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('123', 'subscription', 'PRO_PLAN')
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(event)

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect((mixpanelClient as Mixpanel).track).not.toHaveBeenCalled()
  })

  it('still marks the activity when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalled()
  })
})
