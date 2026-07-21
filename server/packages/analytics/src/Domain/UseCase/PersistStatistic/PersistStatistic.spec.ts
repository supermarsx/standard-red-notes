import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'

import { StatisticMeasure } from '../../Statistics/StatisticMeasure'
import { StatisticMeasureName } from '../../Statistics/StatisticMeasureName'
import { StatisticMeasureRepositoryInterface } from '../../Statistics/StatisticMeasureRepositoryInterface'

import { PersistStatistic } from './PersistStatistic'

describe('PersistStatistic', () => {
  let statisticMeasureRepository: StatisticMeasureRepositoryInterface

  const date = new Date('2023-01-02T03:04:05.000Z')

  const createUseCase = () => new PersistStatistic(statisticMeasureRepository)

  beforeEach(() => {
    statisticMeasureRepository = {} as jest.Mocked<StatisticMeasureRepositoryInterface>
    statisticMeasureRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('persists a measure built from the supplied name, date and value', async () => {
    const result = await createUseCase().execute({
      date,
      statisticMeasureName: StatisticMeasureName.NAMES.MRR,
      value: 1234,
    })

    expect(result.isFailed()).toEqual(false)
    expect(result.getValue().name).toEqual('mrr')
    expect(result.getValue().value).toEqual(1234)
    expect(statisticMeasureRepository.save).toHaveBeenCalledWith(result.getValue())
    expect((statisticMeasureRepository.save as jest.Mock).mock.calls[0][0].props.date).toEqual(date)
  })

  it('rejects an unknown measure name without touching the repository', async () => {
    const result = await createUseCase().execute({
      date,
      statisticMeasureName: 'made-up-measure',
      value: 1,
    })

    expect(result.isFailed()).toEqual(true)
    expect(result.getError()).toEqual(
      'Could not persist statistic measure: Invalid statistics measure name: made-up-measure',
    )
    expect(statisticMeasureRepository.save).not.toHaveBeenCalled()
  })

  it('reports a measure that cannot be constructed without touching the repository', async () => {
    jest.spyOn(StatisticMeasure, 'create').mockReturnValueOnce(Result.fail('bad measure'))

    const result = await createUseCase().execute({
      date,
      statisticMeasureName: StatisticMeasureName.NAMES.MRR,
      value: 1,
    })

    expect(result.isFailed()).toEqual(true)
    expect(result.getError()).toEqual('Could not persist statistic measure: bad measure')
    expect(statisticMeasureRepository.save).not.toHaveBeenCalled()
  })
})
