/**
 * Standard Red Notes: canonical set of outbound-webhook event names. These are
 * the stable, public identifiers a webhook subscribes to (the `events[]` column
 * and the `event` field of the dispatched JSON payload). They are intentionally
 * decoupled from the internal `@standardnotes/domain-events` TYPE strings so the
 * public contract (consumed by n8n / Zapier / Typeform) does not leak internal
 * event-bus naming and stays stable across refactors.
 */
export const WebhookEvent = {
  ItemCreated: 'item.created',
  ItemUpdated: 'item.updated',
  ItemDeleted: 'item.deleted',
  UserLogin: 'user.login',
  SessionRevoked: 'session.revoked',
  AdminAction: 'admin.action',
} as const

export type WebhookEventName = (typeof WebhookEvent)[keyof typeof WebhookEvent]

export const ALL_WEBHOOK_EVENTS: string[] = Object.values(WebhookEvent)

export function isValidWebhookEvent(event: string): boolean {
  return ALL_WEBHOOK_EVENTS.includes(event)
}
