import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { verifyRoomCapability, verifyRoomCapabilityWithExpiry } from '../src/auth.js'

const SECRET = 'collab-cap-secret'
const USER = 'user-1'
const ROOM = 'note-1'

function mintCap(
  overrides: Partial<{
    purpose: string
    userUuid: string
    room: string
    collaborationProtocolVersion: number
    serverUpdatedAtTimestamp: number
    leaseRequestId: unknown
    bootstrapChallenge: unknown
  }> = {},
  opts: { secret?: string; expiresIn?: string | number; algorithm?: jwt.Algorithm } = {},
): string {
  const payload = {
    purpose: 'collab-room',
    userUuid: USER,
    room: ROOM,
    collaborationProtocolVersion: 2,
    serverUpdatedAtTimestamp: 1,
    ...overrides,
  }
  return jwt.sign(payload, opts.secret ?? SECRET, {
    algorithm: opts.algorithm ?? 'HS256',
    expiresIn: opts.expiresIn ?? 300,
  })
}

describe('verifyRoomCapability', () => {
  it('ALLOWS a valid capability for the right user + room', () => {
    expect(verifyRoomCapability(mintCap(), SECRET, USER, ROOM)).toBe(true)
  })

  it('returns exact v2 lease bindings for a valid challenge-bound capability', () => {
    const capability = mintCap({ leaseRequestId: 'lease-1', bootstrapChallenge: 'challenge-1' })

    expect(verifyRoomCapabilityWithExpiry(capability, SECRET, USER, ROOM)).toMatchObject({
      collaborationProtocolVersion: 2,
      serverUpdatedAtTimestamp: 1,
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
    ['zero revision', { serverUpdatedAtTimestamp: 0 }],
    ['fractional revision', { serverUpdatedAtTimestamp: 1.5 }],
    ['unsafe revision', { serverUpdatedAtTimestamp: Number.MAX_SAFE_INTEGER + 1 }],
    ['non-string lease id', { leaseRequestId: 1 }],
    ['empty lease id', { leaseRequestId: '' }],
    ['oversized lease id', { leaseRequestId: 'x'.repeat(129) }],
    ['non-string challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: 1 }],
    ['empty challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: '' }],
    ['oversized challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: 'x'.repeat(129) }],
    ['challenge without lease id', { bootstrapChallenge: 'challenge-1' }],
  ])('DENIES an invalid v2 capability binding: %s', (_description, overrides) => {
    expect(verifyRoomCapability(mintCap(overrides), SECRET, USER, ROOM)).toBe(false)
  })
})
