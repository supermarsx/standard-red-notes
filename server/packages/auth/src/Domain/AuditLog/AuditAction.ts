/**
 * Standard Red Notes: canonical audit-log action names. Stable identifiers
 * written to the `action` column and surfaced by the admin query endpoint.
 */
export const AuditAction = {
  LoginSuccess: 'login.success',
  LoginFailure: 'login.failure',
  Logout: 'logout',
  SessionRevoked: 'session.revoked',
  RoleChanged: 'role.changed',
  BanChanged: 'ban.changed',
  SettingChanged: 'setting.changed',
  WebhookCreated: 'webhook.created',
  WebhookDeleted: 'webhook.deleted',
} as const

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction]
