export interface WebhookProps {
  // null = global/admin webhook (fires for events across all users); a uuid
  // scopes the webhook to a single user's own events.
  userUuid: string | null
  targetUrl: string
  // Subscribed event names, e.g. ['item.created', 'user.login']. See
  // WebhookEvent for the canonical list.
  events: string[]
  // Shared secret used to compute the HMAC-SHA256 signature sent in the
  // X-SRN-Signature header. Server-generated, returned in plaintext once.
  secret: string
  enabled: boolean
  createdAt: Date
}
