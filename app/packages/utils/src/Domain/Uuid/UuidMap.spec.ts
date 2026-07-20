import { UuidMap } from './UuidMap'

describe('UuidMap', () => {
  let map: UuidMap

  beforeEach(() => {
    map = new UuidMap()
  })

  it('should start empty', () => {
    expect(map.directMapSize).toBe(0)
    expect(map.inverseMapSize).toBe(0)
    expect(map.existsInDirectMap('a')).toBe(false)
    expect(map.existsInInverseMap('a')).toBe(false)
    expect(map.getDirectRelationships('a')).toEqual([])
    expect(map.getInverseRelationships('a')).toEqual([])
    expect(map.getAllDirectKeys()).toEqual([])
  })

  describe('establishRelationship', () => {
    it('should record the relationship in both directions', () => {
      map.establishRelationship('a', 'b')

      expect(map.getDirectRelationships('a')).toEqual(['b'])
      expect(map.getInverseRelationships('b')).toEqual(['a'])
      expect(map.existsInDirectMap('a')).toBe(true)
      expect(map.existsInInverseMap('b')).toBe(true)
    })

    it('should not duplicate an existing relationship', () => {
      map.establishRelationship('a', 'b')
      map.establishRelationship('a', 'b')

      expect(map.getDirectRelationships('a')).toEqual(['b'])
      expect(map.getInverseRelationships('b')).toEqual(['a'])
    })

    it('should support several relationships from one uuid', () => {
      map.establishRelationship('a', 'b')
      map.establishRelationship('a', 'c')

      expect(map.getDirectRelationships('a')).toEqual(['b', 'c'])
      expect(map.getAllDirectKeys()).toEqual(['a'])
    })
  })

  describe('deestablishRelationship', () => {
    it('should remove the relationship in both directions', () => {
      map.establishRelationship('a', 'b')

      map.deestablishRelationship('a', 'b')

      expect(map.getDirectRelationships('a')).toEqual([])
      expect(map.getInverseRelationships('b')).toEqual([])
    })

    it('should leave other relationships intact', () => {
      map.establishRelationship('a', 'b')
      map.establishRelationship('a', 'c')

      map.deestablishRelationship('a', 'b')

      expect(map.getDirectRelationships('a')).toEqual(['c'])
    })

    it('should be a no-op for a relationship that was never established', () => {
      map.deestablishRelationship('a', 'b')

      expect(map.getDirectRelationships('a')).toEqual([])
    })
  })

  describe('setAllRelationships', () => {
    it('should replace the direct relationships wholesale', () => {
      map.establishRelationship('a', 'b')

      map.setAllRelationships('a', ['c', 'd'])

      expect(map.getDirectRelationships('a')).toEqual(['c', 'd'])
    })

    it('should drop the inverse entries of the relationships that went away', () => {
      map.establishRelationship('a', 'b')

      map.setAllRelationships('a', ['c'])

      expect(map.getInverseRelationships('b')).toEqual([])
      expect(map.getInverseRelationships('c')).toEqual(['a'])
    })

    it('should work when the uuid had no previous relationships', () => {
      map.setAllRelationships('a', ['b'])

      expect(map.getInverseRelationships('b')).toEqual(['a'])
    })
  })

  describe('removeFromMap', () => {
    it('should remove the uuid from the maps it keys', () => {
      map.establishRelationship('a', 'b')

      map.removeFromMap('a')

      expect(map.existsInDirectMap('a')).toBe(false)
      expect(map.getInverseRelationships('b')).toEqual([])
    })

    it('should remove the uuid from the direct lists of those referencing it', () => {
      map.establishRelationship('a', 'b')

      map.removeFromMap('b')

      expect(map.getDirectRelationships('a')).toEqual([])
      expect(map.existsInInverseMap('b')).toBe(false)
    })

    it('should be a no-op for an unknown uuid', () => {
      map.establishRelationship('a', 'b')

      map.removeFromMap('zzz')

      expect(map.getDirectRelationships('a')).toEqual(['b'])
    })
  })

  describe('makeCopy', () => {
    it('should carry over the existing relationships', () => {
      map.establishRelationship('a', 'b')

      const copy = map.makeCopy()

      expect(copy.getDirectRelationships('a')).toEqual(['b'])
      expect(copy.getInverseRelationships('b')).toEqual(['a'])
      expect(copy.directMapSize).toBe(1)
      expect(copy.inverseMapSize).toBe(1)
    })

    it('should not add new keys to the original', () => {
      map.establishRelationship('a', 'b')
      const copy = map.makeCopy()

      copy.establishRelationship('x', 'y')

      expect(map.existsInDirectMap('x')).toBe(false)
    })
  })
})
