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
// /admin controller and gated on the INTERNAL_TEAM_USER role server-side).
const AdminPaths = {
  lookupUser: (email: string) => `/v1/admin/lookup-user/${encodeURIComponent(email)}`,
  userFeatureFlags: (userUuid: string) => `/v1/admin/users/${userUuid}/feature-flags`,
  registration: '/v1/admin/registration',
}

// Standard Red Notes: app-specific passwords. These hit the gateway
// /v1/app-passwords routes (cross-service-token protected), which proxy to the
// auth server. They let headless clients (e.g. the MCP bridge) satisfy the 2FA
// challenge without an interactive TOTP code.
const AppPasswordPaths = {
  appPasswords: '/v1/app-passwords',
  appPassword: (appPasswordId: string) => `/v1/app-passwords/${appPasswordId}`,
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
    ...AppPasswordPaths,
    ...McpTokenPaths,
    meta: '/v1/meta',
  },
  v2: {
    ...UserPathsV2,
  },
}
