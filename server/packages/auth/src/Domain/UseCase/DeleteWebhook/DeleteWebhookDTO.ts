export interface DeleteWebhookDTO {
  userUuid: string
  webhookId: string
  // Admins may delete global webhooks (null user_uuid) and any user's webhook.
  isAdmin?: boolean
}
