import { Id } from './Id'
import { UniqueEntityId } from './UniqueEntityId'

describe('UniqueEntityId', () => {
  it('is an Id', () => {
    expect(new UniqueEntityId('x')).toBeInstanceOf(Id)
  })

  it('generates a v4 uuid when no id is supplied', () => {
    expect(new UniqueEntityId().toValue()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('generates a different uuid on each construction', () => {
    const ids = new Set(Array.from({ length: 20 }, () => new UniqueEntityId().toValue()))

    expect(ids.size).toBe(20)
  })

  it('keeps a supplied string id verbatim', () => {
    expect(new UniqueEntityId('supplied-id').toValue()).toBe('supplied-id')
  })

  it('keeps a supplied numeric id verbatim', () => {
    expect(new UniqueEntityId(42).toValue()).toBe(42)
  })

  it('generates a uuid rather than keeping a falsy supplied id', () => {
    expect(new UniqueEntityId(0).toValue()).not.toBe(0)
    expect(new UniqueEntityId('').toValue()).not.toBe('')
  })

  it('considers two instances wrapping the same id equal', () => {
    expect(new UniqueEntityId('same').equals(new UniqueEntityId('same'))).toBe(true)
  })
})
