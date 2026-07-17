import 'reflect-metadata'

import { ControllerContainer } from '@standardnotes/domain-core'

import { BaseAdminController } from './BaseAdminController'
import { BaseMeInviteLinksController } from './BaseMeInviteLinksController'

/**
 * Standard Red Notes t69 DRIFT GUARD.
 *
 * In SINGLE-CONTAINER (home-server / DirectCall) mode the api-gateway invokes the
 * t69 invite / approval / self-serve endpoints by IDENTIFIER STRING, resolving them
 * against the auth service's ControllerContainer (see auth Bootstrap/Service.ts
 * handleRequest → controllerContainer.get(id)). If the auth-side controller ctor
 * fails to `register(...)` the exact string the gateway emits, the endpoint returns
 * HTTP 500 "Method <id> not found" at runtime while the build stays green (the
 * multi-container @httpX decorator path is unaffected). This test pins the auth
 * side against the EXACT strings the gateway's EndpointResolver maps to, so a
 * removed / renamed registration fails here instead of silently in production.
 *
 * The identifier strings below are copied verbatim from the gateway source of
 * truth: server/packages/api-gateway/src/Service/Resolver/EndpointResolver.ts.
 * The matching gateway-side assertion lives in that package's EndpointResolver.spec
 * (route → identifier); the two specs together pin both ends of the contract.
 */

// The 6 ADMIN identifiers — EndpointResolver.ts lines 115-121.
const ADMIN_DIRECT_CALL_IDS = [
  'admin.createInviteLink',
  'admin.listInviteLinks',
  'admin.revokeInviteLink',
  'admin.listPendingUsers',
  'admin.approveUser',
  'admin.rejectUser',
]

// The 3 SELF-SERVE identifiers — EndpointResolver.ts lines 101-103.
const ME_INVITE_LINKS_DIRECT_CALL_IDS = [
  'auth.meInviteLinks.create',
  'auth.meInviteLinks.list',
  'auth.meInviteLinks.revoke',
]

describe('t69 DirectCall registration (gateway ↔ auth identifier contract)', () => {
  // A stand-in for any positional constructor dep. The registration block only
  // needs `controllerContainer` to be defined and the handler METHODS to exist —
  // it binds `this.<method>.bind(this)` without invoking, so the use-case deps
  // themselves are irrelevant to whether a handler resolves at boot.
  const anyDep = {} as never

  it('BaseAdminController registers all 6 t69 admin invite/approval DirectCall handlers under a home-server controllerContainer', () => {
    const controllerContainer = new ControllerContainer()

    // Positional args 1-10 (see Bootstrap/Container.ts construction); the real
    // ControllerContainer is the 11th positional arg. Everything after is optional.
    new BaseAdminController(
      anyDep, // 1 doDeleteSetting
      anyDep, // 2 doGetSetting
      anyDep, // 3 userRepository
      anyDep, // 4 createSubscriptionToken
      anyDep, // 5 createOfflineSubscriptionToken
      anyDep, // 6 setSettingValue
      anyDep, // 7 setUserBanStatus
      anyDep, // 8 queryAuditLog
      anyDep, // 9 auditLogEntryHttpMapper
      anyDep, // 10 auditLogWriter
      controllerContainer, // 11 controllerContainer
    )

    for (const id of ADMIN_DIRECT_CALL_IDS) {
      expect(typeof controllerContainer.get(id)).toEqual('function')
    }
  })

  it('BaseMeInviteLinksController registers all 3 auth.meInviteLinks.* DirectCall handlers under a home-server controllerContainer', () => {
    const controllerContainer = new ControllerContainer()

    new BaseMeInviteLinksController(
      anyDep, // registrationConfigResolver
      anyDep, // inviteLinkRepository
      anyDep, // inviteUseRepository
      anyDep, // doCreateSignupInviteLink
      anyDep, // doListSignupInviteLinks
      anyDep, // doRevokeSignupInviteLink
      controllerContainer,
    )

    for (const id of ME_INVITE_LINKS_DIRECT_CALL_IDS) {
      expect(typeof controllerContainer.get(id)).toEqual('function')
    }
  })

  it('does NOT register the self-serve DirectCall handlers when no controllerContainer is provided (multi-container / @httpX path)', () => {
    // The HTTP-annotated construction (AnnotatedMeInviteLinksController) passes no
    // controllerContainer; it must resolve via decorators, not DirectCall. Guards
    // against an accidental always-on registration that would double-bind.
    const controllerContainer = new ControllerContainer()

    new BaseMeInviteLinksController(anyDep, anyDep, anyDep, anyDep, anyDep, anyDep)

    for (const id of ME_INVITE_LINKS_DIRECT_CALL_IDS) {
      expect(controllerContainer.get(id)).toBeUndefined()
    }
  })
})
