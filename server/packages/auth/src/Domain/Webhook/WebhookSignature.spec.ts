import * as crypto from 'crypto'

import { computeWebhookSignature, verifyWebhookSignature } from './WebhookSignature'

describe('WebhookSignature', () => {
  const secret = 'super-secret-shared-key'
  const body = JSON.stringify({ event: 'item.created', userUuid: 'u-1' })

  describe('computeWebhookSignature', () => {
    it('should return the lowercase hex HMAC-SHA256 digest prefixed with sha256=', () => {
      const expectedDigest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

      expect(computeWebhookSignature(secret, body)).toEqual(`sha256=${expectedDigest}`)
    })

    it('should be deterministic for the same secret and body', () => {
      expect(computeWebhookSignature(secret, body)).toEqual(computeWebhookSignature(secret, body))
    })

    it('should differ when the secret differs', () => {
      expect(computeWebhookSignature(secret, body)).not.toEqual(computeWebhookSignature('other-secret', body))
    })

    it('should differ when the body differs', () => {
      expect(computeWebhookSignature(secret, body)).not.toEqual(computeWebhookSignature(secret, `${body} `))
    })
  })

  describe('verifyWebhookSignature', () => {
    it('should verify a signature it produced for the same secret and body', () => {
      const signature = computeWebhookSignature(secret, body)

      expect(verifyWebhookSignature(secret, body, signature)).toBe(true)
    })

    it('should reject a tampered body', () => {
      const signature = computeWebhookSignature(secret, body)

      expect(verifyWebhookSignature(secret, `${body}tampered`, signature)).toBe(false)
    })

    it('should reject a signature computed with a different secret', () => {
      const signature = computeWebhookSignature('attacker-secret', body)

      expect(verifyWebhookSignature(secret, body, signature)).toBe(false)
    })

    it('should reject a signature of a different length before the constant-time compare', () => {
      // A length mismatch short-circuits to false so timingSafeEqual never
      // receives buffers of unequal size (which would otherwise throw).
      expect(verifyWebhookSignature(secret, body, 'sha256=short')).toBe(false)
    })

    it('should reject an empty signature', () => {
      expect(verifyWebhookSignature(secret, body, '')).toBe(false)
    })
  })
})
