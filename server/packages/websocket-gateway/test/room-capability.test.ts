import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { verifyRoomCapability } from '../src/auth.js'

const SECRET = 'collab-cap-secret'
const USER = 'user-1'
const ROOM = 'note-1'

function mintCap(
  overrides: Partial<{ purpose: string; userUuid: string; room: string }> = {},
  opts: { secret?: string; expiresIn?: string | number; algorithm?: jwt.Algorithm } = {},
): string {
  const payload = {
    purpose: overrides.purpose ?? 'collab-room',
    userUuid: overrides.userUuid ?? USER,
    room: overrides.room ?? ROOM,
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
})
