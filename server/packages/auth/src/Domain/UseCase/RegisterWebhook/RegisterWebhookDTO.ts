export interface RegisterWebhookDTO {
  // The requesting user. For a global webhook this is the admin's uuid (used
  // only for auditing); `global: true` stores a null user_uuid.
  userUuid: string
  targetUrl: string
  events: string[]
  // When true, registers a global/admin webhook (null user_uuid) that fires for
  // events across all users. Requires the caller to be an admin (enforced in the
  // controller via the INTERNAL_TEAM_USER role check).
  global?: boolean
}
