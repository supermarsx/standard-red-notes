import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { RefundProcessedEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'

import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { StatisticsStoreInterface } from '../Statistics/StatisticsStoreInterface'
import { Period } from '../Time/Period'
import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'

import { RefundProcessedEventHandler } from './RefundProcessedEventHandler'

describe('RefundProcessedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let statisticsStore: StatisticsStoreInterface
  let mixpanelClient: Mixpanel | null
  let event: RefundProcessedEvent

  const createHandler = () => new RefundProcessedEventHandler(getUserAnalyticsId, statisticsStore, mixpanelClient)

  beforeEach(() => {
    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest
      .fn()
      .mockResolvedValue(Result.ok<GetUserAnalyticsIdResponse>({ analyticsId: 123 } as GetUserAnalyticsIdResponse))

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.incrementMeasure = jest.fn().mockResolvedValue(undefined)

    mixpanelClient = {
      track: jest.fn(),
      people: { track_charge: jest.fn() },
    } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'REFUND_PROCESSED',
      payload: { userEmail: 'test@test.te', amount: 30 },
    } as jest.Mocked<RefundProcessedEvent>
  })

  it('increments the refunds measure by the refunded amount', async () => {
    await createHandler().handle(event)

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(StatisticMeasureName.NAMES.Refunds, 30, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('reports the refund to mixpanel as a negative charge', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('REFUND_PROCESSED', {
      distinct_id: '123',
      amount: 30,
    })
    expect((mixpanelClient as Mixpanel).people.track_charge).toHaveBeenCalledWith('123', -30)
  })

  it('does nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(event)

    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
    expect((mixpanelClient as Mixpanel).track).not.toHaveBeenCalled()
  })

  it('still increments the refunds measure when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(event)

    expect(statisticsStore.incrementMeasure).toHaveBeenCalled()
  })
})
