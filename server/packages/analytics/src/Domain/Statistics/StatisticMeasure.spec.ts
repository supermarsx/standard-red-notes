import 'reflect-metadata'

import { UniqueEntityId } from '@standardnotes/domain-core'

import { StatisticMeasure } from './StatisticMeasure'
import { StatisticMeasureName } from './StatisticMeasureName'

describe('StatisticMeasure', () => {
  const date = new Date('2023-01-02T03:04:05.000Z')
  const name = StatisticMeasureName.create(StatisticMeasureName.NAMES.ActiveUsers).getValue()

  it('exposes the measure name as a plain string', () => {
    const measure = StatisticMeasure.create({ date, name, value: 10 }).getValue()

    expect(measure.name).toEqual('active-users')
  })

  it('exposes the recorded value', () => {
    expect(StatisticMeasure.create({ date, name, value: 10 }).getValue().value).toEqual(10)
  })

  it('keeps the identifier it is created with', () => {
    const id = new UniqueEntityId('84c0f8e8-544a-4c7e-9adf-26209303bc1d')

    expect(StatisticMeasure.create({ date, name, value: 10 }, id).getValue().id).toEqual(id)
  })

  it('generates an identifier when none is supplied', () => {
    const measure = StatisticMeasure.create({ date, name, value: 10 }).getValue()

    expect(measure.id).toBeDefined()
    expect(measure.id.toString()).not.toEqual(
      StatisticMeasure.create({ date, name, value: 10 }).getValue().id.toString(),
    )
  })
})
