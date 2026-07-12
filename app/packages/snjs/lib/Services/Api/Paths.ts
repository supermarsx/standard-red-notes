const FilesPaths = {
  closeUploadSession: '/v1/files/upload/close-session',
  createUserFileValetToken: '/v1/files/valet-tokens',
  deleteFile: '/v1/files',
  downloadFileChunk: '/v1/files',
  downloadVaultFileChunk: '/v1/vaults/files',
  startUploadSession: '/v1/files/upload/create-session',
  uploadFileChunk: '/v1/files/upload/chunk',
}

const SharedVaultFilesPaths = {
  closeSharedVaultUploadSession: '/v1/shared-vault/files/upload/close-session',
  deleteSharedVaultFile: '/v1/shared-vault/files',
  downloadSharedVaultFileChunk: '/v1/shared-vault/files',
  startSharedVaultUploadSession: '/v1/shared-vault/files/upload/create-session',
  uploadSharedVaultFileChunk: '/v1/shared-vault/files/upload/chunk',
  moveFile: '/v1/shared-vault/files/move',
}

const UserPaths = {
  changeCredentials: (userUuid: string) => `/v1/users/${userUuid}/attributes/credentials`,
  deleteAccount: (userUuid: string) => `/v1/users/${userUuid}`,
  keyParams: '/v1/login-params',
  refreshSession: '/v1/sessions/refresh',
  register: '/v1/users',
  session: (sessionUuid: string) => `/v1/sessions/${sessionUuid}`,
  sessions: '/v1/sessions',
  signIn: '/v1/login',
  signOut: '/v1/logout',
  // Standard Red Notes: EMAIL CONFIRMATION (part 2). Public, unauthenticated.
  verifyEmailConfirmation: '/v1/users/email-confirmation/verify',
  resendEmailConfirmation: '/v1/users/email-confirmation/resend',
}

const ItemsPaths = {
  checkIntegrity: '/v1/items/check-integrity',
  getSingleItem: (uuid: string) => `/v1/items/${uuid}`,
  itemRevisions: (itemUuid: string) => `/v1/items/${itemUuid}/revisions`,
  itemRevision: (itemUuid: string, revisionUuid: string) => `/v1/items/${itemUuid}/revisions/${revisionUuid}`,
  sync: '/v1/items',
}

const SettingsPaths = {
  settings: (userUuid: string) => `/v1/users/${userUuid}/settings`,
  setting: (userUuid: string, settingName: string) => `/v1/users/${userUuid}/settings/${settingName}`,
  mfaSecret: (userUuid: string) => `/v1/users/${userUuid}/mfa-secret`,
  subscriptionSetting: (userUuid: string, settingName: string) =>
    `/v1/users/${userUuid}/subscription-settings/${settingName}`,
  subscriptionSettings: (userUuid: string) => `/v1/users/${userUuid}/subscription-settings`,
}

// Standard Red Notes: in-app admin panel endpoints (proxied to the auth server
// /admin controller and gated on the ADMIN_USER role server-side).
const AdminPaths = {
  lookupUser: (email: string) => `/v1/admin/lookup-user/${encodeURIComponent(email)}`,
  // Standard Red Notes: paginated admin users list (most-recent-first) with
  // filtering. Server clamps limit to 1500.
  adminUsers: '/v1/admin/users',
  // Standard Red Notes: read-only tail of the server logs (all services).
  adminLogs: '/v1/admin/logs',
  userFeatureFlags: (userUuid: string) => `/v1/admin/users/${userUuid}/feature-flags`,
  userBanStatus: (email: string) => `/v1/admin/users/${encodeURIComponent(email)}/ban-status`,
  setUserBanStatus: (userUuid: string) => `/v1/admin/users/${userUuid}/ban-status`,
  // Standard Red Notes: reversible administrative SUSPENSION (distinct from ban).
  // Status looked up by email; set + hard delete by uuid.
  userSuspensionStatus: (email: string) => `/v1/admin/users/${encodeURIComponent(email)}/suspension-status`,
  userSuspension: (userUuid: string) => `/v1/admin/users/${userUuid}/suspension`,
  userDelete: (userUuid: string) => `/v1/admin/users/${userUuid}`,
  registration: '/v1/admin/registration',
  // Standard Red Notes: INVITE-URL signup control — admin invite-link CRUD. Create
  // returns the raw token ONCE; list never returns it; delete soft-revokes by uuid.
  inviteLinks: '/v1/admin/invite-links',
  inviteLink: (uuid: string) => `/v1/admin/invite-links/${uuid}`,
  // Standard Red Notes: APPROVAL / waitlist queue — list pending + approve/reject.
  pendingUsers: '/v1/admin/pending-users',
  approvePendingUser: (userUuid: string) => `/v1/admin/pending-users/${userUuid}/approve`,
  rejectPendingUser: (userUuid: string) => `/v1/admin/pending-users/${userUuid}/reject`,
  // Standard Red Notes: admin audit log (paginated, newest-first).
  auditLog: '/v1/admin/audit-log',
  // Standard Red Notes: read-only gateway server status (master switches + health).
  serverStatus: '/v1/admin/server-status',
  // Standard Red Notes: service lifecycle control — list controllable programs
  // (+ availability) and restart/stop/start a single supervisord program.
  adminServices: '/v1/admin/services',
  adminServiceAction: (name: string, action: 'restart' | 'stop' | 'start') =>
    `/v1/admin/services/${encodeURIComponent(name)}/${action}`,
  // Standard Red Notes: OPT-IN container restart (Redis cache / MariaDB) via the
  // locked-down docker-socket-proxy. Off by default; the /services `docker` block
  // says whether it is enabled + reachable.
  adminContainerRestart: (name: string) => `/v1/admin/containers/${encodeURIComponent(name)}/restart`,
  // Standard Red Notes: admin-editable server settings (AI providers, update
  // check URL, Nextcloud backups master switch). Secrets are write-only.
  serverSettings: '/v1/admin/server-settings',
  // Standard Red Notes: anti-abuse live view (resolved rate-limit tiers + IP
  // allow/block lists + throttle telemetry) and the four IP-list mutations.
  antiAbuse: '/v1/admin/anti-abuse',
  antiAbuseIpBlock: '/v1/admin/anti-abuse/ip-block',
  antiAbuseIpUnblock: '/v1/admin/anti-abuse/ip-unblock',
  antiAbuseIpAllow: '/v1/admin/anti-abuse/ip-allow',
  antiAbuseIpUnallow: '/v1/admin/anti-abuse/ip-unallow',
  // Standard Red Notes: anti-abuse locked-account list + unlock (proxied to auth).
  antiAbuseLockedAccounts: '/v1/admin/anti-abuse/locked-accounts',
  antiAbuseUnlock: '/v1/admin/anti-abuse/unlock',
  // Standard Red Notes: grant/revoke the admin role, reset 2FA, fix quota.
  userAdminRole: (userUuid: string) => `/v1/admin/users/${userUuid}/admin-role`,
  userMfaSecret: (userUuid: string) => `/v1/admin/users/${userUuid}/mfa-secret`,
  userFixQuota: (userUuid: string) => `/v1/admin/users/${userUuid}/fix-quota`,
  // Standard Red Notes: RBAC groups & granular permissions.
  roles: '/v1/admin/roles',
  // Standard Red Notes: every role with its permissions + the permission
  // catalog (read), and a role's editable permission assignments (write).
  rolesDetailed: '/v1/admin/roles/detailed',
  rolePermissions: (roleUuid: string) => `/v1/admin/roles/${roleUuid}/permissions`,
  // Standard Red Notes: EXTENSIVE RBAC management — permission catalog browser,
  // effective-permissions simulator, custom-role create/delete, role inspector.
  permissionsCatalog: '/v1/admin/permissions',
  rolesResolvePermissions: '/v1/admin/roles/resolve-permissions',
  role: (roleUuid: string) => `/v1/admin/roles/${roleUuid}`,
  roleHolders: (roleUuid: string) => `/v1/admin/roles/${roleUuid}/holders`,
  groups: '/v1/admin/groups',
  group: (groupUuid: string) => `/v1/admin/groups/${groupUuid}`,
  groupRoles: (groupUuid: string) => `/v1/admin/groups/${groupUuid}/roles`,
  groupMembers: (groupUuid: string) => `/v1/admin/groups/${groupUuid}/members`,
  groupMember: (groupUuid: string, userUuid: string) => `/v1/admin/groups/${groupUuid}/members/${userUuid}`,
  userEffectivePermissions: (userUuid: string) => `/v1/admin/users/${userUuid}/effective-permissions`,
}

// Standard Red Notes: app-specific passwords. These hit the gateway
// /v1/app-passwords routes (cross-service-token protected), which proxy to the
// auth server. They let headless clients (e.g. the MCP bridge) satisfy the 2FA
// challenge without an interactive TOTP code.
// Standard Red Notes: SELF-SERVE / REFERRAL invite links. These hit the gateway
// /v1/users/me/invite-links routes (cross-service-token protected), which proxy to
// the auth server's authenticated surface (scoped to response.locals.user.uuid). A
// signed-in user creates/lists/revokes their OWN links; the raw invite token is
// returned exactly once on create. Gated by the `registration.invitesPerUser`
// overlay (0 = disabled).
const MeInviteLinkPaths = {
  meInviteLinks: '/v1/users/me/invite-links',
  meInviteLink: (uuid: string) => `/v1/users/me/invite-links/${uuid}`,
}

const AppPasswordPaths = {
  appPasswords: '/v1/app-passwords',
  // Default DELETE soft-revokes (keeps the audit trail).
  appPassword: (appPasswordId: string) => `/v1/app-passwords/${appPasswordId}`,
  // Explicit permanent hard-delete.
  appPasswordPermanent: (appPasswordId: string) => `/v1/app-passwords/${appPasswordId}/permanent`,
}

// Standard Red Notes: trusted devices and push-MFA approvals. These hit the
// gateway /v1/trusted-devices and /v1/pending-mfa-approvals routes which proxy
// to the auth server. A trusted device may skip the interactive second factor
// on future sign-ins (bypasses ONLY the 2FA gate, never the account password).
const TrustedDevicePaths = {
  trustedDevices: '/v1/trusted-devices',
  trustedDevice: (deviceId: string) => `/v1/trusted-devices/${deviceId}`,
  pendingMfaApprovals: '/v1/pending-mfa-approvals',
  resolvePendingMfaApproval: (challengeId: string) => `/v1/pending-mfa-approvals/${challengeId}/resolve`,
  pendingMfaApprovalStatus: (challengeId: string) => `/v1/pending-mfa-approvals/${challengeId}/status`,
}

// Standard Red Notes: MCP scoped tokens. These hit the gateway /v1/mcp-tokens
// routes (cross-service-token protected), which proxy to the auth server. They
// let the headless MCP bridge authenticate and obtain client-side-wrapped items
// keys without the account email + password. The server only ever stores the
// ciphertext wrapping; the wrap secret is appended to the token client-side.
const McpTokenPaths = {
  mcpTokens: '/v1/mcp-tokens',
  mcpToken: (mcpTokenId: string) => `/v1/mcp-tokens/${mcpTokenId}`,
}

// Standard Red Notes: outbound webhooks. These hit the gateway /v1/webhooks
// routes (cross-service-token protected), which proxy to the auth server's
// WebhooksController. A signed-in user lists/creates/deletes their own webhooks;
// the HMAC secret is returned exactly once on create. Admins (AdminUser)
// may additionally register global webhooks that fire for all users.
const WebhookPaths = {
  webhooks: '/v1/webhooks',
  webhook: (webhookId: string) => `/v1/webhooks/${webhookId}`,
}

// Standard Red Notes: public share links. The authed routes let a signed-in user
// create, list, and revoke shares (the server only ever stores ciphertext keyed
// by a shareId). The public read (GET /v1/shares/:shareId) is intentionally NOT a
// snjs method — the unauthenticated viewer fetches it with a bare fetch.
const SharePaths = {
  shares: '/v1/shares',
  share: (shareId: string) => `/v1/shares/${shareId}`,
}

// Standard Red Notes: dead man's switch / survivor switch. The authed routes let
// a signed-in user create, list, check in on, and delete switches. The server
// stores the full share URL (link + decryption key) so it can email it to the
// recipient if the user stops checking in by the deadline.
const DeadManSwitchPaths = {
  deadManSwitches: '/v1/dead-man-switches',
  deadManSwitch: (id: string) => `/v1/dead-man-switches/${id}`,
  deadManSwitchCheckIn: (id: string) => `/v1/dead-man-switches/${id}/check-in`,
}

// Standard Red Notes: email reminders. Authed routes let a signed-in user register
// (create), list, and delete reminders that the server may EMAIL to their account
// email when due. Unlike in-app reminders (E2E-encrypted in the note appData), the
// reminder time + message here are stored in PLAINTEXT because the user opted that
// reminder into email delivery — see SetReminderModal's privacy disclosure.
const EmailReminderPaths = {
  emailReminders: '/v1/email-reminders',
  emailReminder: (id: string) => `/v1/email-reminders/${id}`,
}

// Standard Red Notes: server-side reminder DELIVERY (WhatsApp / Telegram / email).
// Authed gateway routes (cross-service-token protected). `/config` reports whether
// the feature is available for this user (env master switch + per-user opt-in) so
// the client can decide whether to show the UI. `/delivery-config` is the per-user
// channel/destination/enabled record. The collection route lists/publishes the
// PLAINTEXT reminders the user explicitly opted into server delivery (mirrors the
// email-reminders + CalDAV published-data model — never any other E2E data).
const ReminderDeliveryPaths = {
  reminderDeliveryConfig: '/v1/reminder-delivery/config',
  reminderDeliveryDeliveryConfig: '/v1/reminder-delivery/delivery-config',
  reminderDeliveryReminders: '/v1/reminder-delivery',
  reminderDeliveryReminder: (id: string) => `/v1/reminder-delivery/${encodeURIComponent(id)}`,
}

// Standard Red Notes: scoped, revocable CalDAV access tokens. Authed gateway
// routes (cross-service-token protected). `/config` reports availability (env
// master switch + per-user opt-in). A token is the Basic-auth credential stock
// CalDAV clients use to read the user's PUBLISHED reminders feed; the plaintext
// secret is returned exactly once on create (same shape as MCP tokens).
const CaldavTokenPaths = {
  caldavConfig: '/v1/caldav/tokens/config',
  caldavTokens: '/v1/caldav/tokens',
  caldavToken: (tokenUuid: string) => `/v1/caldav/tokens/${tokenUuid}`,
}

const SubscriptionPaths = {
  offlineFeatures: '/v1/offline/features',
  purchase: '/v1/purchase',
  subscription: (userUuid: string) => `/v1/users/${userUuid}/subscription`,
  subscriptionTokens: '/v1/subscription-tokens',
}

const UserPathsV2 = {
  keyParams: '/v2/login-params',
  signIn: '/v2/login',
}

export const Paths = {
  v1: {
    ...FilesPaths,
    ...SharedVaultFilesPaths,
    ...ItemsPaths,
    ...SettingsPaths,
    ...SubscriptionPaths,
    ...UserPaths,
    ...AdminPaths,
    ...MeInviteLinkPaths,
    ...AppPasswordPaths,
    ...TrustedDevicePaths,
    ...McpTokenPaths,
    ...WebhookPaths,
    ...SharePaths,
    ...DeadManSwitchPaths,
    ...EmailReminderPaths,
    ...ReminderDeliveryPaths,
    ...CaldavTokenPaths,
    // Standard Red Notes: SAME-ORIGIN plugins (extensions) gallery proxy. The
    // gateway fetches the operator-configured plugins repo server-side and returns
    // the index (and package files) from this origin, so the strict CSP
    // `connect-src 'self'` is satisfied without the client hitting an external CDN.
    pluginsIndex: '/v1/plugins/index',
    pluginsDownload: (path: string) => `/v1/plugins/download?path=${encodeURIComponent(path)}`,
    // Standard Red Notes: the client-readable plugins config ({ repoUrl,
    // sameOriginRendering }) used to decide same-origin component-URL rewriting.
    pluginsConfig: '/v1/plugins/config',
    // Standard Red Notes: same-origin component-serve route. `relativePath` is a
    // file path RELATIVE to the trusted repo base (including the component's
    // directory hierarchy); each segment is encoded but the slashes are preserved
    // so the browser resolves the component's relative asset refs back through
    // this same route. Used as the RENDERING iframe src so `frame-src 'self'` is
    // satisfied without a CSP change.
    pluginsComponent: (relativePath: string) =>
      `/v1/plugins/component/${relativePath
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`,
    meta: '/v1/meta',
  },
  v2: {
    ...UserPathsV2,
  },
}
