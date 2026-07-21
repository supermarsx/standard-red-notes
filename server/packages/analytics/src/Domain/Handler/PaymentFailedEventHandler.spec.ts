import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { PaymentFailedEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'

import { PaymentFailedEventHandler } from './PaymentFailedEventHandler'

describe('PaymentFailedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let analyticsStore: AnalyticsStoreInterface
  let mixpanelClient: Mixpanel | null
  let event: PaymentFailedEvent

  const createHandler = () => new PaymentFailedEventHandler(getUserAnalyticsId, analyticsStore, mixpanelClient)

  beforeEach(() => {
    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest
      .fn()
      .mockResolvedValue(Result.ok<GetUserAnalyticsIdResponse>({ analyticsId: 123 } as GetUserAnalyticsIdResponse))

    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)

    mixpanelClient = { track: jest.fn() } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'PAYMENT_FAILED',
      payload: { userEmail: 'test@test.te' },
    } as jest.Mocked<PaymentFailedEvent>
  })

  it('looks the analytics id up by the email on the event', async () => {
    await createHandler().handle(event)

    expect(getUserAnalyticsId.execute).toHaveBeenCalledWith({ userEmail: 'test@test.te' })
  })

  it('marks the payment-failed activity for today, this week and this month', async () => {
    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.PaymentFailed], 123, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('tracks the event in mixpanel against the analytics id', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('PAYMENT_FAILED', { distinct_id: '123' })
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
