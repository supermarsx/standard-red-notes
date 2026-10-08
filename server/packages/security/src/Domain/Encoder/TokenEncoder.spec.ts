import 'reflect-metadata'

import { JwtPayload, verify } from 'jsonwebtoken'

import { TokenEncoder } from './TokenEncoder'

describe('TokenEncoder', () => {
  const jwtSecret = 'secret'

  const createEncoder = () => new TokenEncoder<{ user_uuid: string }>(jwtSecret)

  it('should encode a token', () => {
    const encodedToken = createEncoder().encodeToken({ user_uuid: '123' })

    expect((verify(encodedToken, jwtSecret) as JwtPayload).user_uuid).toEqual('123')
    expect((verify(encodedToken, jwtSecret) as JwtPayload).exp).toBeUndefined()
  })

  it('should encode an expirable token', () => {
    const encodedToken = createEncoder().encodeExpirableToken({ user_uuid: '123' }, 123)

    expect((verify(encodedToken, jwtSecret) as JwtPayload).user_uuid).toEqual('123')
    expect((verify(encodedToken, jwtSecret) as JwtPayload).exp).toBeGreaterThan(0)
  })

  /**
   * The single-use-credential bug, characterized at its source.
   *
   * `iat` is SECONDS, so `encodeExpirableToken` is a pure function of its claims
   * within any one second: four mints of one valet payload in 5 ms produced ONE
   * distinct string. A valet token is spent exactly once at the files service and
   * once at the multi-container adapter, so the second mint of an upload (the
   * open mints, then the first chunk mints the SAME claims) handed back a token
   * that had already been spent, and every socket upload on compose failed
   * FILE_ACCESS_DENIED on chunk 0.
   */
  describe('uniqueness of a single-use credential', () => {
    const claims = { user_uuid: '123' }

    it('mints the SAME string twice for identical claims inside one second', () => {
      const encoder = createEncoder()
      const minted = [encoder.encodeExpirableToken(claims, 1200), encoder.encodeExpirableToken(claims, 1200)]

      // Not a wish: this is why `encodeExpirableToken` must not be used for a
      // credential that is spent once.
      expect(new Set(minted).size).toBe(1)
    })

    it('mints DISTINCT strings for identical claims, however fast', () => {
      const encoder = createEncoder()
      const minted: string[] = []
      const startedAt = Date.now()
      for (let index = 0; index < 64; index++) {
        minted.push(encoder.encodeUniqueExpirableToken(claims, 1200))
      }

      // Faster than the second `iat` resolves to, and -- on any machine this runs
      // on -- faster than a millisecond per mint, so a finer clock alone would not
      // have been enough either.
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(new Set(minted).size).toBe(64)
    })

    it('carries a jti nonce and otherwise the same verifiable claims', () => {
      const encodedToken = createEncoder().encodeUniqueExpirableToken(claims, 123)
      const payload = verify(encodedToken, jwtSecret) as JwtPayload

      expect(payload.user_uuid).toEqual('123')
      expect(payload.exp).toBeGreaterThan(0)
      expect(payload.iat).toBeGreaterThan(0)
      expect(typeof payload.jti).toBe('string')
      expect(payload.jti).not.toEqual(
        (verify(createEncoder().encodeUniqueExpirableToken(claims, 123), jwtSecret) as JwtPayload).jti,
      )
    })

    it('stays verifiable by a decoder that knows nothing about jti', () => {
      // Backward compatibility in the direction that matters: every verifier of
      // these tokens reads named claims and ignores the rest, so an extra claim
      // cannot invalidate a token for an older verifier.
      const encodedToken = createEncoder().encodeUniqueExpirableToken(claims, 123)

      expect(() => verify(encodedToken, jwtSecret, { algorithms: ['HS256'] })).not.toThrow()
      expect(() => verify(encodedToken, 'other-secret')).toThrow()
    })
  })
})
