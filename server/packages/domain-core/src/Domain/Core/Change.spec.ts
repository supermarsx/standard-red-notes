import { Change } from './Change'
import { Entity } from './Entity'

class TestEntity extends Entity<{ name: string }> {}

describe('Change', () => {
  const changeData = new TestEntity({ name: 'a' }) as unknown as Entity<unknown>

  it('declares exactly the add, remove and modify change types', () => {
    expect(Change.TYPES).toEqual({ Add: 'add', Remove: 'remove', Modify: 'modify' })
  })

  it.each(Object.values(Change.TYPES))('accepts the %s change type', (changeType) => {
    const result = Change.create({ aggregateRootUuid: 'uuid', changeType, changeData })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().props.changeType).toBe(changeType)
  })

  it('preserves the aggregate root uuid and change data', () => {
    const change = Change.create({
      aggregateRootUuid: 'aggregate-uuid',
      changeType: Change.TYPES.Add,
      changeData,
    }).getValue()

    expect(change.props.aggregateRootUuid).toBe('aggregate-uuid')
    expect(change.props.changeData).toBe(changeData)
  })

  it('rejects an unknown change type', () => {
    const result = Change.create({ aggregateRootUuid: 'uuid', changeType: 'destroy', changeData })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Invalid change type')
  })

  it('rejects a type-key rather than a type-value, e.g. "Add" instead of "add"', () => {
    expect(Change.create({ aggregateRootUuid: 'uuid', changeType: 'Add', changeData }).isFailed()).toBe(true)
  })

  it('freezes the props so a change is immutable once created', () => {
    const change = Change.create({ aggregateRootUuid: 'uuid', changeType: Change.TYPES.Add, changeData }).getValue()

    expect(Object.isFrozen(change.props)).toBe(true)
  })
})
