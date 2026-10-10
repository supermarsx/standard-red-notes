import 'reflect-metadata'

import * as fs from 'fs'
import * as path from 'path'
import { Request, Response } from 'express'
import { getControllerMethodMetadata } from 'inversify-express-utils'

import { SharedVaultUsersController } from './SharedVaultUsersController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolver } from '../../Service/Resolver/EndpointResolver'

/**
 * Standard Red Notes: the PATCH that changes a shared-vault member's permission.
 *
 * Three things have to hold here, and the first two have each already shipped broken in
 * this tree:
 *
 *  1. The BODY must be forwarded as the proxy's fourth argument. On the bundled single
 *     container the bound proxy is `DirectCallServiceProxy`, which does NOT read the
 *     Express request's parsed body -- it merges the payload it is handed. A controller
 *     that omits the argument sends `{ permission: undefined }` and the use case refuses
 *     a permission the caller DID supply. `SessionsController.deleteSession` and
 *     `CollaborationAuthorizationService` were both broken exactly this way.
 *  2. The identifier must be the one the syncing-server registers, because on the single
 *     container that string IS the routing and an unknown one answers 500 "Method not
 *     found".
 *  3. The route must be PATCH on the member resource. The same path with DELETE evicts
 *     the member; a verb slip turns "make them read-only" into "throw them out".
 *
 * The real `EndpointResolver` is used rather than a stub, so the identifier asserted is
 * the one the gateway will actually resolve at runtime.
 */
describe('SharedVaultUsersController permission change', () => {
  let serviceProxy: ServiceProxyInterface

  const createController = () => new SharedVaultUsersController(serviceProxy, new EndpointResolver(true))

  const request = (body: unknown): Request =>
    ({
      params: { sharedVaultUuid: 'vault-1', userUuid: 'user-1' },
      body,
    }) as unknown as Request

  beforeEach(() => {
    serviceProxy = {} as jest.Mocked<ServiceProxyInterface>
    serviceProxy.callSyncingServer = jest.fn()
  })

  it('forwards the permission body to the syncing-server as the payload argument', async () => {
    await createController().updateSharedVaultUserPermission(
      request({ permission: 'write' }),
      {} as unknown as Response,
    )

    expect(serviceProxy.callSyncingServer).toHaveBeenCalledTimes(1)
    const call = (serviceProxy.callSyncingServer as jest.Mock).mock.calls[0]
    expect(call[2]).toEqual('sync.shared-vault-users.update-permission')
    // The payload argument, not merely "something truthy": the single container reads the
    // permission from exactly here.
    expect(call[3]).toEqual({ permission: 'write' })
  })

  it('passes a demotion through unchanged -- the gateway never interprets the permission', async () => {
    await createController().updateSharedVaultUserPermission(request({ permission: 'read' }), {} as unknown as Response)

    expect((serviceProxy.callSyncingServer as jest.Mock).mock.calls[0][3]).toEqual({ permission: 'read' })
  })

  /**
   * The runtime route metadata in this vendored `inversify-express-utils` records the
   * handler, its path and its middleware, but NOT the verb -- so the verb is read from the
   * `@httpX` decorator in the source and cross-checked against the runtime metadata, the
   * same two-view approach `AdminController.routing.spec.ts` uses. Neither view can drift
   * without failing: a handler the parse misses fails the completeness assertion, and a
   * verb the parse disagrees with fails the assertions above it.
   */
  const verbByHandler = ((): Map<string, string> => {
    const source = fs.readFileSync(path.join(__dirname, 'SharedVaultUsersController.ts'), 'utf-8')
    const declarations = source.matchAll(
      /@http(Get|Post|Put|Delete|Patch)\(\s*'([^']*)'[\s\S]*?\n\s*(?:private |public )?(?:async )?(\w+)\(/g,
    )

    return new Map([...declarations].map((match) => [match[3], `${match[1].toLowerCase()}:${match[2]}`]))
  })()

  it('is declared as PATCH on the member resource, and the removal is still DELETE', () => {
    expect(verbByHandler.get('updateSharedVaultUserPermission')).toEqual('patch:/:userUuid')
    // Contrast, so "patch" above is a real discriminator rather than the only verb present:
    // the SAME path under DELETE evicts the member from the vault.
    expect(verbByHandler.get('removeUserFromSharedVault')).toEqual('delete:/:userUuid')
    expect(verbByHandler.get('getSharedVaultUsers')).toEqual('get:/')
  })

  it('parses a verb for every route the controller actually registers', () => {
    const registeredHandlers = getControllerMethodMetadata(SharedVaultUsersController as never)
      .map((entry) => String(entry.key))
      .sort()

    expect(registeredHandlers).toEqual([...verbByHandler.keys()].sort())
    // Precondition: the permission route is one of them, so this is not an empty-set match.
    expect(registeredHandlers).toContain('updateSharedVaultUserPermission')
  })
})
