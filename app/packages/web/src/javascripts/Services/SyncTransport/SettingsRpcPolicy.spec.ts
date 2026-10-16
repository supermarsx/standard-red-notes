/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isSettingsRpcRequest, settingsRpcAllowsConfigSecrets } from './SettingsRpcPolicy'

it.each([
  ['PUT', '/v1/admin/server-settings'],
  ['PUT', '/v1/admin/registration'],
  ['PUT', '/v1/admin/users/user-1/feature-flags'],
  ['POST', '/v1/admin/anti-abuse/ip-block'],
  ['POST', '/v1/admin/invite-links'],
  ['DELETE', '/v1/admin/invite-links/link-1'],
  ['POST', '/v1/admin/pending-users/user-1/approve'],
  ['PUT', '/v1/admin/roles/role-1/permissions'],
  ['POST', '/v1/admin/groups/group-1/members'],
  ['DELETE', '/v1/admin/groups/group-1/members/user-1'],
  ['POST', '/v1/admin/services/api-gateway/restart'],
  ['POST', '/v1/admin/containers/cache/restart'],
  ['PUT', '/v1/admin/email-delivery/relays'],
  ['POST', '/v1/admin/email-delivery/queue/entry-1/retry'],
  ['DELETE', '/v1/admin/email-delivery/queue/entry-1'],
  ['POST', '/v1/admin/item-storage-usage'],
  ['GET', '/v1/users/user-1/settings'],
  ['PUT', '/v1/users/user-1/settings'],
  ['DELETE', '/v1/users/user-1/settings/email_backup_frequency'],
  ['GET', '/v1/users/user-1/subscription-settings/file_upload_bytes_used'],
  ['PUT', '/v1/users/user-1/subscription-settings'],
  ['GET', '/v1/users/user-1/subscription'],
  ['GET', '/v1/users/user-1/features'],
  ['GET', '/v1/sessions'],
  ['GET', '/v1/items/storage-usage'],
  ['POST', '/v1/users/me/invite-links'],
  ['DELETE', '/v1/users/me/invite-links/link-1'],
  ['POST', '/v1/app-passwords'],
  ['DELETE', '/v1/app-passwords/secret-id/permanent'],
  ['POST', '/v1/mcp-tokens'],
  ['DELETE', '/v1/trusted-devices/device-1'],
  ['POST', '/v1/webhooks'],
  ['POST', '/v1/dead-man-switches/switch-1/check-in'],
  ['PUT', '/v1/reminder-delivery/delivery-config'],
  ['POST', '/v1/reminder-delivery/opt-out'],
  ['POST', '/v1/caldav/tokens'],
  ['PUT', '/v1/caldav/projection'],
  ['POST', '/v1/dav-bridge/accounts'],
  ['PUT', '/v1/dav-bridge/accounts/account-1/secret'],
  ['POST', '/v1/dav-bridge/accounts/account-1/relay'],
])('admits the reviewed settings operation %s %s', (method, path) => {
  expect(isSettingsRpcRequest(method, `${path}?api=20240226`)).toBe(true)
})

it.each([
  ['POST', '/v1/admin/unknown'],
  ['PATCH', '/v1/admin/server-settings'],
  ['DELETE', '/v1/admin/users/user-1/credentials'],
  ['PUT', '/v1/users/user-1'],
  ['PUT', '/v1/users/user-1/attributes/credentials'],
  ['GET', '/v1/users/user-1/mfa-secret'],
  ['GET', '/v1/users/user-1/settings/mfa_secret'],
  ['POST', '/v1/sessions/refresh'],
  ['DELETE', '/v1/sessions/session-1'],
  ['POST', '/v1/pending-mfa-approvals/challenge/resolve'],
  ['POST', '/v1/items'],
  ['POST', '/v1/files/upload/chunk'],
  ['POST', '/v1/sockets/sync/ticket'],
  ['PUT', '/v1/%75sers/user-1/settings'],
  ['PUT', '//other.test/v1/admin/server-settings'],
  ['PUT', '/v1/admin/server-settings#other'],
  ['PUT', '/v1/admin/roles/role-1%2fother/permissions'],
])('rejects unknown, credential, session or noncanonical routes: %s %s', (method, path) => {
  expect(isSettingsRpcRequest(method, path)).toBe(false)
})

it('does not admit MFA setup through the generic setting write endpoint', () => {
  expect(isSettingsRpcRequest('PUT', '/v1/users/user-1/settings', { name: 'MFA_SECRET', value: 'secret' })).toBe(false)
  expect(
    isSettingsRpcRequest('PUT', '/v1/users/user-1/settings', { name: 'EMAIL_BACKUP_FREQUENCY', value: 'daily' }),
  ).toBe(true)
})

it('permits integration configuration secrets only on the reviewed configuration writes', () => {
  expect(settingsRpcAllowsConfigSecrets('PUT', '/v1/admin/server-settings')).toBe(true)
  expect(settingsRpcAllowsConfigSecrets('PUT', '/v1/admin/email-delivery/relays')).toBe(true)
  expect(settingsRpcAllowsConfigSecrets('POST', '/v1/dav-bridge/accounts')).toBe(true)
  expect(settingsRpcAllowsConfigSecrets('POST', '/v1/admin/unknown')).toBe(false)
  expect(settingsRpcAllowsConfigSecrets('POST', '/v1/sessions/refresh')).toBe(false)
})

it('keeps the independently built browser and server route policies identical', () => {
  const client = readFileSync(resolve(__dirname, 'SettingsRpcPolicy.ts'), 'utf8').replace(/\r\n/g, '\n')
  const server = readFileSync(
    resolve(__dirname, '../../../../../../../server/packages/websocket-gateway/src/settingsRpcPolicy.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n')
  expect(client).toBe(server)
})
