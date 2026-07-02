import 'reflect-metadata'

import { getControllerMethodMetadata } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { AnnotatedAdminController } from './AnnotatedAdminController'

/**
 * Standard Red Notes: route-wiring spec for the auth /admin controller.
 *
 * The BaseAdminController's requestorIsAdmin() gate (and the audit-log actor
 * attribution) read response.locals.roles / locals.user — which on the HTTP
 * path are ONLY populated by the required cross-service-token middleware
 * decoding the X-Auth-Token the api-gateway forwards. A route that forgets the
 * middleware therefore 403s for EVERY caller, including genuine
 * INTERNAL_TEAM_USER admins (the live-stack bug this spec pins down). The gate
 * logic itself is covered by BaseAdminController.spec.ts; this spec asserts the
 * WIRING: every admin-panel route must carry the middleware, and the six
 * legacy internal routes (unreachable through the public gateway) must stay
 * middleware-free so internal callers keep working.
 */
describe('AnnotatedAdminController route wiring', () => {
  const methodMetadata = getControllerMethodMetadata(AnnotatedAdminController)

  const routesByHandler = new Map(methodMetadata.map((metadata) => [metadata.key, metadata]))

  const adminPanelHandlers = [
    'lookupUser',
    'getUserFeatureFlags',
    'setUserFeatureFlag',
    'getUserBanStatus',
    'setUserBanStatusEndpoint',
    'getRegistrationFlag',
    'setRegistrationFlag',
    'getAuditLog',
    'getUsers',
    'getAvailableRoles',
    'listGroups',
    'createGroup',
    'deleteGroup',
    'setGroupRoles',
    'listGroupMembers',
    'addUserToGroup',
    'removeUserFromGroup',
    'getUserEffectivePermissions',
    'setUserAdminRole',
    'resetUserMFA',
    'fixUserQuota',
  ]

  const legacyInternalHandlers = [
    'getUser',
    'getListedCode',
    'deleteMFASetting',
    'createToken',
    'createOfflineToken',
    'disableEmailBackups',
  ]

  it('registers a route for every expected handler', () => {
    for (const handler of [...adminPanelHandlers, ...legacyInternalHandlers]) {
      expect(routesByHandler.has(handler)).toBe(true)
    }
  })

  it.each(adminPanelHandlers)(
    'admin-panel route %s decodes the cross-service token so the role gate can work',
    (handler) => {
      const route = routesByHandler.get(handler)

      expect(route).toBeDefined()
      expect(route?.middleware).toContain(TYPES.Auth_RequiredCrossServiceTokenMiddleware)
    },
  )

  it.each(legacyInternalHandlers)('legacy internal route %s stays middleware-free (internal-only)', (handler) => {
    const route = routesByHandler.get(handler)

    expect(route).toBeDefined()
    expect(route?.middleware ?? []).toHaveLength(0)
  })
})
