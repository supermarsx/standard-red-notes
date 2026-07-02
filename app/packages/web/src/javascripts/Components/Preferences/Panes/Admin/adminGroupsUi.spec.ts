import { rolePickerOptions, toggleRoleName } from './adminGroupsUi'

describe('toggleRoleName', () => {
  it('appends a newly enabled role', () => {
    expect(toggleRoleName(['A'], 'B', true)).toEqual(['A', 'B'])
  })

  it('does not duplicate an already-present role', () => {
    expect(toggleRoleName(['A', 'B'], 'B', true)).toEqual(['A', 'B'])
  })

  it('removes a disabled role', () => {
    expect(toggleRoleName(['A', 'B'], 'A', false)).toEqual(['B'])
  })

  it('is a no-op removal when the role is absent', () => {
    expect(toggleRoleName(['A'], 'B', false)).toEqual(['A'])
  })

  it('never mutates the input array', () => {
    const input = ['A']
    toggleRoleName(input, 'B', true)
    toggleRoleName(input, 'A', false)
    expect(input).toEqual(['A'])
  })
})

describe('rolePickerOptions', () => {
  it('returns the server roles when the group confers nothing extra', () => {
    expect(rolePickerOptions(['A', 'B'], ['A'])).toEqual(['A', 'B'])
  })

  it('appends conferred roles missing from the server list', () => {
    expect(rolePickerOptions(['A'], ['B', 'A'])).toEqual(['A', 'B'])
  })

  it('still offers conferred roles when the server list is empty (roles endpoint failed)', () => {
    expect(rolePickerOptions([], ['X', 'Y'])).toEqual(['X', 'Y'])
  })

  it('deduplicates both inputs', () => {
    expect(rolePickerOptions(['A', 'A', 'B'], ['B', 'B', 'C'])).toEqual(['A', 'B', 'C'])
  })
})
