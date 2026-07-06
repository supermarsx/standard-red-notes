import {
  AdminRole,
  canonicalRoleLabel,
  canonicalRoleDescription,
  conferrableRoleNames,
  filterPermissionNames,
  groupPermissionsByCategory,
  permissionCategory,
  permissionLabel,
  permissionPickerOptions,
  permissionSetsEqual,
  togglePermissionName,
} from './adminRolesUi'

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

  describe('permissionCategory', () => {
    it('uses the prefix before the first colon', () => {
      expect(permissionCategory('server:files')).toBe('server')
      expect(permissionCategory('vault:read:write')).toBe('vault')
    })

    it('falls back to general when there is no prefix', () => {
      expect(permissionCategory('standalone')).toBe('general')
      expect(permissionCategory(':leading')).toBe('general')
    })
  })

  describe('permissionLabel', () => {
    it('drops the category and title-cases the remainder', () => {
      expect(permissionLabel('server:files_read')).toBe('Files Read')
      expect(permissionLabel('SYNC_ITEMS')).toBe('Sync Items')
    })
  })

  describe('groupPermissionsByCategory', () => {
    it('buckets by category, sorts members and orders categories', () => {
      expect(groupPermissionsByCategory(['server:b', 'auth:x', 'server:a'])).toEqual([
        { category: 'auth', permissions: ['auth:x'] },
        { category: 'server', permissions: ['server:a', 'server:b'] },
      ])
    })
  })

  describe('filterPermissionNames', () => {
    it('matches by raw name or human label, case-insensitively', () => {
      expect(filterPermissionNames(['server:files', 'auth:login'], 'files')).toEqual(['server:files'])
      expect(filterPermissionNames(['server:files_read'], 'read')).toEqual(['server:files_read'])
    })

    it('returns the input unchanged for an empty query', () => {
      expect(filterPermissionNames(['a', 'b'], '   ')).toEqual(['a', 'b'])
    })
  })

  describe('canonicalRoleLabel', () => {
    it('maps the four canonical role names to their friendly labels', () => {
      expect(canonicalRoleLabel('ADMIN_USER')).toBe('Admin user')
      expect(canonicalRoleLabel('PRO_USER')).toBe('Full user')
      expect(canonicalRoleLabel('CORE_USER')).toBe('Core user')
      expect(canonicalRoleLabel('VAULTS_USER')).toBe('Vaults user')
    })

    it('falls back to the raw name for anything else (e.g. legacy roles)', () => {
      expect(canonicalRoleLabel('PLUS_USER')).toBe('PLUS_USER')
    })
  })

  describe('canonicalRoleDescription', () => {
    it('returns a non-empty description for each of the four canonical roles', () => {
      for (const name of ['ADMIN_USER', 'PRO_USER', 'CORE_USER', 'VAULTS_USER']) {
        expect(canonicalRoleDescription(name).length).toBeGreaterThan(0)
      }
    })

    it('describes each role accurately to what it grants', () => {
      expect(canonicalRoleDescription('ADMIN_USER')).toMatch(/administrative/i)
      expect(canonicalRoleDescription('PRO_USER')).toMatch(/every end-user feature/i)
      expect(canonicalRoleDescription('CORE_USER')).toMatch(/standard account/i)
      expect(canonicalRoleDescription('VAULTS_USER')).toMatch(/collaboration/i)
    })

    it('returns an empty string for anything else (e.g. legacy/unknown roles)', () => {
      expect(canonicalRoleDescription('PLUS_USER')).toBe('')
      expect(canonicalRoleDescription('SUPPORT_AGENT')).toBe('')
    })
  })

  describe('conferrableRoleNames', () => {
    it('unions built-in names with every role name (incl. custom), sorted + deduped', () => {
      const roles = [
        { uuid: '1', name: 'SUPPORT_AGENT', version: 1, isBuiltIn: false, permissionNames: [] },
        { uuid: '2', name: 'CORE_USER', version: 1, isBuiltIn: true, permissionNames: [] },
      ] as AdminRole[]
      expect(conferrableRoleNames(['CORE_USER', 'PRO_USER'], roles)).toEqual([
        'CORE_USER',
        'PRO_USER',
        'SUPPORT_AGENT',
      ])
    })
  })
})
