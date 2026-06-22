import * as crypto from 'crypto'

/**
 * Standard Red Notes: HMAC-SHA256 signing for outbound webhooks.
 *
 * The dispatcher serializes the JSON payload, computes
 * `HMAC-SHA256(secret, body)` and sends the lowercase hex digest in the
 * `X-SRN-Signature` header, prefixed with the scheme version: `sha256=<hex>`.
 *
 * A subscriber (n8n / Zapier / a custom endpoint) verifies a delivery by
 * recomputing the same HMAC over the EXACT raw request body using the webhook's
 * shared secret and comparing in constant time. This authenticates the payload
 * and proves it was not tampered with in transit.
 */
export function computeWebhookSignature(secret: string, body: string): string {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

  return `sha256=${digest}`
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = computeWebhookSignature(secret, body)

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(signature)

  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}
