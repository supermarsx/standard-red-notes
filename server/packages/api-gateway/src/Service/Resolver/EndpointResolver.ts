import { EndpointResolverInterface } from './EndpointResolverInterface'

export class EndpointResolver implements EndpointResolverInterface {
  constructor(private isConfiguredForHomeServer: boolean) {}

  private readonly endpointToIdentifierMap: Map<string, string> = new Map([
    // Auth Middleware
    ['[POST]:sessions/validate', 'auth.sessions.validate'],
    // Actions Controller
    ['[POST]:auth/sign_out', 'auth.signOut'],
    ['[POST]:auth/recovery/codes', 'auth.generateRecoveryCodes'],
    ['[POST]:auth/recovery/login', 'auth.signInWithRecoveryCodes'],
    ['[POST]:auth/recovery/params', 'auth.recoveryKeyParams'],
    // v2 Actions Controller
    ['[POST]:auth/pkce_sign_in', 'auth.pkceSignIn'],
    ['[POST]:auth/pkce_params', 'auth.pkceParams'],
    // Authenticators Controller
    ['[DELETE]:authenticators/:authenticatorId', 'auth.authenticators.delete'],
    ['[GET]:authenticators/', 'auth.authenticators.list'],
    ['[GET]:authenticators/generate-registration-options', 'auth.authenticators.generateRegistrationOptions'],
    ['[POST]:authenticators/generate-authentication-options', 'auth.authenticators.generateAuthenticationOptions'],
    ['[POST]:authenticators/verify-registration', 'auth.authenticators.verifyRegistrationResponse'],
    // App Passwords Controller (Standard Red Notes)
    ['[GET]:app-passwords/', 'auth.appPasswords.list'],
    ['[POST]:app-passwords/', 'auth.appPasswords.create'],
    ['[DELETE]:app-passwords/:appPasswordId', 'auth.appPasswords.revoke'],
    ['[DELETE]:app-passwords/:appPasswordId/permanent', 'auth.appPasswords.delete'],
    // MCP Tokens Controller (Standard Red Notes)
    ['[GET]:mcp-tokens/', 'auth.mcpTokens.list'],
    ['[POST]:mcp-tokens/', 'auth.mcpTokens.create'],
    ['[DELETE]:mcp-tokens/:mcpTokenId', 'auth.mcpTokens.delete'],
    ['[GET]:mcp-tokens/keys/:mcpTokenId', 'auth.mcpTokens.getKeys'],
    ['[POST]:mcp-tokens/authenticate', 'auth.mcpTokens.authenticate'],
    // Webhooks Controller (Standard Red Notes)
    ['[GET]:webhooks/', 'auth.webhooks.list'],
    ['[POST]:webhooks/', 'auth.webhooks.create'],
    ['[DELETE]:webhooks/:webhookId', 'auth.webhooks.delete'],
    // Shares Controller (Standard Red Notes)
    ['[POST]:shares/', 'auth.shares.create'],
    ['[GET]:shares/', 'auth.shares.list'],
    ['[DELETE]:shares/:shareId', 'auth.shares.revoke'],
    ['[GET]:shares/:shareId', 'auth.shares.get'],
    // Dead Man Switches Controller (Standard Red Notes)
    ['[POST]:dead-man-switches/', 'auth.deadManSwitches.create'],
    ['[GET]:dead-man-switches/', 'auth.deadManSwitches.list'],
    ['[POST]:dead-man-switches/:switchId/check-in', 'auth.deadManSwitches.checkIn'],
    ['[DELETE]:dead-man-switches/:switchId', 'auth.deadManSwitches.delete'],
    // Email Reminders Controller (Standard Red Notes)
    ['[POST]:email-reminders/', 'auth.emailReminders.create'],
    ['[GET]:email-reminders/', 'auth.emailReminders.list'],
    ['[DELETE]:email-reminders/:reminderId', 'auth.emailReminders.delete'],
    // Trusted Devices Controller (Standard Red Notes)
    ['[POST]:trusted-devices/', 'auth.trustedDevices.create'],
    ['[GET]:trusted-devices/', 'auth.trustedDevices.list'],
    ['[DELETE]:trusted-devices/:deviceId', 'auth.trustedDevices.delete'],
    // Pending MFA Approvals Controller (Standard Red Notes)
    ['[GET]:pending-mfa-approvals/', 'auth.pendingMfaApprovals.list'],
    ['[POST]:pending-mfa-approvals/:challengeId/resolve', 'auth.pendingMfaApprovals.resolve'],
    ['[GET]:pending-mfa-approvals/:challengeId/status', 'auth.pendingMfaApprovals.status'],
    // Magic Link Controller
    ['[POST]:mfa/magic-link/request', 'auth.magicLink.request'],
    ['[POST]:mfa/magic-link/status', 'auth.magicLink.setStatus'],
    ['[GET]:mfa/magic-link/status', 'auth.magicLink.getStatus'],
    // Files Controller
    ['[POST]:valet-tokens', 'auth.valet-tokens.create'],
    // Offline Controller
    ['[GET]:offline/features', 'auth.offline.features'],
    ['[POST]:offline/subscription-tokens', 'auth.offline.subscriptionTokens.create'],
    // Sessions Controller
    ['[GET]:sessions', 'auth.sessions.list'],
    ['[DELETE]:session', 'auth.sessions.delete'],
    ['[DELETE]:session/all', 'auth.sessions.deleteAll'],
    ['[POST]:session/refresh', 'auth.sessions.refresh'],
    // Subscription Invites Controller
    ['[POST]:subscription-invites', 'auth.subscriptionInvites.create'],
    ['[GET]:subscription-invites', 'auth.subscriptionInvites.list'],
    ['[DELETE]:subscription-invites/:inviteUuid', 'auth.subscriptionInvites.delete'],
    ['[POST]:subscription-invites/:inviteUuid/accept', 'auth.subscriptionInvites.accept'],
    // Tokens Controller
    ['[POST]:subscription-tokens', 'auth.subscription-tokens.create'],
    // Users Controller
    ['[PUT]:users/:userUuid/attributes/credentials', 'auth.users.updateCredentials'],
    ['[DELETE]:users/:userUuid', 'auth.users.delete'],
    ['[POST]:auth', 'auth.users.register'],
    // Email confirmation (Standard Red Notes) — public, unauthenticated
    ['[POST]:auth/email-confirmation/verify', 'auth.emailConfirmation.verify'],
    ['[POST]:auth/email-confirmation/resend', 'auth.emailConfirmation.resend'],
    ['[GET]:users/:userUuid/settings', 'auth.users.getSettings'],
    ['[PUT]:users/:userUuid/settings', 'auth.users.updateSetting'],
    ['[GET]:users/:userUuid/settings/:settingName', 'auth.users.getSetting'],
    ['[DELETE]:users/:userUuid/settings/:settingName', 'auth.users.deleteSetting'],
    ['[PUT]:users/:userUuid/subscription-settings', 'auth.users.updateSubscriptionSetting'],
    ['[GET]:users/:userUuid/subscription-settings/:subscriptionSettingName', 'auth.users.getSubscriptionSetting'],
    ['[GET]:users/:userUuid/features', 'auth.users.getFeatures'],
    ['[GET]:users/:userUuid/subscription', 'auth.users.getSubscription'],
    ['[GET]:offline/users/subscription', 'auth.users.getOfflineSubscriptionByToken'],
    ['[POST]:users/:userUuid/requests', 'auth.users.createRequest'],
    ['[GET]:users/:userUuid/mfa-secret', 'auth.users.getMfaSecret'],
    // Self-serve / referral invite links (AUTHENTICATED user, not admin). The auth
    // controller scopes every call to response.locals.user.uuid. ':uuid' delete last.
    ['[POST]:users/me/invite-links', 'auth.meInviteLinks.create'],
    ['[GET]:users/me/invite-links', 'auth.meInviteLinks.list'],
    ['[DELETE]:users/me/invite-links/:uuid', 'auth.meInviteLinks.revoke'],
    // Admin Controller (Standard Red Notes admin panel)
    ['[GET]:admin/lookup-user/:email', 'admin.lookupUser'],
    ['[GET]:admin/users/:userUuid/feature-flags', 'admin.getUserFeatureFlags'],
    ['[PUT]:admin/users/:userUuid/feature-flags', 'admin.setUserFeatureFlag'],
    ['[GET]:admin/users/:email/ban-status', 'admin.getUserBanStatus'],
    ['[PUT]:admin/users/:userUuid/ban-status', 'admin.setUserBanStatus'],
    ['[GET]:admin/users/:email/suspension-status', 'admin.getUserSuspensionStatus'],
    ['[PUT]:admin/users/:userUuid/suspension', 'admin.setUserSuspension'],
    ['[GET]:admin/registration', 'admin.getRegistrationFlag'],
    ['[PUT]:admin/registration', 'admin.setRegistrationFlag'],
    // Invite-URL signup control: admin invite-link CRUD (':uuid' delete last).
    ['[POST]:admin/invite-links', 'admin.createInviteLink'],
    ['[GET]:admin/invite-links', 'admin.listInviteLinks'],
    ['[DELETE]:admin/invite-links/:uuid', 'admin.revokeInviteLink'],
    // Approval / waitlist queue: list pending + approve/reject by uuid.
    ['[GET]:admin/pending-users', 'admin.listPendingUsers'],
    ['[POST]:admin/pending-users/:userUuid/approve', 'admin.approveUser'],
    ['[POST]:admin/pending-users/:userUuid/reject', 'admin.rejectUser'],
    ['[GET]:admin/audit-log', 'admin.getAuditLog'],
    ['[GET]:admin/users', 'admin.getUsers'],
    ['[GET]:admin/roles', 'admin.getAvailableRoles'],
    ['[GET]:admin/roles/detailed', 'admin.listRolesWithPermissions'],
    ['[PUT]:admin/roles/:roleUuid/permissions', 'admin.setRolePermissions'],
    ['[GET]:admin/permissions', 'admin.getPermissionCatalog'],
    ['[POST]:admin/roles/resolve-permissions', 'admin.resolveRoleSetPermissions'],
    ['[POST]:admin/roles', 'admin.createCustomRole'],
    ['[GET]:admin/roles/:roleUuid/holders', 'admin.getRoleHolders'],
    ['[DELETE]:admin/roles/:roleUuid', 'admin.deleteCustomRole'],
    ['[GET]:admin/groups', 'admin.listGroups'],
    ['[POST]:admin/groups', 'admin.createGroup'],
    ['[DELETE]:admin/groups/:groupUuid', 'admin.deleteGroup'],
    ['[PUT]:admin/groups/:groupUuid/roles', 'admin.setGroupRoles'],
    ['[GET]:admin/groups/:groupUuid/members', 'admin.listGroupMembers'],
    ['[POST]:admin/groups/:groupUuid/members', 'admin.addUserToGroup'],
    ['[DELETE]:admin/groups/:groupUuid/members/:userUuid', 'admin.removeUserFromGroup'],
    ['[GET]:admin/users/:userUuid/effective-permissions', 'admin.getUserEffectivePermissions'],
    ['[PUT]:admin/users/:userUuid/admin-role', 'admin.setUserAdminRole'],
    ['[DELETE]:admin/users/:userUuid/mfa-secret', 'admin.resetUserMFA'],
    ['[POST]:admin/users/:userUuid/fix-quota', 'admin.fixUserQuota'],
    // Declared AFTER the more specific '/users/:userUuid/*' admin deletes so the
    // bare ':userUuid' hard-delete never shadows them.
    ['[DELETE]:admin/users/:userUuid', 'admin.deleteUser'],
    // Anti-abuse: locked-account list + unlock (proxied to the auth admin controller)
    ['[GET]:admin/anti-abuse/locked-accounts', 'admin.getLockedAccounts'],
    ['[POST]:admin/anti-abuse/unlock', 'admin.unlockAccount'],
    // Syncing Server
    ['[POST]:items/sync', 'sync.items.sync'],
    ['[POST]:items/check-integrity', 'sync.items.check_integrity'],
    ['[GET]:items/:uuid', 'sync.items.get_item'],
    ['[POST]:items/collaboration-authorization', 'sync.items.authorize_collaboration'],
    // Revisions Controller V2
    ['[GET]:items/:itemUuid/revisions', 'revisions.revisions.getRevisions'],
    ['[GET]:items/:itemUuid/revisions/:id', 'revisions.revisions.getRevision'],
    ['[DELETE]:items/:itemUuid/revisions/:id', 'revisions.revisions.deleteRevision'],
    // Messages Controller
    ['[GET]:messages/', 'sync.messages.get-received'],
    ['[GET]:messages/outbound', 'sync.messages.get-sent'],
    ['[POST]:messages/', 'sync.messages.send'],
    ['[DELETE]:messages/inbound', 'sync.messages.delete-all'],
    ['[DELETE]:messages/:messageUuid', 'sync.messages.delete'],
    // Shared Vaults Controller
    ['[GET]:shared-vaults/', 'sync.shared-vaults.get-vaults'],
    ['[POST]:shared-vaults/', 'sync.shared-vaults.create-vault'],
    ['[DELETE]:shared-vaults/:sharedVaultUuid', 'sync.shared-vaults.delete-vault'],
    ['[POST]:shared-vaults/:sharedVaultUuid/valet-tokens', 'sync.shared-vaults.create-file-valet-token'],
    // Shared Vault Invites Controller
    ['[POST]:shared-vaults/:sharedVaultUuid/invites', 'sync.shared-vault-invites.create'],
    ['[PATCH]:shared-vaults/:sharedVaultUuid/invites/:inviteUuid', 'sync.shared-vault-invites.update'],
    ['[POST]:shared-vaults/:sharedVaultUuid/invites/:inviteUuid/accept', 'sync.shared-vault-invites.accept'],
    ['[POST]:shared-vaults/:sharedVaultUuid/invites/:inviteUuid/decline', 'sync.shared-vault-invites.decline'],
    ['[DELETE]:shared-vaults/invites/inbound', 'sync.shared-vault-invites.delete-inbound'],
    ['[DELETE]:shared-vaults/invites/outbound', 'sync.shared-vault-invites.delete-outbound'],
    ['[GET]:shared-vaults/invites/outbound', 'sync.shared-vault-invites.get-outbound'],
    ['[GET]:shared-vaults/invites', 'sync.shared-vault-invites.get-user-invites'],
    ['[GET]:shared-vaults/:sharedVaultUuid/invites', 'sync.shared-vault-invites.get-vault-invites'],
    ['[DELETE]:shared-vaults/:sharedVaultUuid/invites/:inviteUuid', 'sync.shared-vault-invites.delete-invite'],
    ['[DELETE]:shared-vaults/:sharedVaultUuid/invites', 'sync.shared-vault-invites.delete-all'],
    // Shared Vault Users Controller
    ['[GET]:shared-vaults/:sharedVaultUuid/users', 'sync.shared-vault-users.get-users'],
    ['[DELETE]:shared-vaults/:sharedVaultUuid/users/:userUuid', 'sync.shared-vault-users.remove-user'],
    [
      '[POST]:shared-vaults/:sharedVaultUuid/users/:userUuid/designate-survivor',
      'sync.shared-vault-users.designate-survivor',
    ],
  ])

  resolveEndpointOrMethodIdentifier(method: string, endpoint: string, ...params: string[]): string {
    if (!this.isConfiguredForHomeServer) {
      if (params.length > 0) {
        // Standard Red Notes: substitute ":placeholder" tokens positionally in a
        // SINGLE left-to-right pass over the original endpoint. The previous
        // `reduce(... replace(/:[a-zA-Z0-9]+/, param))` re-scanned the string each
        // iteration, so a param value containing a ":word" (e.g. a userUuid) got
        // mis-matched as the next placeholder and clobbered. A global replace with
        // a positional replacer inserts each param at the k-th placeholder and
        // never re-scans inserted text, keeping single-param routes identical.
        let paramIndex = 0
        return endpoint.replace(/:[a-zA-Z0-9]+/g, (match) => {
          return paramIndex < params.length ? params[paramIndex++] : match
        })
      }

      return endpoint
    }
    const identifier = this.endpointToIdentifierMap.get(`[${method}]:${endpoint}`)

    if (!identifier) {
      throw new Error(`Endpoint [${method}]:${endpoint} not found`)
    }

    return identifier
  }
}
