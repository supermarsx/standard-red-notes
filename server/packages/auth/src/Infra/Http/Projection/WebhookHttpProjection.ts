export interface WebhookHttpProjection {
  uuid: string
  // null => global/admin webhook.
  userUuid: string | null
  targetUrl: string
  events: string[]
  enabled: boolean
  createdAt: string
}
