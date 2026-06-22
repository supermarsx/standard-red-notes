export interface ListWebhooksDTO {
  userUuid: string
  // When true, also include global/admin webhooks (null user_uuid) in the
  // result. The controller sets this only for admins.
  includeGlobal?: boolean
}
