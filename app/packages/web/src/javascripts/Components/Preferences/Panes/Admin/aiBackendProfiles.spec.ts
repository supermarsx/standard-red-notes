import { BackendProfileRow, backendRowToPayload, validateBackendRow } from './aiBackendProfiles'

const subscriptionRow = (subscriptionId: string): BackendProfileRow => ({
  id: 'backend-1',
  name: 'Paired subscription',
  type: 'subscription',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  subscriptionId,
  keyConfigured: false,
  newKey: '',
  clearKey: false,
})

describe('subscription backend profile identifiers', () => {
  it.each([
    '',
    ' team ',
    'team/name',
    'tëam',
    '.team',
    'team.',
    'constructor',
    'prototype',
    'toString',
    'hasOwnProperty',
    'x'.repeat(129),
  ])('rejects non-portable id %p without silently rewriting it', (subscriptionId) => {
    expect(validateBackendRow(subscriptionRow(subscriptionId)).ok).toBe(false)
  })

  it('rejects every reserved object-property name in the server contract', () => {
    for (const subscriptionId of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
      expect(validateBackendRow(subscriptionRow(subscriptionId)).ok).toBe(false)
    }
  })

  it('accepts and serializes the shared portable syntax byte-for-byte', () => {
    const subscriptionId = 'team_a.1-b'
    const row = subscriptionRow(subscriptionId)

    expect(validateBackendRow(row)).toEqual({ ok: true })
    expect(backendRowToPayload(row).subscriptionId).toBe(subscriptionId)
  })
})
