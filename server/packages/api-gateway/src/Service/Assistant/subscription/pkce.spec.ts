import * as crypto from 'crypto'

import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce'

describe('pkce', () => {
  const BASE64URL = /^[A-Za-z0-9_-]+$/

  describe('generateCodeVerifier', () => {
    it('produces a base64url string within the RFC 7636 length range', () => {
      const verifier = generateCodeVerifier()
      expect(verifier).toMatch(BASE64URL)
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
    })

    it('is unique across calls', () => {
      const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()))
      expect(seen.size).toBe(50)
    })
  })

  describe('codeChallengeS256', () => {
    it('is deterministic for a given verifier', () => {
      const verifier = generateCodeVerifier()
      expect(codeChallengeS256(verifier)).toBe(codeChallengeS256(verifier))
    })

    it('equals base64url(SHA-256(verifier)) and is URL-safe', () => {
      const verifier = 'a-fixed-test-verifier'
      const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
      const challenge = codeChallengeS256(verifier)
      expect(challenge).toBe(expected)
      expect(challenge).toMatch(BASE64URL)
    })

    it('differs from the verifier (challenge is not the raw verifier)', () => {
      const verifier = generateCodeVerifier()
      expect(codeChallengeS256(verifier)).not.toBe(verifier)
    })
  })

  describe('generateState', () => {
    it('produces a unique base64url string', () => {
      const a = generateState()
      const b = generateState()
      expect(a).toMatch(BASE64URL)
      expect(a).not.toBe(b)
    })
  })
})
