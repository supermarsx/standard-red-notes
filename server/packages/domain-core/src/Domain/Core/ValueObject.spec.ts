import { ValueObject } from './ValueObject'

class TestValueObject extends ValueObject<{ value: string }> {
  get value(): string {
    return this.props.value
  }
}

describe('ValueObject', () => {
  it('exposes the props it was constructed with', () => {
    expect(new TestValueObject({ value: 'a' }).value).toBe('a')
  })

  it('freezes the props so a value object cannot be mutated after construction', () => {
    const vo = new TestValueObject({ value: 'a' })

    expect(Object.isFrozen(vo.props)).toBe(true)
    expect(() => {
      ;(vo.props as { value: string }).value = 'mutated'
    }).toThrow()
    expect(vo.value).toBe('a')
  })

  describe('equals', () => {
    it('compares by props value, not by reference', () => {
      expect(new TestValueObject({ value: 'a' }).equals(new TestValueObject({ value: 'a' }))).toBe(true)
    })

    it('is false for different props', () => {
      expect(new TestValueObject({ value: 'a' }).equals(new TestValueObject({ value: 'b' }))).toBe(false)
    })

    it('is false when compared with undefined', () => {
      expect(new TestValueObject({ value: 'a' }).equals(undefined)).toBe(false)
    })

    it('is false when compared with null', () => {
      expect(new TestValueObject({ value: 'a' }).equals(null as unknown as ValueObject<{ value: string }>)).toBe(false)
    })
  })
})
