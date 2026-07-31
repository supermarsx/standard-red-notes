import {
  buildProfilesUpdate,
  emptyProfileRow,
  maskedProfileToRow,
  MaskedAiProfile,
  ProfileRow,
  providerLabel,
  rowToPayload,
  validateProfileRow,
  validateProfileRows,
} from './aiProfiles'

const baseRow = (overrides: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 'p1',
  name: 'Work Claude',
  provider: 'anthropic',
  baseUrl: '',
  model: 'claude-3-5-sonnet-latest',
  models: [],
  enabled: true,
  keyConfigured: false,
  legacyInlineCredentialIgnored: false,
  newKey: '',
  clearKey: false,
  backendProfileId: '',
  ...overrides,
})

describe('aiProfiles helpers', () => {
  describe('maskedProfileToRow', () => {
    it('converts a masked server profile into an editable row with blank key inputs', () => {
      const masked: MaskedAiProfile = {
        id: 'p2',
        name: 'Router',
        provider: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'gpt-4o',
        enabled: true,
        keyConfigured: true,
        legacyInlineCredentialIgnored: false,
      }
      const row = maskedProfileToRow(masked)
      expect(row).toMatchObject({
        id: 'p2',
        baseUrl: 'https://openrouter.ai/api/v1',
        keyConfigured: true,
        newKey: '',
        clearKey: false,
      })
    })
  })

  describe('emptyProfileRow', () => {
    it('creates a unique id and defaults to an enabled openai-compatible profile', () => {
      const a = emptyProfileRow()
      const b = emptyProfileRow()
      expect(a.id).not.toEqual(b.id)
      expect(a.provider).toBe('openai-compatible')
      expect(a.enabled).toBe(true)
    })
  })

  describe('validateProfileRow', () => {
    it('requires a name', () => {
      expect(validateProfileRow(baseRow({ name: '  ' })).ok).toBe(false)
    })
    it('rejects a non-http base URL', () => {
      expect(validateProfileRow(baseRow({ provider: 'openai-compatible', baseUrl: 'ftp://x' })).ok).toBe(false)
    })
    it('rejects a base URL on anthropic (no base URL support)', () => {
      expect(validateProfileRow(baseRow({ provider: 'anthropic', baseUrl: 'https://x.example' })).ok).toBe(false)
    })
    it('accepts a valid row', () => {
      expect(validateProfileRow(baseRow()).ok).toBe(true)
    })
  })

  describe('validateProfileRows', () => {
    it('requires the default to be one of the rows', () => {
      expect(validateProfileRows([baseRow()], 'missing').ok).toBe(false)
      expect(validateProfileRows([baseRow()], 'p1').ok).toBe(true)
    })
    it('requires at least one enabled profile when any exist', () => {
      expect(validateProfileRows([baseRow({ enabled: false })], 'p1').ok).toBe(false)
    })
    it('accepts an empty set', () => {
      expect(validateProfileRows([], null).ok).toBe(true)
    })
  })

  describe('rowToPayload (write-only secret handling)', () => {
    it('omits apiKey when unchanged (preserve on the server)', () => {
      const payload = rowToPayload(baseRow({ keyConfigured: true }))
      expect('apiKey' in payload).toBe(false)
    })
    it('sends a new key when typed', () => {
      const payload = rowToPayload(baseRow({ newKey: 'sk-new' }))
      expect(payload.apiKey).toBe('sk-new')
    })
    it('sends null to clear when clearKey is set', () => {
      const payload = rowToPayload(baseRow({ keyConfigured: true, clearKey: true }))
      expect(payload.apiKey).toBeNull()
    })
    it('never serializes a subscription token into a profile payload', () => {
      const payload = rowToPayload(
        baseRow({
          provider: 'codex-subscription',
          newKey: 'LEGACY_PLAINTEXT_SUBSCRIPTION_SECRET',
          keyConfigured: true,
          clearKey: true,
          legacyInlineCredentialIgnored: true,
        }),
      )
      expect('apiKey' in payload).toBe(false)
      expect(JSON.stringify(payload)).not.toContain('LEGACY_PLAINTEXT_SUBSCRIPTION_SECRET')
    })
    it('drops a base URL for providers that do not support one', () => {
      const payload = rowToPayload(baseRow({ provider: 'anthropic', baseUrl: '' }))
      expect(payload.baseUrl).toBeUndefined()
    })
  })

  describe('buildProfilesUpdate', () => {
    it('keeps a valid default and falls back to the first enabled when the default is gone', () => {
      const rows = [baseRow({ id: 'a', enabled: false }), baseRow({ id: 'b', enabled: true })]
      expect(buildProfilesUpdate(rows, 'b').defaultProfileId).toBe('b')
      expect(buildProfilesUpdate(rows, 'gone').defaultProfileId).toBe('b')
    })
    it('serializes every row into a payload', () => {
      const update = buildProfilesUpdate([baseRow({ id: 'a' }), baseRow({ id: 'b' })], 'a')
      expect(update.profiles.map((p) => p.id)).toEqual(['a', 'b'])
    })
  })

  describe('providerLabel', () => {
    it('returns human labels and a safe fallback', () => {
      expect(providerLabel('anthropic')).toContain('Anthropic')
      expect(providerLabel('codex-subscription')).toContain('Codex')
    })
  })
})
