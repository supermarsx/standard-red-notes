import 'reflect-metadata'

import * as IORedis from 'ioredis'

import { AnalyticsActivity } from '../../Domain/Analytics/AnalyticsActivity'
import { Period } from '../../Domain/Time/Period'
import { PeriodKeyGeneratorInterface } from '../../Domain/Time/PeriodKeyGeneratorInterface'

import { RedisAnalyticsStore } from './RedisAnalyticsStore'

describe('RedisAnalyticsStore', () => {
  let periodKeyGenerator: PeriodKeyGeneratorInterface
  let redisClient: IORedis.Redis
  let pipeline: { setbit: jest.Mock; exec: jest.Mock }

  const createStore = () => new RedisAnalyticsStore(periodKeyGenerator, redisClient)

  beforeEach(() => {
    periodKeyGenerator = {} as jest.Mocked<PeriodKeyGeneratorInterface>
    periodKeyGenerator.getPeriodKey = jest.fn().mockReturnValue('2023-1-1')
    periodKeyGenerator.getDiscretePeriodKeys = jest.fn().mockReturnValue(['2023-1-1', '2023-1-2', '2023-1-3'])

    pipeline = { setbit: jest.fn(), exec: jest.fn().mockResolvedValue([]) }

    redisClient = {} as jest.Mocked<IORedis.Redis>
    redisClient.pipeline = jest.fn().mockReturnValue(pipeline)
    redisClient.bitop = jest.fn().mockResolvedValue(1)
    redisClient.bitcount = jest.fn().mockResolvedValue(7)
    redisClient.expire = jest.fn().mockResolvedValue(1)
    redisClient.getbit = jest.fn().mockResolvedValue(1)
  })

  describe('calculateActivityTotalCountOverTime', () => {
    it('unions the daily bitmaps into an expiring range key and counts it', async () => {
      const result = await createStore().calculateActivityTotalCountOverTime(
        AnalyticsActivity.Register,
        Period.Last30Days,
      )

      expect(redisClient.bitop).toHaveBeenCalledWith(
        'OR',
        'bitmap:action:register:timespan:2023-1-1-2023-1-3',
        'bitmap:action:register:timespan:2023-1-1',
        'bitmap:action:register:timespan:2023-1-2',
        'bitmap:action:register:timespan:2023-1-3',
      )
      expect(redisClient.expire).toHaveBeenCalledWith('bitmap:action:register:timespan:2023-1-1-2023-1-3', 3600)
      expect(redisClient.bitcount).toHaveBeenCalledWith('bitmap:action:register:timespan:2023-1-1-2023-1-3')
      expect(result).toEqual(7)
    })

    it.each([Period.Q1ThisYear, Period.Q2ThisYear, Period.Q3ThisYear, Period.Q4ThisYear])(
      'accepts quarter period %s',
      async (period) => {
        await expect(
          createStore().calculateActivityTotalCountOverTime(AnalyticsActivity.Register, period),
        ).resolves.toEqual(7)
      },
    )

    it('rejects a period that has no discrete daily breakdown', async () => {
      await expect(
        createStore().calculateActivityTotalCountOverTime(AnalyticsActivity.Register, Period.ThisWeek),
      ).rejects.toThrow('Unsuporrted period: 3')

      expect(redisClient.bitop).not.toHaveBeenCalled()
    })
  })

  describe('calculateActivityChangesTotalCount', () => {
    it('counts each discrete period key separately', async () => {
      redisClient.bitcount = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3)

      const result = await createStore().calculateActivityChangesTotalCount(
        AnalyticsActivity.DeleteAccount,
        Period.Last30Days,
      )

      expect(result).toEqual([
        { periodKey: '2023-1-1', totalCount: 1 },
        { periodKey: '2023-1-2', totalCount: 2 },
        { periodKey: '2023-1-3', totalCount: 3 },
      ])
      expect(redisClient.bitcount).toHaveBeenNthCalledWith(1, 'bitmap:action:DeleteAccount:timespan:2023-1-1')
    })

    it('rejects a period that has no discrete daily breakdown', async () => {
      await expect(
        createStore().calculateActivityChangesTotalCount(AnalyticsActivity.Register, Period.Today),
      ).rejects.toThrow('Unsuporrted period: 0')
    })
  })

  describe('markActivity / unmarkActivity', () => {
    it('sets one bit per activity and period in a single pipeline', async () => {
      await createStore().markActivity([AnalyticsActivity.Register, AnalyticsActivity.PaymentSuccess], 42, [
        Period.Today,
        Period.ThisWeek,
      ])

      expect(pipeline.setbit).toHaveBeenCalledTimes(4)
      expect(pipeline.setbit).toHaveBeenCalledWith('bitmap:action:register:timespan:2023-1-1', 42, 1)
      expect(pipeline.setbit).toHaveBeenCalledWith('bitmap:action:payment-success:timespan:2023-1-1', 42, 1)
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })

    it('clears the same bits when unmarking', async () => {
      await createStore().unmarkActivity([AnalyticsActivity.NewCustomersChurn], 42, [Period.ThisMonth])

      expect(pipeline.setbit).toHaveBeenCalledWith('bitmap:action:new-customers-churn:timespan:2023-1-1', 42, 0)
      expect(pipeline.exec).toHaveBeenCalledTimes(1)
    })
  })

  describe('wasActivityDone', () => {
    it('is true only when the stored bit is set', async () => {
      await expect(createStore().wasActivityDone(AnalyticsActivity.Register, 42, Period.Today)).resolves.toEqual(true)

      expect(redisClient.getbit).toHaveBeenCalledWith('bitmap:action:register:timespan:2023-1-1', 42)
    })

    it('is false when the stored bit is clear', async () => {
      redisClient.getbit = jest.fn().mockResolvedValue(0)

      await expect(createStore().wasActivityDone(AnalyticsActivity.Register, 42, Period.Today)).resolves.toEqual(false)
    })
  })

  describe('calculateActivitiesRetention', () => {
    it('reports the retained share as a percentage rounded up', async () => {
      redisClient.bitcount = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(3)

      const result = await createStore().calculateActivitiesRetention({
        firstActivity: AnalyticsActivity.Register,
        firstActivityPeriodKey: '2023-1-1',
        secondActivity: AnalyticsActivity.SubscriptionPurchased,
        secondActivityPeriodKey: '2023-1-2',
      })

      expect(redisClient.bitop).toHaveBeenCalledWith(
        'AND',
        'bitmap:action:register-subscription-purchased:timespan:2023-1-2',
        'bitmap:action:register:timespan:2023-1-1',
        'bitmap:action:subscription-purchased:timespan:2023-1-2',
      )
      expect(redisClient.expire).toHaveBeenCalledWith(
        'bitmap:action:register-subscription-purchased:timespan:2023-1-2',
        3600,
      )
      expect(result).toEqual(34)
    })
  })

  describe('calculateActivityRetention', () => {
    it('compares one activity against itself across two period keys', async () => {
      periodKeyGenerator.getPeriodKey = jest.fn().mockReturnValueOnce('2023-1-1').mockReturnValueOnce('2023-1-2')
      redisClient.bitcount = jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(10)

      const result = await createStore().calculateActivityRetention(
        AnalyticsActivity.Register,
        Period.LastMonth,
        Period.ThisMonth,
      )

      expect(redisClient.bitop).toHaveBeenCalledWith(
        'AND',
        'bitmap:action:register-register:timespan:2023-1-2',
        'bitmap:action:register:timespan:2023-1-1',
        'bitmap:action:register:timespan:2023-1-2',
      )
      expect(result).toEqual(50)
    })
  })

  describe('calculateActivityTotalCount', () => {
    it('resolves a Period enum member into its period key', async () => {
      const result = await createStore().calculateActivityTotalCount(AnalyticsActivity.Register, Period.Today)

      expect(periodKeyGenerator.getPeriodKey).toHaveBeenCalledWith(Period.Today)
      expect(redisClient.bitcount).toHaveBeenCalledWith('bitmap:action:register:timespan:2023-1-1')
      expect(result).toEqual(7)
    })

    it('uses a literal period key as given', async () => {
      await createStore().calculateActivityTotalCount(AnalyticsActivity.Register, '2022-12-31')

      expect(periodKeyGenerator.getPeriodKey).not.toHaveBeenCalled()
      expect(redisClient.bitcount).toHaveBeenCalledWith('bitmap:action:register:timespan:2022-12-31')
    })
  })
})
