import { permissionPickerOptions, permissionSetsEqual, togglePermissionName } from './adminRolesUi'

describe('adminRolesUi', () => {
  describe('togglePermissionName', () => {
    it('adds a permission when enabling, without duplicating', () => {
      expect(togglePermissionName(['A'], 'B', true)).toEqual(['A', 'B'])
      expect(togglePermissionName(['A', 'B'], 'B', true)).toEqual(['A', 'B'])
    })

    it('removes a permission when disabling', () => {
      expect(togglePermissionName(['A', 'B'], 'B', false)).toEqual(['A'])
      expect(togglePermissionName(['A'], 'B', false)).toEqual(['A'])
    })

    it('never mutates the input', () => {
      const input = ['A']
      togglePermissionName(input, 'B', true)
      expect(input).toEqual(['A'])
    })
  })

  describe('permissionPickerOptions', () => {
    it('offers the catalog plus assigned extras the catalog is missing', () => {
      expect(permissionPickerOptions(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
    })

    it('deduplicates the catalog', () => {
      expect(permissionPickerOptions(['A', 'A', 'B'], [])).toEqual(['A', 'B'])
    })
  })

  describe('permissionSetsEqual', () => {
    it('is true for the same set regardless of order', () => {
      expect(permissionSetsEqual(['A', 'B'], ['B', 'A'])).toBe(true)
    })

    it('is false for different sets', () => {
      expect(permissionSetsEqual(['A'], ['A', 'B'])).toBe(false)
      expect(permissionSetsEqual(['A', 'B'], ['A', 'C'])).toBe(false)
    })
  })
})
