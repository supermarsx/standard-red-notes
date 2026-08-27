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
  // Standard Red Notes: admin panel "suspend / unsuspend user" (a reversible
  // administrative hold, separate from a ban) and "delete user" (admin-initiated
  // hard delete that reuses the cross-service account-deletion pipeline).
  SuspensionChanged: 'user.suspension_changed',
  AccountDeleted: 'user.account_deleted',
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
  // Standard Red Notes: SIGNUP INVITE LINKS — mint / soft-revoke an invite link,
  // and the admin approval-queue actions (approve / reject a pending signup).
  InviteLinkCreated: 'invite_link.created',
  InviteLinkRevoked: 'invite_link.revoked',
  UserApproved: 'user.approved',
  UserRejected: 'user.rejected',
  // Standard Red Notes: USER-INITIATED credential change (password and/or the
  // account email) through PUT /users/:uuid/attributes/credentials. The failure
  // variant is the interesting one: it means someone holding a live session
  // could not produce the current password.
  CredentialsChanged: 'credentials.changed',
  CredentialsChangeFailed: 'credentials.change_failed',
  // Standard Red Notes: a SENSITIVE setting written or deleted by its owning
  // user (the admin write path already records SettingChanged). Only the setting
  // NAME is ever recorded — never the value.
  SettingDeleted: 'setting.deleted',
  // Standard Red Notes: the user turning their own TOTP 2FA on / off, and a
  // rejected attempt to change it (the current TOTP token did not validate).
  // Distinct from the admin-initiated `mfa.reset`.
  MfaEnabled: 'mfa.enabled',
  MfaDisabled: 'mfa.disabled',
  MfaChangeFailed: 'mfa.change_failed',
  // Standard Red Notes: RBAC group lifecycle and the roles a group confers.
  // A group is an indirect grant of privilege, so changing one is a privilege
  // change even though no user row is touched.
  GroupChanged: 'group.changed',
  // Standard Red Notes: ATTRIBUTION of a group (and therefore of every role and
  // permission it confers) to a user, or its withdrawal.
  GroupMembershipChanged: 'group.membership_changed',
} as const

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction]
