import { Aggregate } from './Aggregate'
import { Change } from './Change'
import { Entity } from './Entity'

class TestAggregate extends Aggregate<{ name: string }> {}
class TestEntity extends Entity<{ name: string }> {}

describe('Aggregate', () => {
  const createChange = (changeType: string) =>
    Change.create({
      aggregateRootUuid: 'aggregate-uuid',
      changeType,
      changeData: new TestEntity({ name: 'a' }) as unknown as Entity<unknown>,
    }).getValue()

  it('is an Entity', () => {
    expect(new TestAggregate({ name: 'a' })).toBeInstanceOf(Entity)
  })

  it('starts with no recorded changes', () => {
    expect(new TestAggregate({ name: 'a' }).getChanges()).toEqual([])
  })

  it('records changes in the order they were added', () => {
    const aggregate = new TestAggregate({ name: 'a' })
    const first = createChange(Change.TYPES.Add)
    const second = createChange(Change.TYPES.Remove)

    aggregate.addChange(first)
    aggregate.addChange(second)

    expect(aggregate.getChanges()).toEqual([first, second])
  })

  it('drops every recorded change on flush', () => {
    const aggregate = new TestAggregate({ name: 'a' })
    aggregate.addChange(createChange(Change.TYPES.Add))

    aggregate.flushChanges()

    expect(aggregate.getChanges()).toEqual([])
  })

  it('keeps recording after a flush', () => {
    const aggregate = new TestAggregate({ name: 'a' })
    aggregate.addChange(createChange(Change.TYPES.Add))
    aggregate.flushChanges()

    const afterFlush = createChange(Change.TYPES.Modify)
    aggregate.addChange(afterFlush)

    expect(aggregate.getChanges()).toEqual([afterFlush])
  })

  it('does not share its change list between two aggregate instances', () => {
    const first = new TestAggregate({ name: 'a' })
    const second = new TestAggregate({ name: 'b' })

    first.addChange(createChange(Change.TYPES.Add))

    expect(second.getChanges()).toEqual([])
  })
})
