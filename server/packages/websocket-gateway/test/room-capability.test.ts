import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { verifyRoomCapability, verifyRoomCapabilityWithExpiry } from '../src/auth.js'

const SECRET = 'collab-cap-secret'
const USER = 'user-1'
const ROOM = 'note-1'
const ROOM_EPOCH = 'room_epoch_0000000000000001'
const SECURITY_EPOCH = 'security_epoch_0000000000000001'

function mintCap(
  overrides: Partial<{
    purpose: string
    userUuid: string
    room: string
    collaborationProtocolVersion: number
    collaborationAuthorizationIssuedAt: number
    serverUpdatedAtTimestamp: number
    roomEpoch: unknown
    collaborationSecurityEpoch: unknown
    leaseRequestId: unknown
    bootstrapChallenge: unknown
  }> = {},
  // expiresIn mirrors jsonwebtoken's own type: a number of seconds, or one of its
  // duration strings. Widening it to `string` would accept values sign() rejects.
  opts: { secret?: string; expiresIn?: jwt.SignOptions['expiresIn']; algorithm?: jwt.Algorithm } = {},
): string {
  const payload = {
    purpose: 'collab-room',
    userUuid: USER,
    room: ROOM,
    collaborationProtocolVersion: 3,
    collaborationAuthorizationIssuedAt: 1,
    serverUpdatedAtTimestamp: 1,
    roomEpoch: ROOM_EPOCH,
    collaborationSecurityEpoch: SECURITY_EPOCH,
    ...overrides,
  }
  // `overrides` intentionally carries `unknown` values so malformed claims can
  // be minted; jwt.sign only needs an object.
  return jwt.sign(payload as object, opts.secret ?? SECRET, {
    algorithm: opts.algorithm ?? 'HS256',
    expiresIn: opts.expiresIn ?? 300,
  })
}

describe('verifyRoomCapability', () => {
  it('ALLOWS a valid capability for the right user + room', () => {
    expect(verifyRoomCapability(mintCap(), SECRET, USER, ROOM)).toBe(true)
  })

  it('returns exact v3 epoch and lease bindings for a valid challenge-bound capability', () => {
    const capability = mintCap({ leaseRequestId: 'lease-1', bootstrapChallenge: 'challenge-1' })

    expect(verifyRoomCapabilityWithExpiry(capability, SECRET, USER, ROOM)).toMatchObject({
      collaborationProtocolVersion: 3,
      collaborationAuthorizationIssuedAt: 1,
      serverUpdatedAtTimestamp: 1,
      roomEpoch: ROOM_EPOCH,
      collaborationSecurityEpoch: SECURITY_EPOCH,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
    })
  })

  // --- enumerated DENY paths (fail-closed) ---------------------------------

  it('DENIES when the capability is undefined', () => {
    expect(verifyRoomCapability(undefined, SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES when the capability is an empty string', () => {
    expect(verifyRoomCapability('', SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES when the verifying secret is empty (cannot verify)', () => {
    expect(verifyRoomCapability(mintCap(), '', USER, ROOM)).toBe(false)
  })

  it('DENIES a garbage / non-JWT string', () => {
    expect(verifyRoomCapability('not-a-jwt', SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES a capability signed with a DIFFERENT secret (bad signature)', () => {
    expect(verifyRoomCapability(mintCap({}, { secret: 'attacker-secret' }), SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES an EXPIRED capability', () => {
    expect(verifyRoomCapability(mintCap({}, { expiresIn: -10 }), SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES a capability for a DIFFERENT user', () => {
    expect(verifyRoomCapability(mintCap({ userUuid: 'attacker' }), SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES a capability for a DIFFERENT room', () => {
    expect(verifyRoomCapability(mintCap({ room: 'other-note' }), SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES a capability with the wrong purpose', () => {
    expect(verifyRoomCapability(mintCap({ purpose: 'connection' }), SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES an HS256 verify against an "alg: none" forged token', () => {
    const forged = jwt.sign({ purpose: 'collab-room', userUuid: USER, room: ROOM }, '', { algorithm: 'none' })
    expect(verifyRoomCapability(forged, SECRET, USER, ROOM)).toBe(false)
  })

  it('DENIES when the expected user/room are empty', () => {
    const cap = mintCap()
    expect(verifyRoomCapability(cap, SECRET, '', ROOM)).toBe(false)
    expect(verifyRoomCapability(cap, SECRET, USER, '')).toBe(false)
  })

  it.each([
    ['legacy protocol', { collaborationProtocolVersion: 1 }],
    ['missing protocol', { collaborationProtocolVersion: undefined }],
    ['missing authorization issuance', { collaborationAuthorizationIssuedAt: undefined }],
    ['zero authorization issuance', { collaborationAuthorizationIssuedAt: 0 }],
    ['fractional authorization issuance', { collaborationAuthorizationIssuedAt: 1.5 }],
    ['zero revision', { serverUpdatedAtTimestamp: 0 }],
    ['fractional revision', { serverUpdatedAtTimestamp: 1.5 }],
    ['unsafe revision', { serverUpdatedAtTimestamp: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing room epoch', { roomEpoch: undefined }],
    ['invalid room epoch', { roomEpoch: 'room epoch' }],
    ['missing security epoch', { collaborationSecurityEpoch: undefined }],
    ['invalid security epoch', { collaborationSecurityEpoch: 'security epoch' }],
    ['non-string lease id', { leaseRequestId: 1 }],
    ['empty lease id', { leaseRequestId: '' }],
    ['oversized lease id', { leaseRequestId: 'x'.repeat(129) }],
    ['non-string challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: 1 }],
    ['empty challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: '' }],
    ['oversized challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: 'x'.repeat(129) }],
    ['challenge without lease id', { bootstrapChallenge: 'challenge-1' }],
  ])('DENIES an invalid v3 capability binding: %s', (_description, overrides) => {
    expect(verifyRoomCapability(mintCap(overrides), SECRET, USER, ROOM)).toBe(false)
  })

  // The epoch shape is what makes a room/security epoch unspoofable downstream:
  // `rooms.ts` compares it for equality and the Lua room-state key embeds it
  // with `:` separators. A value that escapes the character class or the length
  // bounds could forge or split that key, so the validator is enumerated here.
  describe('collaboration epoch shape is strictly enforced', () => {
    const valid = 'A'.repeat(16)

    it.each([
      ['minimum length (16)', 'A'.repeat(16)],
      ['maximum length (128)', 'A'.repeat(128)],
      ['full permitted alphabet', 'aZ09_-aZ09_-aZ09_-'],
    ])('ACCEPTS a room epoch at %s', (_description, roomEpoch) => {
      expect(verifyRoomCapability(mintCap({ roomEpoch }), SECRET, USER, ROOM)).toBe(true)
      expect(verifyRoomCapability(mintCap({ collaborationSecurityEpoch: roomEpoch }), SECRET, USER, ROOM)).toBe(true)
    })

    it.each([
      ['one below the minimum length', 'A'.repeat(15)],
      ['one above the maximum length', 'A'.repeat(129)],
      ['empty', ''],
      ['a state-key separator', `${valid}:injected`],
      ['a trailing newline', `${valid}\n`],
      ['a leading newline', `\n${valid}`],
      ['an embedded NUL', `${valid}\u0000`],
      ['whitespace padding', ` ${valid} `],
      ['a non-ASCII homoglyph', `${valid}а`],
      ['a numeric value', 1234567890123456],
      ['an object value', { toString: () => valid }],
      ['an array value', [valid]],
      ['null', null],
    ])('DENIES a room or security epoch containing %s', (_description, epoch) => {
      expect(verifyRoomCapability(mintCap({ roomEpoch: epoch }), SECRET, USER, ROOM)).toBe(false)
      expect(verifyRoomCapability(mintCap({ collaborationSecurityEpoch: epoch }), SECRET, USER, ROOM)).toBe(false)
    })
  })

  it('DENIES a capability with no expiry claim at all', () => {
    const capability = jwt.sign(
      {
        purpose: 'collab-room',
        userUuid: USER,
        room: ROOM,
        collaborationProtocolVersion: 3,
        collaborationAuthorizationIssuedAt: 1,
        serverUpdatedAtTimestamp: 1,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
      },
      SECRET,
      { algorithm: 'HS256' },
    )

    expect(verifyRoomCapabilityWithExpiry(capability, SECRET, USER, ROOM)).toBeUndefined()
  })
})
