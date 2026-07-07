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
  // Standard Red Notes: admin panel "reset 2FA" (clears the user's MFA secret
  // and recovery codes) and "fix quota" (recalculates FILE_UPLOAD_BYTES_USED).
  MfaReset: 'mfa.reset',
  QuotaRecalculated: 'quota.recalculated',
  WebhookCreated: 'webhook.created',
  WebhookDeleted: 'webhook.deleted',
  // Standard Red Notes: admin anti-abuse "unlock account" — clears a user's
  // failed-login lock counter(s) so they can sign in again.
  AccountUnlocked: 'account.unlocked',
} as const

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction]
