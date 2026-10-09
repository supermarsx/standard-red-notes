import {
  decodeSyncTokenExtension,
  decodeSyncTokenPosition,
  encodeSyncToken,
  scopeDigestFor,
  SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS,
  SYNC_TOKEN_VERSION,
} from './SyncToken'

const decoded = (token: string): string => Buffer.from(token, 'base64').toString('utf-8')

const SESSION = '00000000-0000-0000-0000-0000000000a1'

describe('SyncToken', () => {
  describe('encodeSyncToken', () => {
    it('encodes a bare position exactly as the original one-field v2 token did', () => {
      expect(decoded(encodeSyncToken({ positionMicroseconds: 1_616_164_633_241_312 }))).toEqual('2:1616164633.241312')
    })

    it('keeps the position in the FIRST field so an older reader still reads it', () => {
      const token = encodeSyncToken({
        positionMicroseconds: 1_616_164_633_241_312,
        ownWriteSessionUuid: SESSION,
        ownWriteCeilingMicroseconds: 1_616_164_633_999_999,
        scopeDigest: '0123456789abcdef',
      })

      // This is the compatibility contract: a reader that only knows `2:<seconds>`
      // shifts the version off and takes parts[0]. It must see the position and
      // nothing else, so an older syncing-server handed this token re-delivers
      // rather than rejecting it or mis-reading the position.
      const parts = decoded(token).split(':')
      expect(parts.shift()).toEqual(`${SYNC_TOKEN_VERSION}`)
      expect(Math.round(Number(parts[0]) * 1_000_000)).toEqual(1_616_164_633_241_312)
      expect(parts.slice(1)).toEqual([`s=${SESSION}`, 'w=1616164633999999', 'v=0123456789abcdef'])
    })

    it('omits the own-write fields unless both are given', () => {
      expect(decoded(encodeSyncToken({ positionMicroseconds: 1_000_000, ownWriteSessionUuid: SESSION }))).toEqual('2:1')
      expect(
        decoded(encodeSyncToken({ positionMicroseconds: 1_000_000, ownWriteCeilingMicroseconds: 2_000_000 })),
      ).toEqual('2:1')
    })

    it('round trips through the decoders', () => {
      const token = encodeSyncToken({
        positionMicroseconds: 5_000_000,
        ownWriteSessionUuid: SESSION,
        ownWriteCeilingMicroseconds: 6_000_000,
        scopeDigest: 'abcdef0123456789',
      })

      expect(decodeSyncTokenPosition(token)).toEqual(5_000_000)
      expect(decodeSyncTokenExtension(decoded(token).split(':').slice(2))).toEqual({
        ownWriteSessionUuid: SESSION,
        ownWriteCeilingMicroseconds: 6_000_000,
        scopeDigest: 'abcdef0123456789',
      })
    })
  })

  describe('decodeSyncTokenPosition', () => {
    it('reads a v2 position', () => {
      expect(decodeSyncTokenPosition(Buffer.from('2:1.000002', 'utf-8').toString('base64'))).toEqual(1_000_002)
    })

    it('refuses a token that is not v2', () => {
      expect(decodeSyncTokenPosition(Buffer.from('3:123:abc', 'utf-8').toString('base64'))).toBeUndefined()
      expect(decodeSyncTokenPosition('qwerty')).toBeUndefined()
    })

    it('refuses a v2 token whose position is not a usable number', () => {
      expect(decodeSyncTokenPosition(Buffer.from('2:not-a-number', 'utf-8').toString('base64'))).toBeUndefined()
      expect(decodeSyncTokenPosition(Buffer.from('2:-5', 'utf-8').toString('base64'))).toBeUndefined()
      expect(decodeSyncTokenPosition(Buffer.from('2:1e308', 'utf-8').toString('base64'))).toBeUndefined()
    })
  })

  describe('decodeSyncTokenExtension', () => {
    it('reads the three fields in any order', () => {
      expect(decodeSyncTokenExtension(['v=0123456789abcdef', 'w=42', `s=${SESSION}`])).toEqual({
        ownWriteSessionUuid: SESSION,
        ownWriteCeilingMicroseconds: 42,
        scopeDigest: '0123456789abcdef',
      })
    })

    it('drops a field it cannot trust rather than rejecting the token', () => {
      // Every field here can only ever make the server deliver LESS, so losing
      // one degrades to re-delivery. That is the safe direction, and it is why
      // these are dropped instead of failing the sync.
      expect(decodeSyncTokenExtension(['s=not-a-session', 'w=42'])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension([`s=${SESSION}`, 'w=12.5'])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension([`s=${SESSION}`, 'w=-1'])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension([`s=${SESSION}`])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension(['w=42'])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension(['v=NOTHEX'])).toEqual({ scopeDigest: undefined })
      expect(decodeSyncTokenExtension(['unknown=1', 'noequals', '=leading'])).toEqual({ scopeDigest: undefined })
    })

    it('keeps a scope digest even when the own-write fields are unusable', () => {
      expect(decodeSyncTokenExtension(['s=nope', 'v=0123456789abcdef'])).toEqual({
        scopeDigest: '0123456789abcdef',
      })
    })

    it('reads nothing out of an empty extension', () => {
      expect(decodeSyncTokenExtension([])).toEqual({ scopeDigest: undefined })
    })
  })

  describe('scopeDigestFor', () => {
    it('leaves an unrestricted retrieval undigested so an ordinary token is unchanged', () => {
      expect(scopeDigestFor(undefined)).toBeUndefined()
      expect(scopeDigestFor([])).toBeUndefined()
    })

    it('digests a vault-exclusive scope independently of the order it is given in', () => {
      const first = scopeDigestFor(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'])
      const reversed = scopeDigestFor(['22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'])

      expect(first).toMatch(/^[0-9a-f]{16}$/)
      expect(reversed).toEqual(first)
    })

    it('gives different scopes different digests', () => {
      const one = scopeDigestFor(['11111111-1111-1111-1111-111111111111'])
      const two = scopeDigestFor(['22222222-2222-2222-2222-222222222222'])
      const both = scopeDigestFor(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'])

      expect(new Set([one, two, both]).size).toEqual(3)
    })
  })

  it('allows only a skew-sized window ahead of the clock, not a meaningful one', () => {
    // A legitimate position is at most the `+1µs` double-prevention ahead of the
    // clock. The allowance exists for replica skew only; it must stay far below
    // anything a client could mistake for real data.
    expect(SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS).toEqual(300_000_000)
    expect(SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS).toBeLessThan(24 * 3600 * 1_000_000)
  })
})
