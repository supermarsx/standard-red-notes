import 'reflect-metadata'

import * as IORedis from 'ioredis'

import { StatisticMeasure } from '../../Domain/Statistics/StatisticMeasure'
import { StatisticMeasureName } from '../../Domain/Statistics/StatisticMeasureName'
import { Period } from '../../Domain/Time/Period'
import { PeriodKeyGeneratorInterface } from '../../Domain/Time/PeriodKeyGeneratorInterface'

import { RedisStatisticsStore } from './RedisStatisticsStore'

describe('RedisStatisticsStore', () => {
  let periodKeyGenerator: PeriodKeyGeneratorInterface
  let redisClient: IORedis.Redis
  let pipeline: { set: jest.Mock; incr: jest.Mock; incrbyfloat: jest.Mock; exec: jest.Mock }

  const createStore = () => new RedisStatisticsStore(periodKeyGenerator, redisClient)

  beforeEach(() => {
    periodKeyGenerator = {} as jest.Mocked<PeriodKeyGeneratorInterface>
    periodKeyGenerator.getPeriodKey = jest.fn().mockReturnValue('2023-1-1')
    periodKeyGenerator.getDailyKey = jest.fn().mockReturnValue('2023-1-2')
    periodKeyGenerator.getDiscretePeriodKeys = jest.fn().mockReturnValue(['2023-1-1', '2023-1-2'])

    pipeline = { set: jest.fn(), incr: jest.fn(), incrbyfloat: jest.fn(), exec: jest.fn().mockResolvedValue([]) }

    redisClient = {} as jest.Mocked<IORedis.Redis>
    redisClient.pipeline = jest.fn().mockReturnValue(pipeline)
    redisClient.get = jest.fn().mockResolvedValue('12')
    redisClient.keys = jest.fn().mockResolvedValue([])
  })

  describe('save', () => {
    it('stores the measure under the daily key of its own date', async () => {
      const date = new Date('2023-01-02T00:00:00.000Z')
      const statisticMeasure = StatisticMeasure.create({
        date,
        name: StatisticMeasureName.create(StatisticMeasureName.NAMES.MRR).getValue(),
        value: 99.5,
      }).getValue()

      await createStore().save(statisticMeasure)

      expect(periodKeyGenerator.getDailyKey).toHaveBeenCalledWith(date)
      expect(pipeline.set).toHaveBeenCalledWith('count:measure:mrr:timespan:2023-1-2', 99.5)
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })
  })

  describe('calculateTotalCountOverPeriod', () => {
    it('returns the total for each discrete period key', async () => {
      redisClient.get = jest.fn().mockResolvedValueOnce('10').mockResolvedValueOnce('20')

      const result = await createStore().calculateTotalCountOverPeriod('mrr', Period.Last30Days)

      expect(result).toEqual([
        { periodKey: '2023-1-1', totalCount: 10 },
        { periodKey: '2023-1-2', totalCount: 20 },
      ])
    })

    it.each([
      Period.Last30Days,
      Period.Last30DaysIncludingToday,
      Period.ThisYear,
      Period.Q1ThisYear,
      Period.Q2ThisYear,
      Period.Q3ThisYear,
      Period.Q4ThisYear,
    ])('accepts period %s', async (period) => {
      await expect(createStore().calculateTotalCountOverPeriod('mrr', period)).resolves.toHaveLength(2)
    })

    it('rejects a period that has no discrete breakdown', async () => {
      await expect(createStore().calculateTotalCountOverPeriod('mrr', Period.Yesterday)).rejects.toThrow(
        'Unsuporrted period: 1',
      )
    })
  })

  describe('getMeasureIncrementCounts', () => {
    it('returns the stored increment count as a number', async () => {
      await expect(createStore().getMeasureIncrementCounts('income', Period.Today)).resolves.toEqual(12)

      expect(redisClient.get).toHaveBeenCalledWith('count:increments:income:timespan:2023-1-1')
    })

    it('returns zero when the counter has never been written', async () => {
      redisClient.get = jest.fn().mockResolvedValue(null)

      await expect(createStore().getMeasureIncrementCounts('income', Period.Today)).resolves.toEqual(0)
    })
  })

  describe('setMeasure', () => {
    it('writes the value once per supplied period', async () => {
      await createStore().setMeasure('income', 5, [Period.Today, Period.ThisWeek])

      expect(pipeline.set).toHaveBeenCalledTimes(2)
      expect(pipeline.set).toHaveBeenCalledWith('count:measure:income:timespan:2023-1-1', 5)
    })

    it('uses literal period keys without consulting the key generator', async () => {
      await createStore().setMeasure('income', 5, ['2022-12-31'])

      expect(periodKeyGenerator.getPeriodKey).not.toHaveBeenCalled()
      expect(pipeline.set).toHaveBeenCalledWith('count:measure:income:timespan:2022-12-31', 5)
    })
  })

  describe('getMeasureTotal', () => {
    it('resolves a Period enum member into its period key', async () => {
      await expect(createStore().getMeasureTotal('income', Period.Today)).resolves.toEqual(12)

      expect(redisClient.get).toHaveBeenCalledWith('count:measure:income:timespan:2023-1-1')
    })

    it('uses a literal period key as given', async () => {
      await createStore().getMeasureTotal('income', '2022-12-31')

      expect(redisClient.get).toHaveBeenCalledWith('count:measure:income:timespan:2022-12-31')
    })

    it('returns zero when the measure has never been written', async () => {
      redisClient.get = jest.fn().mockResolvedValue(null)

      await expect(createStore().getMeasureTotal('income', Period.Today)).resolves.toEqual(0)
    })
  })

  describe('incrementMeasure', () => {
    it('increments both the value and the increment counter per period', async () => {
      await createStore().incrementMeasure('income', 2.5, [Period.Today, Period.ThisWeek])

      expect(pipeline.incrbyfloat).toHaveBeenCalledTimes(2)
      expect(pipeline.incrbyfloat).toHaveBeenCalledWith('count:measure:income:timespan:2023-1-1', 2.5)
      expect(pipeline.incr).toHaveBeenCalledTimes(2)
      expect(pipeline.incr).toHaveBeenCalledWith('count:increments:income:timespan:2023-1-1')
    })
  })

  describe('getMeasureAverage', () => {
    it('divides the total by the number of increments', async () => {
      redisClient.get = jest.fn().mockResolvedValueOnce('4').mockResolvedValueOnce('10')

      await expect(createStore().getMeasureAverage('income', Period.Today)).resolves.toEqual(2.5)
    })

    it('returns zero without reading the total when nothing was ever incremented', async () => {
      redisClient.get = jest.fn().mockResolvedValue(null)

      await expect(createStore().getMeasureAverage('income', Period.Today)).resolves.toEqual(0)
      expect(redisClient.get).toHaveBeenCalledTimes(1)
    })
  })

  describe('out of sync incidents', () => {
    it('reads yesterdays incident count', async () => {
      await expect(createStore().getYesterdayOutOfSyncIncidents()).resolves.toEqual(12)

      expect(periodKeyGenerator.getPeriodKey).toHaveBeenCalledWith(Period.Yesterday)
      expect(redisClient.get).toHaveBeenCalledWith('count:action:out-of-sync:timespan:2023-1-1')
    })

    it('reports zero incidents when the counter is missing', async () => {
      redisClient.get = jest.fn().mockResolvedValue(null)

      await expect(createStore().getYesterdayOutOfSyncIncidents()).resolves.toEqual(0)
    })

    it('increments today, this week and this month in one pipeline', async () => {
      await createStore().incrementOutOfSyncIncidents()

      expect(pipeline.incr).toHaveBeenCalledTimes(3)
      expect(periodKeyGenerator.getPeriodKey).toHaveBeenCalledWith(Period.Today)
      expect(periodKeyGenerator.getPeriodKey).toHaveBeenCalledWith(Period.ThisWeek)
      expect(periodKeyGenerator.getPeriodKey).toHaveBeenCalledWith(Period.ThisMonth)
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })
  })

  describe('version usage', () => {
    it('reports yesterdays snjs usage keyed by the version inside the redis key', async () => {
      redisClient.keys = jest
        .fn()
        .mockResolvedValue([
          'count:action:snjs-request:2.20.0:timespan:2023-1-1',
          'count:action:snjs-request:2.21.0:timespan:2023-1-1',
        ])
      redisClient.get = jest.fn().mockResolvedValueOnce('3').mockResolvedValueOnce('4')

      const result = await createStore().getYesterdaySNJSUsage()

      expect(redisClient.keys).toHaveBeenCalledWith('count:action:snjs-request:*:timespan:2023-1-1')
      expect(result).toEqual([
        { version: '2.20.0', count: 3 },
        { version: '2.21.0', count: 4 },
      ])
    })

    it('reports yesterdays application usage from the application-request keys', async () => {
      redisClient.keys = jest.fn().mockResolvedValue(['count:action:application-request:3.1.0:timespan:2023-1-1'])
      redisClient.get = jest.fn().mockResolvedValue('9')

      const result = await createStore().getYesterdayApplicationUsage()

      expect(redisClient.keys).toHaveBeenCalledWith('count:action:application-request:*:timespan:2023-1-1')
      expect(result).toEqual([{ version: '3.1.0', count: 9 }])
    })

    it('reports no usage when no version keys exist', async () => {
      await expect(createStore().getYesterdaySNJSUsage()).resolves.toEqual([])
    })

    it('increments application version usage for today, this week and this month', async () => {
      await createStore().incrementApplicationVersionUsage('3.1.0')

      expect(pipeline.incr).toHaveBeenCalledTimes(3)
      expect(pipeline.incr).toHaveBeenCalledWith('count:action:application-request:3.1.0:timespan:2023-1-1')
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })

    it('increments snjs version usage for today, this week and this month', async () => {
      await createStore().incrementSNJSVersionUsage('2.20.0')

      expect(pipeline.incr).toHaveBeenCalledTimes(3)
      expect(pipeline.incr).toHaveBeenCalledWith('count:action:snjs-request:2.20.0:timespan:2023-1-1')
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })
  })
})
