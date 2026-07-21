import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { StatisticPersistenceRequestedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Mixpanel } from 'mixpanel'
import { Logger } from 'winston'

import { StatisticMeasure } from '../Statistics/StatisticMeasure'
import { PersistStatistic } from '../UseCase/PersistStatistic/PersistStatistic'

import { StatisticPersistenceRequestedEventHandler } from './StatisticPersistenceRequestedEventHandler'

describe('StatisticPersistenceRequestedEventHandler', () => {
  let persistStatistic: PersistStatistic
  let timer: TimerInterface
  let logger: Logger
  let mixpanelClient: Mixpanel | null
  let event: StatisticPersistenceRequestedEvent

  const date = new Date('2023-01-02T03:04:05.000Z')

  const createHandler = () =>
    new StatisticPersistenceRequestedEventHandler(persistStatistic, timer, logger, mixpanelClient)

  beforeEach(() => {
    persistStatistic = {} as jest.Mocked<PersistStatistic>
    persistStatistic.execute = jest.fn().mockResolvedValue(Result.ok({} as StatisticMeasure))

    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToDate = jest.fn().mockReturnValue(date)

    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    mixpanelClient = { track: jest.fn() } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'STATISTIC_PERSISTENCE_REQUESTED',
      payload: { date: 1_672_628_645_000_000, statisticMeasureName: 'mrr', value: 42 },
    } as jest.Mocked<StatisticPersistenceRequestedEvent>
  })

  it('persists the statistic with the event timestamp converted to a date', async () => {
    await createHandler().handle(event)

    expect(timer.convertMicrosecondsToDate).toHaveBeenCalledWith(1_672_628_645_000_000)
    expect(persistStatistic.execute).toHaveBeenCalledWith({
      date,
      statisticMeasureName: 'mrr',
      value: 42,
    })
  })

  it('does not log an error when persisting succeeds', async () => {
    await createHandler().handle(event)

    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs the reason when persisting the statistic fails', async () => {
    persistStatistic.execute = jest.fn().mockResolvedValue(Result.fail('Invalid statistics measure name: mrr'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Invalid statistics measure name: mrr')
  })

  it('tracks the statistic in mixpanel under the global-stats identity', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('STATISTIC_PERSISTENCE_REQUESTED', {
      distinct_id: 'global-stats',
      statistic: 'mrr',
      value: 42,
    })
  })

  it('still persists the statistic when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(event)

    expect(persistStatistic.execute).toHaveBeenCalled()
  })
})
