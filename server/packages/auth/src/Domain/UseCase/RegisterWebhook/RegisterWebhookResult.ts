export interface RegisterWebhookResult {
  uuid: string
  userUuid: string | null
  targetUrl: string
  events: string[]
  enabled: boolean
  createdAt: Date
  // Plaintext HMAC secret. Returned exactly once on creation; never retrievable
  // again. The subscriber stores it to verify the X-SRN-Signature header.
  secret: string
}
