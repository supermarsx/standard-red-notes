import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { decodeCrossServiceToken, mintConnectionToken, verifyConnectionToken } from '../src/auth.js'

const AUTH_SECRET = 'dev-auth-jwt-secret-change-me'
const CONN_SECRET = 'dev-ws-conn-token-secret-change-me'

function crossServiceToken(over: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      user: { uuid: 'user-123', email: 'a@b.com' },
      roles: [{ uuid: 'r1', name: 'CORE_USER' }],
      session: { uuid: 'sess-456', readonly_access: false },
      ...over,
    },
    AUTH_SECRET,
    { algorithm: 'HS256', expiresIn: '60s' },
  )
}

describe('decodeCrossServiceToken', () => {
  it('extracts userUuid + sessionUuid from a valid cross-service token', () => {
    const id = decodeCrossServiceToken(crossServiceToken(), AUTH_SECRET)
    expect(id).toEqual({ userUuid: 'user-123', sessionUuid: 'sess-456' })
  })

  it('rejects a token signed with the wrong secret', () => {
    const bad = jwt.sign({ user: { uuid: 'u' }, session: { uuid: 's' } }, 'other-secret', {
      algorithm: 'HS256',
    })
    expect(decodeCrossServiceToken(bad, AUTH_SECRET)).toBeUndefined()
  })

  it('rejects a token with no session (unauthenticated)', () => {
    const noSession = jwt.sign({ user: { uuid: 'u' }, roles: [] }, AUTH_SECRET, { algorithm: 'HS256' })
    expect(decodeCrossServiceToken(noSession, AUTH_SECRET)).toBeUndefined()
  })

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { user: { uuid: 'u' }, session: { uuid: 's' } },
      AUTH_SECRET,
      { algorithm: 'HS256', expiresIn: -10 },
    )
    expect(decodeCrossServiceToken(expired, AUTH_SECRET)).toBeUndefined()
  })

  it('rejects garbage', () => {
    expect(decodeCrossServiceToken('not-a-jwt', AUTH_SECRET)).toBeUndefined()
  })

  it('the minted connection token round-trips through verifyConnectionToken', () => {
    const id = decodeCrossServiceToken(crossServiceToken(), AUTH_SECRET)!
    const conn = mintConnectionToken(id, CONN_SECRET, '60s')
    const verified = verifyConnectionToken(conn, CONN_SECRET)
    expect(verified.userUuid).toBe('user-123')
    expect(verified.sessionUuid).toBe('sess-456')
  })
})
