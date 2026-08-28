import {
  assertSyncCommandDigest,
  assertSyncCommandDigestValue,
  canonicalJson,
  computeSyncCommandDigest,
  syncCommandDigestsEqual,
  validateSyncCommandMetadata,
} from './SyncCommandTypes'

describe('sync command canonical digest contract', () => {
  it('matches the current HTTP/WebSocket wire-normalized fixture including api, Date conversion, and omission', () => {
    const sourceBody = {
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: new Date('2026-08-18T12:34:56.789Z'),
          updated_at_timestamp: 1_787_056_496_789,
          auth_hash: undefined,
        },
      ],
      sync_token: 'token',
      cursor_token: undefined,
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    }
    const wireBody = JSON.parse(JSON.stringify(sourceBody)) as Record<string, unknown>

    expect(canonicalJson(wireBody)).toBe(
      '{"api":"20240226","items":[{"content":"ciphertext","content_type":"Note","created_at":"2026-08-18T12:34:56.789Z","deleted":false,"updated_at_timestamp":1787056496789,"uuid":"note-1"}],"limit":150,"shared_vault_uuids":["vault-1"],"sync_token":"token"}',
    )
    expect(computeSyncCommandDigest(wireBody)).toBe('ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61')
  })

  it('preserves the original 20200115 protocol vector for older compatible clients', () => {
    const logicalBody = {
      api: '20200115',
      items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
      sync_token: 'token',
    }

    expect(canonicalJson(logicalBody)).toBe(
      '{"api":"20200115","items":[{"content":"ciphertext","content_type":"Note","deleted":false,"uuid":"note-1"}],"sync_token":"token"}',
    )
    expect(computeSyncCommandDigest(logicalBody)).toBe(
      'e4c8512aab76dd9aca235be947afc7829b5ea652db89f93f672f69648a5e885e',
    )
  })

  it('sorts object keys recursively while preserving array order and JSON null slots', () => {
    expect(canonicalJson({ z: undefined, b: [{ y: 2, x: 1 }, undefined], a: null })).toBe(
      '{"a":null,"b":[{"x":1,"y":2},null]}',
    )
  })
})

/**
 * The digest is what makes a sync command safely replayable: the same id may be
 * retried freely, but only for the same request. These cover the refusals that
 * enforce that, since accepting a mismatched or malformed one would let a retry
 * apply different work under an id the client believes it already knows.
 */
describe('sync command metadata validation', () => {
  const digest = computeSyncCommandDigest({ items: [] })
  const valid = { id: 'command-1', digest }

  it('accepts an opaque URL-safe id with a hexadecimal digest', () => {
    expect(() => validateSyncCommandMetadata(valid)).not.toThrow()
  })

  it.each([
    ['an empty id', ''],
    ['an id that does not start alphanumerically', '-leading-dash'],
    ['an id containing a path separator', 'command/1'],
    ['an id containing a space', 'command 1'],
    ['an id longer than the byte cap', 'a'.repeat(129)],
    ['an id whose multi-byte characters exceed the byte cap', 'é'.repeat(65)],
  ])('refuses %s', (_label, id) => {
    expect(() => validateSyncCommandMetadata({ id, digest })).toThrow(
      expect.objectContaining({ code: 'invalid_sync_command_id', httpStatus: 400 }),
    )
  })

  it('accepts an id of exactly the byte cap', () => {
    expect(() => validateSyncCommandMetadata({ id: 'a'.repeat(128), digest })).not.toThrow()
  })

  it.each([
    ['a non-hexadecimal digest', 'z'.repeat(64)],
    ['a truncated digest', digest.slice(0, 63)],
    ['an over-long digest', `${digest}0`],
    ['an empty digest', ''],
  ])('refuses %s', (_label, badDigest) => {
    expect(() => validateSyncCommandMetadata({ id: 'command-1', digest: badDigest })).toThrow(
      expect.objectContaining({ code: 'invalid_sync_command_digest', httpStatus: 400 }),
    )
  })
})

describe('sync command digest assertion', () => {
  const payload = { items: [{ uuid: 'note-1' }] }
  const digest = computeSyncCommandDigest(payload)

  it('accepts a command whose digest matches the payload the server canonicalised', () => {
    expect(() => assertSyncCommandDigest({ id: 'command-1', digest }, payload)).not.toThrow()
  })

  it('accepts a digest presented in a different case', () => {
    // Hex case carries no meaning, so a client upper-casing it is still the same command.
    expect(() => assertSyncCommandDigest({ id: 'command-1', digest: digest.toUpperCase() }, payload)).not.toThrow()
  })

  it('refuses the same command id presented with a different payload', () => {
    const other = computeSyncCommandDigest({ items: [{ uuid: 'note-2' }] })

    // 409 rather than 400: the request is well-formed, it just conflicts with
    // what this id already stands for. Replaying it would apply different work.
    expect(() => assertSyncCommandDigest({ id: 'command-1', digest: other }, payload)).toThrow(
      expect.objectContaining({ code: 'sync_command_digest_mismatch', httpStatus: 409 }),
    )
  })

  it('refuses a server-side digest that is not a hexadecimal SHA-256', () => {
    // Guards the trusted side of the comparison, not just the client's.
    expect(() => assertSyncCommandDigestValue({ id: 'command-1', digest }, 'not-a-digest')).toThrow(
      expect.objectContaining({ code: 'invalid_sync_command_digest' }),
    )
  })

  it('validates the metadata before comparing anything', () => {
    expect(() => assertSyncCommandDigestValue({ id: '', digest }, digest)).toThrow(
      expect.objectContaining({ code: 'invalid_sync_command_id' }),
    )
  })
})

describe('syncCommandDigestsEqual', () => {
  const digest = computeSyncCommandDigest({ items: [] })

  it('matches identical digests regardless of case', () => {
    expect(syncCommandDigestsEqual(digest, digest.toUpperCase())).toBe(true)
  })

  it('refuses digests of differing length without throwing', () => {
    // The comparison pads to a fixed length so a length difference cannot be
    // read off the timing, but it must still come out false.
    expect(syncCommandDigestsEqual(digest, digest.slice(0, 32))).toBe(false)
    expect(syncCommandDigestsEqual(digest.slice(0, 32), digest)).toBe(false)
  })

  it('refuses digests that differ in a single character', () => {
    const flipped = `${digest.slice(0, 63)}${digest[63] === 'a' ? 'b' : 'a'}`

    expect(syncCommandDigestsEqual(digest, flipped)).toBe(false)
  })
})
