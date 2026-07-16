import { AppPassword } from './AppPassword/AppPassword'
import { DeadManSwitch } from './DeadManSwitch/DeadManSwitch'
import { EmailReminder } from './EmailReminder/EmailReminder'
import { McpToken } from './McpToken/McpToken'
import { PendingMfaApproval } from './PendingMfaApproval/PendingMfaApproval'
import { Share } from './Share/Share'

describe('authentication domain entity validation', () => {
  const appPasswordProps = {
    userUuid: 'user-uuid',
    label: 'Desktop',
    hashedPassword: 'hash',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  }

  it('validates app-password labels and preserves revocation semantics', () => {
    expect(AppPassword.create({ ...appPasswordProps, label: '' }).getError()).toBe('App password label cannot be empty')
    expect(AppPassword.create({ ...appPasswordProps, label: 'x'.repeat(256) }).getError()).toBe(
      'App password label cannot be longer than 255 characters',
    )

    const password = AppPassword.create(appPasswordProps).getValue()
    const revokedAt = new Date('2026-01-02T00:00:00.000Z')
    password.revoke(revokedAt)
    password.revoke(new Date('2026-01-03T00:00:00.000Z'))
    expect(password.isRevoked()).toBe(true)
    expect(password.isActive(revokedAt)).toBe(false)
  })

  const deadManSwitchProps = {
    userUuid: 'user-uuid',
    recipientEmail: 'recipient@example.com',
    shareUrl: 'https://notes.example/share#key',
    message: null,
    intervalDays: 30,
    deadline: 1_800_000_000_000,
    triggered: false,
    lastCheckInAt: null,
    createdAt: 1_700_000_000_000,
    sendAttempts: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastError: null,
  }

  it('rejects incomplete or invalid dead-man switches', () => {
    expect(DeadManSwitch.create({ ...deadManSwitchProps, recipientEmail: '' }).getError()).toBe(
      'Dead man switch recipient email cannot be empty',
    )
    expect(DeadManSwitch.create({ ...deadManSwitchProps, shareUrl: '' }).getError()).toBe(
      'Dead man switch share url cannot be empty',
    )
    expect(DeadManSwitch.create({ ...deadManSwitchProps, intervalDays: 0 }).getError()).toBe(
      'Dead man switch interval must be at least 1 day',
    )
  })

  const emailReminderProps = {
    userUuid: 'user-uuid',
    dueAt: 1_800_000_000_000,
    message: 'Review the shared note',
    sent: false,
    createdAt: 1_700_000_000_000,
  }

  it('rejects empty reminder messages and invalid due timestamps', () => {
    expect(EmailReminder.create({ ...emailReminderProps, message: '' }).getError()).toBe(
      'Email reminder message cannot be empty',
    )
    expect(EmailReminder.create({ ...emailReminderProps, dueAt: Number.NaN }).getError()).toBe(
      'Email reminder due time must be a valid timestamp',
    )
  })

  const mcpTokenProps = {
    userUuid: 'user-uuid',
    label: 'Automation',
    hashedToken: 'hash',
    scope: 'read' as const,
    scopeTagUuids: null,
    wrappedKeys: 'wrapped',
    kdfSalt: 'salt',
    kdfParams: '{}',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastUsedAt: null,
    expiresAt: null,
  }

  it('validates MCP token labels and scopes', () => {
    expect(McpToken.create({ ...mcpTokenProps, label: '' }).getError()).toBe('MCP token label cannot be empty')
    expect(McpToken.create({ ...mcpTokenProps, label: 'x'.repeat(256) }).getError()).toBe(
      'MCP token label cannot be longer than 255 characters',
    )
    expect(McpToken.create({ ...mcpTokenProps, scope: 'admin' as 'read' }).getError()).toBe(
      'MCP token scope must be either read or write',
    )
  })

  const pendingApprovalProps = {
    userUuid: 'user-uuid',
    challengeId: 'challenge',
    status: 'pending' as const,
    requestingUserAgent: 'Browser',
    requestingIpAddress: '127.0.0.1',
    createdAt: 100,
    expiresAt: 200,
    consumed: false,
  }

  it('validates MFA approval identity and expiry boundaries', () => {
    expect(PendingMfaApproval.create({ ...pendingApprovalProps, userUuid: '' }).getError()).toBe(
      'Pending MFA approval user uuid cannot be empty',
    )
    expect(PendingMfaApproval.create({ ...pendingApprovalProps, challengeId: '' }).getError()).toBe(
      'Pending MFA approval challenge id cannot be empty',
    )
    expect(PendingMfaApproval.create({ ...pendingApprovalProps, expiresAt: 100 }).getError()).toBe(
      'Pending MFA approval expiry must be after its creation time',
    )

    const approval = PendingMfaApproval.create(pendingApprovalProps).getValue()
    expect(approval.isActionable(199)).toBe(true)
    expect(approval.isActionable(200)).toBe(false)
  })

  const shareProps = {
    userUuid: 'user-uuid',
    type: 'note' as const,
    encryptedPayload: 'encrypted',
    nickname: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    revoked: false,
    oneTimeView: false,
    viewExpiresMinutes: null,
    firstOpenedAt: null,
  }

  it('validates share type, payload, nickname, and view-expiry policy', () => {
    expect(Share.create({ ...shareProps, type: 'file' as 'note' }).getError()).toBe(
      'Share type must be one of note, tag or account',
    )
    expect(Share.create({ ...shareProps, encryptedPayload: '' }).getError()).toBe(
      'Share encrypted payload cannot be empty',
    )
    expect(Share.create({ ...shareProps, nickname: 'x'.repeat(256) }).getError()).toBe(
      'Share nickname cannot be longer than 255 characters',
    )
    expect(Share.create({ ...shareProps, viewExpiresMinutes: 1.5 }).getError()).toBe(
      'Share view expiry minutes must be a positive integer',
    )
    expect(Share.create({ ...shareProps, viewExpiresMinutes: 0 }).getError()).toBe(
      'Share view expiry minutes must be a positive integer',
    )
  })
})
