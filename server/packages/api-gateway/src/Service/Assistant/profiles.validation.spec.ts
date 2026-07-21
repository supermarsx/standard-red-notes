import {
  ASSIGNABLE_ROLE_NAMES,
  BACKEND_API_KEY_PROVIDERS,
  PersistedAiProfile,
  PersistedBackendProfile,
  validateAssignmentsPatch,
  validateBackendProfilesPatch,
  validateProfilesPatch,
} from './profiles'

/**
 * Standard Red Notes: these validators are the gate on the admin PUT
 * server-settings body, so they are the last check before operator-supplied
 * values reach persistence and, later, outbound AI requests. The rejection paths
 * matter as much as the happy path — especially the API-key handling, where an
 * omitted key must PRESERVE the stored secret (the write-only UI never resends
 * it) while an explicit null must clear it.
 */

const ok = <T>(result: T | { error: string }): T => {
  expect(result).not.toHaveProperty('error')

  return result as T
}

const errorOf = (result: unknown): string => {
  expect(result).toHaveProperty('error')

  return (result as { error: string }).error
}

describe('validateProfilesPatch', () => {
  const validProfile = (overrides: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'Profile One',
    provider: 'anthropic',
    ...overrides,
  })

  describe('patch semantics', () => {
    it('leaves profiles untouched when the key is absent', () => {
      const result = ok(validateProfilesPatch(undefined, undefined, []))

      expect(result).toEqual({})
    })

    it('clears the persisted profiles when explicitly null', () => {
      const result = ok(validateProfilesPatch(null, undefined, []))

      expect(result.profiles).toBeNull()
    })

    it('clears the default profile id when explicitly null', () => {
      const result = ok(validateProfilesPatch(undefined, null, []))

      expect(result.defaultProfileId).toBeNull()
    })
  })

  describe('shape rejection', () => {
    it('rejects a non-array profiles value', () => {
      expect(errorOf(validateProfilesPatch({ not: 'an array' }, undefined, []))).toContain('must be an array')
    })

    it('rejects more than 50 profiles', () => {
      const many = Array.from({ length: 51 }, (_unused, index) => validProfile({ id: `p${index}` }))

      expect(errorOf(validateProfilesPatch(many, undefined, []))).toContain('more than 50')
    })

    it('accepts exactly 50 profiles', () => {
      const many = Array.from({ length: 50 }, (_unused, index) => validProfile({ id: `p${index}` }))

      expect(ok(validateProfilesPatch(many, undefined, [])).profiles).toHaveLength(50)
    })

    it.each([[null], ['a string'], [42], [[]]])('rejects %p as a profile entry', (entry) => {
      expect(errorOf(validateProfilesPatch([entry], undefined, []))).toContain('must be an object')
    })

    it('rejects a profile with no id', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ id: '  ' })], undefined, []))).toContain('id')
    })

    it('rejects duplicate profile ids', () => {
      expect(errorOf(validateProfilesPatch([validProfile(), validProfile()], undefined, []))).toContain('Duplicate')
    })

    it('rejects a profile with no name', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ name: '   ' })], undefined, []))).toContain('name')
    })

    it('rejects an over-long name', () => {
      const result = validateProfilesPatch([validProfile({ name: 'x'.repeat(121) })], undefined, [])

      expect(errorOf(result)).toContain('too long')
    })

    it('accepts a name of exactly the maximum length', () => {
      expect(ok(validateProfilesPatch([validProfile({ name: 'x'.repeat(120) })], undefined, [])).profiles).toHaveLength(
        1,
      )
    })

    it('rejects an unknown provider kind', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ provider: 'skynet' })], undefined, []))).toContain(
        'provider',
      )
    })

    it('rejects a non-string model', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ model: 42 })], undefined, []))).toContain('model')
    })

    it('rejects a models array containing a non-string', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ models: ['a', 7] })], undefined, []))).toContain('models')
    })

    it('rejects a models value that is not an array', () => {
      expect(errorOf(validateProfilesPatch([validProfile({ models: 'a,b' })], undefined, []))).toContain('models')
    })
  })

  describe('base URL', () => {
    it.each([['ftp://host/x'], ['file:///etc/passwd'], ['javascript:alert(1)'], ['not a url']])(
      'rejects %s as a base URL',
      (baseUrl) => {
        expect(errorOf(validateProfilesPatch([validProfile({ baseUrl })], undefined, []))).toContain('http(s)')
      },
    )

    it.each([['http://host/v1'], ['https://host/v1']])('accepts %s and trims it', (baseUrl) => {
      const result = ok(validateProfilesPatch([validProfile({ baseUrl: `  ${baseUrl}  ` })], undefined, []))

      expect(result.profiles?.[0].baseUrl).toBe(baseUrl)
    })

    it('treats an empty base URL as absent rather than invalid', () => {
      const result = ok(validateProfilesPatch([validProfile({ baseUrl: '' })], undefined, []))

      expect(result.profiles?.[0].baseUrl).toBeUndefined()
    })
  })

  describe('API key handling', () => {
    const existing: PersistedAiProfile[] = [
      { id: 'p1', name: 'Profile One', provider: 'anthropic', apiKey: 'stored-secret' },
    ]

    it('PRESERVES the stored key when the patch omits apiKey', () => {
      const result = ok(validateProfilesPatch([validProfile()], undefined, existing))

      expect(result.profiles?.[0].apiKey).toBe('stored-secret')
    })

    it('CLEARS the stored key when the patch sends null', () => {
      const result = ok(validateProfilesPatch([validProfile({ apiKey: null })], undefined, existing))

      expect(result.profiles?.[0].apiKey).toBeUndefined()
    })

    it('CLEARS the stored key when the patch sends an empty string', () => {
      const result = ok(validateProfilesPatch([validProfile({ apiKey: '' })], undefined, existing))

      expect(result.profiles?.[0].apiKey).toBeUndefined()
    })

    it('replaces the stored key with a new one, trimmed', () => {
      const result = ok(validateProfilesPatch([validProfile({ apiKey: '  new-secret  ' })], undefined, existing))

      expect(result.profiles?.[0].apiKey).toBe('new-secret')
    })

    it('does NOT inherit a key from a profile with a different id', () => {
      const result = ok(validateProfilesPatch([validProfile({ id: 'other' })], undefined, existing))

      expect(result.profiles?.[0].apiKey).toBeUndefined()
    })

    it('leaves the key unset when there is no stored profile to inherit from', () => {
      const result = ok(validateProfilesPatch([validProfile()], undefined, []))

      expect(result.profiles?.[0].apiKey).toBeUndefined()
    })
  })
})

describe('validateBackendProfilesPatch', () => {
  const apiKeyBackend = (overrides: Record<string, unknown> = {}) => ({
    id: 'b1',
    name: 'Backend One',
    type: 'api-key',
    provider: 'anthropic',
    ...overrides,
  })

  it('leaves backends untouched when the key is absent, and clears them on null', () => {
    expect(ok(validateBackendProfilesPatch(undefined, []))).toEqual({})
    expect(ok(validateBackendProfilesPatch(null, [])).backendProfiles).toBeNull()
  })

  it('rejects a non-array value and an over-long list', () => {
    expect(errorOf(validateBackendProfilesPatch({}, []))).toContain('must be an array')

    const many = Array.from({ length: 51 }, (_unused, index) => apiKeyBackend({ id: `b${index}` }))
    expect(errorOf(validateBackendProfilesPatch(many, []))).toContain('more than 50')
  })

  it.each([[null], ['string'], [7], [[]]])('rejects %p as a backend entry', (entry) => {
    expect(errorOf(validateBackendProfilesPatch([entry], []))).toContain('must be an object')
  })

  it('requires a non-empty id and rejects duplicates', () => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ id: ' ' })], []))).toContain('id')
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend(), apiKeyBackend()], []))).toContain('Duplicate')
  })

  it('requires a non-empty name within the length limit', () => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ name: '' })], []))).toContain('name')
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ name: 'x'.repeat(121) })], []))).toContain('too long')
  })

  it.each([['unknown'], [undefined], [null], [42]])('rejects %p as a backend type', (type) => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ type })], []))).toContain('type must be')
  })

  it.each(BACKEND_API_KEY_PROVIDERS)('accepts %s as an api-key provider', (provider) => {
    const result = ok(validateBackendProfilesPatch([apiKeyBackend({ provider })], []))

    expect(result.backendProfiles?.[0].provider).toBe(provider)
  })

  it('rejects an api-key backend with an unknown or missing provider', () => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ provider: 'skynet' })], []))).toContain(
      'invalid provider',
    )
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ provider: undefined })], []))).toContain(
      'invalid provider',
    )
  })

  it('rejects a non-http(s) base URL and accepts an http(s) one', () => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ baseUrl: 'ftp://h/x' })], []))).toContain('http(s)')

    const result = ok(validateBackendProfilesPatch([apiKeyBackend({ baseUrl: ' https://h/v1 ' })], []))
    expect(result.backendProfiles?.[0].baseUrl).toBe('https://h/v1')
  })

  it('rejects a non-string model and a malformed models array', () => {
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ model: 1 })], []))).toContain('model')
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ models: [1] })], []))).toContain('models')
    expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ models: 'a' })], []))).toContain('models')
  })

  it('drops blank entries from the models array and omits it when nothing remains', () => {
    const kept = ok(validateBackendProfilesPatch([apiKeyBackend({ models: [' a ', '', '  '] })], []))
    expect(kept.backendProfiles?.[0].models).toEqual(['a'])

    const dropped = ok(validateBackendProfilesPatch([apiKeyBackend({ models: ['', '  '] })], []))
    expect(dropped.backendProfiles?.[0].models).toBeUndefined()
  })

  describe('api key handling', () => {
    const existing: PersistedBackendProfile[] = [
      { id: 'b1', name: 'Backend One', type: 'api-key', provider: 'anthropic', apiKey: 'stored-secret' },
    ]

    it('PRESERVES the stored key when the patch omits apiKey', () => {
      const result = ok(validateBackendProfilesPatch([apiKeyBackend()], existing))

      expect(result.backendProfiles?.[0].apiKey).toBe('stored-secret')
    })

    it('CLEARS the stored key on null or an empty string', () => {
      expect(
        ok(validateBackendProfilesPatch([apiKeyBackend({ apiKey: null })], existing)).backendProfiles?.[0].apiKey,
      ).toBeUndefined()
      expect(
        ok(validateBackendProfilesPatch([apiKeyBackend({ apiKey: '' })], existing)).backendProfiles?.[0].apiKey,
      ).toBeUndefined()
    })

    it('replaces the stored key with a trimmed new value', () => {
      const result = ok(validateBackendProfilesPatch([apiKeyBackend({ apiKey: '  fresh  ' })], existing))

      expect(result.backendProfiles?.[0].apiKey).toBe('fresh')
    })

    it('treats a whitespace-only key as cleared rather than storing blank', () => {
      const result = ok(validateBackendProfilesPatch([apiKeyBackend({ apiKey: '   ' })], existing))

      expect(result.backendProfiles?.[0].apiKey).toBeUndefined()
    })

    it('rejects a non-string, non-null apiKey', () => {
      expect(errorOf(validateBackendProfilesPatch([apiKeyBackend({ apiKey: 42 })], []))).toContain('apiKey')
    })

    it('does NOT inherit a key from a backend with a different id', () => {
      const result = ok(validateBackendProfilesPatch([apiKeyBackend({ id: 'other' })], existing))

      expect(result.backendProfiles?.[0].apiKey).toBeUndefined()
    })
  })

  describe('subscription backends', () => {
    const subscriptionBackend = (overrides: Record<string, unknown> = {}) => ({
      id: 's1',
      name: 'Sub One',
      type: 'subscription',
      subscriptionId: 'default',
      ...overrides,
    })

    it('requires a subscriptionId', () => {
      expect(errorOf(validateBackendProfilesPatch([subscriptionBackend({ subscriptionId: ' ' })], []))).toContain(
        'subscriptionId',
      )
      expect(errorOf(validateBackendProfilesPatch([subscriptionBackend({ subscriptionId: undefined })], []))).toContain(
        'subscriptionId',
      )
    })

    it('stores the trimmed subscriptionId and no provider', () => {
      const result = ok(validateBackendProfilesPatch([subscriptionBackend({ subscriptionId: ' team ' })], []))

      expect(result.backendProfiles?.[0].subscriptionId).toBe('team')
      expect(result.backendProfiles?.[0].provider).toBeUndefined()
    })

    it('does not require a provider for a subscription backend', () => {
      const result = ok(validateBackendProfilesPatch([subscriptionBackend()], []))

      expect(result.backendProfiles?.[0].type).toBe('subscription')
    })
  })
})

describe('validateAssignmentsPatch', () => {
  it('leaves assignments untouched when absent, and clears them on null', () => {
    expect(ok(validateAssignmentsPatch(undefined))).toEqual({})
    expect(ok(validateAssignmentsPatch(null)).assignments).toBeNull()
  })

  it.each([['a string'], [42], [[]]])('rejects %p as the assignments object', (value) => {
    expect(errorOf(validateAssignmentsPatch(value))).toContain('must be an object')
  })

  it('normalizes an empty object to empty user and role maps', () => {
    expect(ok(validateAssignmentsPatch({})).assignments).toEqual({ users: {}, roles: {} })
  })

  it('lowercases user identifiers and trims the profile ids', () => {
    const result = ok(validateAssignmentsPatch({ users: { '  User@Example.COM ': '  p1  ' } }))

    expect(result.assignments?.users).toEqual({ 'user@example.com': 'p1' })
  })

  it('rejects a users value that is not an object', () => {
    expect(errorOf(validateAssignmentsPatch({ users: 'p1' }))).toContain('users must be an object')
    expect(errorOf(validateAssignmentsPatch({ users: [] }))).toContain('users must be an object')
  })

  it('rejects an empty user identifier key', () => {
    expect(errorOf(validateAssignmentsPatch({ users: { '   ': 'p1' } }))).toContain('empty identifier')
  })

  it.each([[''], ['   '], [42], [null]])('rejects %p as a user profile id', (value) => {
    expect(errorOf(validateAssignmentsPatch({ users: { 'a@b.c': value } }))).toContain('non-empty profile id')
  })

  it.each(ASSIGNABLE_ROLE_NAMES)('accepts %s as a role key', (roleName) => {
    const result = ok(validateAssignmentsPatch({ roles: { [roleName]: 'p1' } }))

    expect(result.assignments?.roles).toEqual({ [roleName]: 'p1' })
  })

  it('rejects an unknown role name rather than silently storing it', () => {
    const error = errorOf(validateAssignmentsPatch({ roles: { SUPER_ADMIN: 'p1' } }))

    expect(error).toContain('SUPER_ADMIN')
    expect(error).toContain('ADMIN_USER')
  })

  it('rejects a roles value that is not an object', () => {
    expect(errorOf(validateAssignmentsPatch({ roles: 'p1' }))).toContain('roles must be an object')
    expect(errorOf(validateAssignmentsPatch({ roles: [] }))).toContain('roles must be an object')
  })

  it.each([[''], ['  '], [7], [null]])('rejects %p as a role profile id', (value) => {
    expect(errorOf(validateAssignmentsPatch({ roles: { CORE_USER: value } }))).toContain('non-empty profile id')
  })

  it('treats null users and roles as absent rather than invalid', () => {
    const result = ok(validateAssignmentsPatch({ users: null, roles: null }))

    expect(result.assignments).toEqual({ users: {}, roles: {} })
  })
})
