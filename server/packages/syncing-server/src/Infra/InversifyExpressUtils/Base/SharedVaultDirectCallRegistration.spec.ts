import { ControllerContainer } from '@standardnotes/domain-core'

import { BaseSharedVaultInvitesController } from './BaseSharedVaultInvitesController'
import { BaseSharedVaultUsersController } from './BaseSharedVaultUsersController'
import { BaseSharedVaultsController } from './BaseSharedVaultsController'

/**
 * Standard Red Notes — SHARED-VAULT DirectCall drift guard.
 *
 * In SINGLE-CONTAINER (home-server / self-hosted DirectCall) mode the api-gateway does not make an
 * HTTP call to the syncing-server: `DirectCallServiceProxy.callSyncingServer` hands the request
 * straight to `Bootstrap/Service.handleRequest`, which looks the handler up in the syncing-server's
 * `ControllerContainer` BY IDENTIFIER STRING. A handler the Base controller fails to `register(...)`
 * answers HTTP 500 "Method <id> not found" at runtime while the build, the `@httpX`-decorated
 * multi-container path and every use-case spec all stay green — the exact failure mode that left all
 * nine auth invite endpoints dead for a release.
 *
 * Every collaboration action a user can take — creating a vault, inviting someone, accepting or
 * declining, listing members, removing a member, designating a survivor — travels through one of
 * these identifiers on this operator's deployment, so an unregistered one is a whole feature gone.
 *
 * The strings below are copied VERBATIM from the gateway's source of truth,
 * server/packages/api-gateway/src/Service/Resolver/EndpointResolver.ts (the `shared-vaults` block),
 * which had no spec coverage of its own for them. A rename on either side fails here.
 */

// EndpointResolver.ts — '[*]:shared-vaults/...' → 'sync.shared-vaults.*'
const SHARED_VAULTS_DIRECT_CALL_IDS = [
  'sync.shared-vaults.get-vaults',
  'sync.shared-vaults.create-vault',
  'sync.shared-vaults.delete-vault',
  'sync.shared-vaults.create-file-valet-token',
]

// EndpointResolver.ts — '[*]:shared-vaults/...invites...' → 'sync.shared-vault-invites.*'
const SHARED_VAULT_INVITES_DIRECT_CALL_IDS = [
  'sync.shared-vault-invites.create',
  'sync.shared-vault-invites.update',
  'sync.shared-vault-invites.accept',
  'sync.shared-vault-invites.decline',
  'sync.shared-vault-invites.delete-inbound',
  'sync.shared-vault-invites.delete-outbound',
  'sync.shared-vault-invites.get-outbound',
  'sync.shared-vault-invites.get-user-invites',
  'sync.shared-vault-invites.get-vault-invites',
  'sync.shared-vault-invites.delete-invite',
  'sync.shared-vault-invites.delete-all',
]

// EndpointResolver.ts — '[*]:shared-vaults/:sharedVaultUuid/users...' → 'sync.shared-vault-users.*'
const SHARED_VAULT_USERS_DIRECT_CALL_IDS = [
  'sync.shared-vault-users.get-users',
  'sync.shared-vault-users.remove-user',
  'sync.shared-vault-users.designate-survivor',
]

describe('shared-vault DirectCall registration (gateway ↔ syncing-server identifier contract)', () => {
  /**
   * A stand-in for any positional constructor dependency. The registration block binds
   * `this.<method>.bind(this)` without invoking it, so only the ControllerContainer argument and the
   * existence of the handler methods decide whether an identifier resolves at boot.
   */
  const anyDep = {} as never

  it('registers the 4 shared-vault identifiers the gateway resolves', () => {
    const controllerContainer = new ControllerContainer()

    new BaseSharedVaultsController(
      anyDep, // 1 getSharedVaultsUseCase
      anyDep, // 2 createSharedVaultUseCase
      anyDep, // 3 deleteSharedVaultUseCase
      anyDep, // 4 createSharedVaultFileValetTokenUseCase
      anyDep, // 5 sharedVaultHttpMapper
      anyDep, // 6 sharedVaultUserHttpMapper
      controllerContainer,
    )

    for (const identifier of SHARED_VAULTS_DIRECT_CALL_IDS) {
      expect(controllerContainer.get(identifier)).toBeDefined()
    }
  })

  it('registers the 11 shared-vault-invite identifiers the gateway resolves', () => {
    const controllerContainer = new ControllerContainer()

    new BaseSharedVaultInvitesController(
      anyDep, // 1 inviteUserToSharedVaultUseCase
      anyDep, // 2 updateSharedVaultInviteUseCase
      anyDep, // 3 acceptSharedVaultInviteUseCase
      anyDep, // 4 declineSharedVaultInviteUseCase
      anyDep, // 5 deleteSharedVaultInvitesToUserUseCase
      anyDep, // 6 deleteSharedVaultInvitesSentByUserUseCase
      anyDep, // 7 getSharedVaultInvitesSentByUserUseCase
      anyDep, // 8 getSharedVaultInvitesSentToUserUseCase
      anyDep, // 9 sharedVaultInviteHttpMapper
      controllerContainer,
    )

    for (const identifier of SHARED_VAULT_INVITES_DIRECT_CALL_IDS) {
      expect(controllerContainer.get(identifier)).toBeDefined()
    }
  })

  it('registers the 3 shared-vault-user identifiers the gateway resolves', () => {
    const controllerContainer = new ControllerContainer()

    new BaseSharedVaultUsersController(
      anyDep, // 1 getSharedVaultUsersUseCase
      anyDep, // 2 removeUserFromSharedVaultUseCase
      anyDep, // 3 designateSurvivorUseCase
      anyDep, // 4 sharedVaultUserHttpMapper
      controllerContainer,
    )

    for (const identifier of SHARED_VAULT_USERS_DIRECT_CALL_IDS) {
      expect(controllerContainer.get(identifier)).toBeDefined()
    }
  })

  it('registers nothing at all when no ControllerContainer is supplied (the multi-container path)', () => {
    const controllerContainer = new ControllerContainer()

    new BaseSharedVaultsController(anyDep, anyDep, anyDep, anyDep, anyDep, anyDep)
    new BaseSharedVaultUsersController(anyDep, anyDep, anyDep, anyDep)

    // Precondition: this container was never passed to a controller, so a non-empty result would mean
    // the assertions above were reading registrations made by something other than the constructor.
    for (const identifier of [...SHARED_VAULTS_DIRECT_CALL_IDS, ...SHARED_VAULT_USERS_DIRECT_CALL_IDS]) {
      expect(controllerContainer.get(identifier)).toBeUndefined()
    }
  })
})
