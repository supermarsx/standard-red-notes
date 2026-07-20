import { UuidGenerator } from './UuidGenerator'
import { Uuids } from './Utils'

describe('Uuids', () => {
  it('should map items to their uuids in order', () => {
    expect(Uuids([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }])).toEqual(['a', 'b', 'c'])
  })

  it('should return an empty array for no items', () => {
    expect(Uuids([])).toEqual([])
  })
})

describe('UuidGenerator', () => {
  it('should delegate to the generator that was set', () => {
    const generator = jest.fn().mockReturnValue('generated-uuid')
    UuidGenerator.SetGenerator(generator)

    expect(UuidGenerator.GenerateUuid()).toBe('generated-uuid')
    expect(generator).toHaveBeenCalledTimes(1)
  })

  it('should use the most recently set generator', () => {
    UuidGenerator.SetGenerator(() => 'first')
    UuidGenerator.SetGenerator(() => 'second')

    expect(UuidGenerator.GenerateUuid()).toBe('second')
  })
})
