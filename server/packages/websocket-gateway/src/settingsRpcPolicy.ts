/** Closed settings route catalog. Keep the web/client mirror byte-for-byte equivalent. */
function settingsPathname(path: string): string | undefined {
  try {
    const url = new URL(path, 'http://rpc.invalid')
    if (
      url.origin !== 'http://rpc.invalid' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      url.hash ||
      /[%\\]/u.test(url.pathname)
    ) {
      return undefined
    }
    return url.pathname.toLowerCase().replace(/\/+$/u, '')
  } catch {
    return undefined
  }
}

const ID = '[a-z0-9][a-z0-9._:@+-]{0,199}'
const routes: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', new RegExp(`^/v1/users/${ID}/(?:settings|subscription-settings)(?:/${ID})?$`)],
  ['PUT', new RegExp(`^/v1/users/${ID}/(?:settings|subscription-settings)$`)],
  ['DELETE', new RegExp(`^/v1/users/${ID}/settings/${ID}$`)],
  ['GET', new RegExp(`^/v1/users/${ID}/(?:subscription|features)$`)],
  ['GET', /^\/v1\/sessions$/u],
  ['GET', /^\/v1\/items\/storage-usage$/u],
  ['GET', /^\/v1\/users\/me\/invite-links$/u],
  ['POST', /^\/v1\/users\/me\/invite-links$/u],
  ['DELETE', new RegExp(`^/v1/users/me/invite-links/${ID}$`)],
  ['PUT', /^\/v1\/admin\/(?:server-settings|registration|email-delivery\/relays)$/u],
  ['PUT', new RegExp(`^/v1/admin/users/${ID}/(?:feature-flags|ban-status|suspension|admin-role)$`)],
  [
    'POST',
    /^\/v1\/admin\/(?:invite-links|item-storage-usage|roles|roles\/resolve-permissions|groups|email-delivery\/test)$/u,
  ],
  ['POST', /^\/v1\/admin\/anti-abuse\/(?:ip-block|ip-unblock|ip-allow|ip-unallow|unlock)$/u],
  ['POST', new RegExp(`^/v1/admin/pending-users/${ID}/(?:approve|reject)$`)],
  ['POST', new RegExp(`^/v1/admin/users/${ID}/(?:fix-quota|mfa/reset)$`)],
  ['POST', new RegExp(`^/v1/admin/services/${ID}/(?:restart|stop|start)$`)],
  ['POST', new RegExp(`^/v1/admin/containers/${ID}/restart$`)],
  ['POST', new RegExp(`^/v1/admin/groups/${ID}/members$`)],
  ['POST', new RegExp(`^/v1/admin/email-delivery/queue/${ID}/retry$`)],
  ['PUT', new RegExp(`^/v1/admin/roles/${ID}/permissions$`)],
  ['PUT', new RegExp(`^/v1/admin/groups/${ID}/roles$`)],
  ['DELETE', new RegExp(`^/v1/admin/(?:invite-links|users|roles|groups|email-delivery/queue)/${ID}$`)],
  ['DELETE', new RegExp(`^/v1/admin/users/${ID}/mfa-secret$`)],
  ['DELETE', new RegExp(`^/v1/admin/groups/${ID}/members/${ID}$`)],
  ['POST', /^\/v1\/(?:app-passwords|trusted-devices|mcp-tokens|webhooks|dead-man-switches|email-reminders)$/u],
  [
    'DELETE',
    new RegExp(`^/v1/(?:app-passwords|trusted-devices|mcp-tokens|webhooks|dead-man-switches|email-reminders)/${ID}$`),
  ],
  ['DELETE', new RegExp(`^/v1/app-passwords/${ID}/permanent$`)],
  ['POST', new RegExp(`^/v1/dead-man-switches/${ID}/check-in$`)],
  ['PUT', /^\/v1\/reminder-delivery\/delivery-config$/u],
  ['POST', /^\/v1\/reminder-delivery(?:\/opt-out)?$/u],
  ['DELETE', new RegExp(`^/v1/reminder-delivery/${ID}$`)],
  ['POST', /^\/v1\/caldav\/(?:tokens|todos)$/u],
  ['DELETE', new RegExp(`^/v1/caldav/tokens(?:/${ID})?$`)],
  ['DELETE', new RegExp(`^/v1/caldav/todos/${ID}$`)],
  ['PUT', /^\/v1\/caldav\/projection$/u],
  ['POST', /^\/v1\/dav-bridge\/accounts$/u],
  ['PUT', new RegExp(`^/v1/dav-bridge/accounts/${ID}/(?:secret|pin)$`)],
  ['DELETE', new RegExp(`^/v1/dav-bridge/accounts(?:/${ID})?$`)],
  ['POST', new RegExp(`^/v1/dav-bridge/accounts/${ID}/relay$`)],
]

/** No session issuance/refresh/logout, account credentials, MFA challenge, raw or multipart routes. */
export function isSettingsRpcRequest(method: string, path: string, body?: unknown): boolean {
  const pathname = settingsPathname(path)
  if (!pathname) {
    return false
  }
  if (/^\/v1\/users\//u.test(pathname)) {
    if (/\/settings\/mfa_secret$/u.test(pathname)) {
      return false
    }
    if (
      body &&
      typeof body === 'object' &&
      'name' in body &&
      typeof body.name === 'string' &&
      body.name.toLowerCase() === 'mfa_secret'
    ) {
      return false
    }
  }
  return routes.some(([allowedMethod, route]) => method === allowedMethod && route.test(pathname))
}

/** These reviewed credential values configure integrations, never authenticate the app session. */
export function settingsRpcAllowsConfigSecrets(method: string, path: string): boolean {
  const pathname = settingsPathname(path)
  return (
    (method === 'PUT' &&
      (pathname === '/v1/admin/server-settings' || pathname === '/v1/admin/email-delivery/relays')) ||
    (method === 'POST' && pathname === '/v1/dav-bridge/accounts') ||
    (method === 'PUT' && new RegExp(`^/v1/dav-bridge/accounts/${ID}/secret$`).test(pathname ?? ''))
  )
}
