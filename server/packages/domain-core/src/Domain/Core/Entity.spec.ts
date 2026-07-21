import { Entity } from './Entity'
import { UniqueEntityId } from './UniqueEntityId'

class TestEntity extends Entity<{ name: string }> {}
class OtherEntity extends Entity<{ name: string }> {}

describe('Entity', () => {
  it('generates an id when none is supplied', () => {
    const entity = new TestEntity({ name: 'a' })

    expect(entity.id).toBeInstanceOf(UniqueEntityId)
    expect(entity.id.toValue()).toEqual(expect.any(String))
  })

  it('gives two entities constructed without an id distinct identities', () => {
    expect(new TestEntity({ name: 'a' }).id.toValue()).not.toEqual(new TestEntity({ name: 'a' }).id.toValue())
  })

  it('keeps the supplied id instead of generating one', () => {
    const id = new UniqueEntityId('fixed-id')

    expect(new TestEntity({ name: 'a' }, id).id).toBe(id)
  })

  it('exposes the props it was constructed with', () => {
    expect(new TestEntity({ name: 'a' }).props).toEqual({ name: 'a' })
  })

  describe('equals', () => {
    it('is true for the same instance', () => {
      const entity = new TestEntity({ name: 'a' })

      expect(entity.equals(entity)).toBe(true)
    })

    it('compares by id, not by props', () => {
      const id = new UniqueEntityId('shared-id')

      expect(new TestEntity({ name: 'a' }, id).equals(new TestEntity({ name: 'DIFFERENT' }, id))).toBe(true)
    })

    it('is false for entities with different ids but identical props', () => {
      const a = new TestEntity({ name: 'a' }, new UniqueEntityId('one'))
      const b = new TestEntity({ name: 'a' }, new UniqueEntityId('two'))

      expect(a.equals(b)).toBe(false)
    })

    it('is false when compared with undefined', () => {
      expect(new TestEntity({ name: 'a' }).equals(undefined)).toBe(false)
    })

    it('is false when compared with null', () => {
      expect(new TestEntity({ name: 'a' }).equals(null as unknown as Entity<{ name: string }>)).toBe(false)
    })

    it('is false when compared with a non-entity object', () => {
      expect(new TestEntity({ name: 'a' }).equals({ id: 'x' } as unknown as Entity<{ name: string }>)).toBe(false)
    })

    it('matches across subclasses that share an id, because the check is instanceof Entity', () => {
      const id = new UniqueEntityId('shared-id')

      expect(new TestEntity({ name: 'a' }, id).equals(new OtherEntity({ name: 'a' }, id))).toBe(true)
    })
  })
})
