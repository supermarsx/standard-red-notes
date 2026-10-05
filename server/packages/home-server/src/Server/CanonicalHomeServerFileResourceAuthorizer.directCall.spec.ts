import type { Request, Response } from 'express'
import {
  ControllerContainer,
  ServiceContainer,
  ServiceIdentifier,
  type ControllerContainerInterface,
  type ServiceConfiguration,
  type ServiceInterface,
} from '@standardnotes/domain-core'
import type { SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import {
  CanonicalHomeServerFileResourceAuthorizer,
  type HomeServerCrossServiceToken,
  type HomeServerPersonalValetToken,
  type HomeServerSessionValidationPort,
  type HomeServerSharedVaultValetToken,
} from './CanonicalHomeServerFileResourceAuthorizer'

/**
 * The bundled single-container FILES_V1 composition, end to end in-process:
 *
 *   CanonicalHomeServerFileResourceAuthorizer
 *     -> ServiceContainer -> Service.handleRequest -> ControllerContainer
 *       -> the canonical valet-token controller method, entered with the
 *          Request/Response the AUTHORIZER fabricates (no Express, no
 *          middleware, no socket).
 *
 * Everything on that chain is the real class but the controller methods, and
 * those are BEHAVIOURAL stand-ins: each performs exactly the `request` and
 * `response` operations its canonical counterpart performs
 * (`auth/src/Infra/InversifyExpressUtils/Base/BaseValetTokenController.ts`,
 * `syncing-server/src/Infra/InversifyExpressUtils/Base/BaseSharedVaultsController.ts`)
 * PLUS the one line those files already carry in `createSharedVault` /
 * `deleteSharedVault`:
 *
 *   response.setHeader('x-invalidate-cache', locals.user.uuid)
 *
 * REGRESSION. `callService` used to fabricate `{ locals } as unknown as
 * Response & never` -- an object with no methods at all. The two methods it
 * reaches happen to touch nothing but `response.locals`, so the lane worked;
 * the FIRST `setHeader` added to either (and both sit beside siblings that
 * already stamp one) would have thrown
 *
 *   TypeError: response.setHeader is not a function
 *
 * AFTER the valet token was minted. `authorize` catches every non-credential
 * error and answers `undefined`, so the files lane would have denied a legal
 * transfer with no attributable reason, on the single container only. That is
 * the sync lane's `e2e87e10` defect exactly, which failed 100 % of `SYNC_ITEMS`
 * on that topology. Each test below therefore asserts BOTH halves: the mint
 * really happened, AND the authorization survived the header stamp that
 * follows it.
 *
 * The pre-existing spec cannot see this: its services are
 * `jest.fn().mockResolvedValue(...)` doubles that never touch the response at
 * all.
 */

const USER_UUID = '11111111-1111-4111-8111-111111111111'
const SESSION_UUID = '22222222-2222-4222-8222-222222222222'
const FILE_UUID = '33333333-3333-4333-8333-333333333333'
const VAULT_UUID = '44444444-4444-4444-8444-444444444444'
const OWNER_UUID = '55555555-5555-4555-8555-555555555555'
const UPLOAD_BYTES_LIMIT = 1_000

const identity: SyncTicketIdentity = {
  userUuid: USER_UUID,
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: 'Bearer session-token',
}

const personalResource = {
  ownershipType: 'user' as const,
  fileUuid: FILE_UUID,
  remoteIdentifier: FILE_UUID,
}

const sharedResource = {
  ownershipType: 'shared-vault' as const,
  fileUuid: FILE_UUID,
  remoteIdentifier: FILE_UUID,
  sharedVaultUuid: VAULT_UUID,
  sharedVaultOwnerUuid: OWNER_UUID,
}

/** The locals shape the authorizer's `responseLocals()` projects out of the token. */
type DirectCallLocals = {
  user: { uuid: string }
  readOnlyAccess: boolean
  sharedVaultOwnerContext?: { upload_bytes_limit: number }
}

type ControllerResult = { statusCode: number; json: Record<string, unknown> }
type ControllerMethod = (request: Request, response: Response) => Promise<ControllerResult>

/** `ControllerContainerInterface.register` is declared over `never` arguments. */
type ControllerBinding = Parameters<ControllerContainerInterface['register']>[1]

/**
 * Verbatim `Service.handleRequest` from `auth/src/Bootstrap/Service.ts` and
 * `syncing-server/src/Bootstrap/Service.ts`: look the registered method up in
 * the controller container and call it with what the caller handed over. No
 * Express, no middleware, nothing in between -- which is the whole reason a
 * fabricated response reaches a controller intact.
 */
class CanonicalService implements ServiceInterface {
  constructor(
    private readonly identifier: string,
    private readonly controllerContainer: ControllerContainerInterface,
  ) {}

  async handleRequest(request: never, response: never, endpointOrMethodIdentifier: string): Promise<unknown> {
    const method = this.controllerContainer.get(endpointOrMethodIdentifier)

    if (!method) {
      throw new Error(`Method ${endpointOrMethodIdentifier} not found`)
    }

    return method(request, response)
  }

  getContainer(_configuration?: ServiceConfiguration): Promise<unknown> {
    return Promise.resolve(undefined)
  }

  getId(): ServiceIdentifier {
    return ServiceIdentifier.create(this.identifier).getValue()
  }
}

/** What a controller stand-in observed, so a test can prove the mint ran. */
type MintRecord = {
  method: string
  locals: DirectCallLocals
  parameters: Record<string, unknown>
  response: Response
}

function compose(options: { readOnlyAccess?: boolean; stampCacheInvalidation?: boolean } = {}): {
  mints: MintRecord[]
  authorizer: CanonicalHomeServerFileResourceAuthorizer
} {
  const stampCacheInvalidation = options.stampCacheInvalidation !== false
  const mints: MintRecord[] = []
  const controllers = new ControllerContainer()

  /**
   * `BaseValetTokenController.create`, reproduced: read `response.locals`,
   * refuse a write on a read-only session, mint, answer `this.json(...)`.
   */
  const createValetToken: ControllerMethod = async (request, response) => {
    const locals = response.locals as DirectCallLocals
    const payload = request.body as { operation: string; resources: HomeServerPersonalValetToken['permittedResources'] }

    if (locals.readOnlyAccess && payload.operation !== 'read') {
      return { statusCode: 401, json: { error: { tag: 'read-only-access' } } }
    }

    const claims: HomeServerPersonalValetToken = {
      userUuid: locals.user.uuid,
      permittedOperation: payload.operation,
      permittedResources: payload.resources,
      uploadBytesUsed: 100,
      uploadBytesLimit: UPLOAD_BYTES_LIMIT,
    }
    mints.push({ method: 'auth.valet-tokens.create', locals, parameters: { ...payload }, response })

    // THE HAZARD LINE. Not invented for this test: `BaseAuthController`,
    // `BaseSessionController`, `BaseSettingsController`, `BaseUsersController`
    // and `BaseSubscriptionInvitesController` all stamp exactly this on auth,
    // one line after the write they are reporting.
    if (stampCacheInvalidation) {
      response.setHeader('x-invalidate-cache', locals.user.uuid)
    }

    return { statusCode: 200, json: { success: true, valetToken: JSON.stringify(claims) } }
  }

  /**
   * `BaseSharedVaultsController.createValetTokenForSharedVaultFile`,
   * reproduced: `response.locals` for the user and the owner's upload limit,
   * `request.params.sharedVaultUuid` and the snake_case body for the rest.
   */
  const createSharedVaultFileValetToken: ControllerMethod = async (request, response) => {
    const locals = response.locals as DirectCallLocals
    const body = request.body as Record<string, unknown>

    const claims: HomeServerSharedVaultValetToken = {
      sharedVaultUuid: request.params.sharedVaultUuid as string,
      vaultOwnerUuid: OWNER_UUID,
      permittedOperation: body.operation as string,
      remoteIdentifier: body.remote_identifier as string,
      ...(typeof body.unencrypted_file_size === 'number' ? { unencryptedFileSize: body.unencrypted_file_size } : {}),
      uploadBytesUsed: 100,
      uploadBytesLimit: locals.sharedVaultOwnerContext?.upload_bytes_limit,
    }
    mints.push({
      method: 'sync.shared-vaults.create-file-valet-token',
      locals,
      parameters: { ...body, sharedVaultUuid: request.params.sharedVaultUuid },
      response,
    })

    // The sibling line, verbatim: `createSharedVault` and `deleteSharedVault`
    // in this very class already run it.
    if (stampCacheInvalidation) {
      response.setHeader('x-invalidate-cache', locals.user.uuid)
    }

    return { statusCode: 200, json: { valetToken: JSON.stringify(claims) } }
  }

  controllers.register('auth.valet-tokens.create', createValetToken as ControllerBinding)
  controllers.register(
    'sync.shared-vaults.create-file-valet-token',
    createSharedVaultFileValetToken as ControllerBinding,
  )

  const services = new ServiceContainer()
  for (const name of [ServiceIdentifier.NAMES.Auth, ServiceIdentifier.NAMES.SyncingServer]) {
    const service = new CanonicalService(name, controllers)
    services.register(service.getId(), service)
  }

  const token: HomeServerCrossServiceToken = {
    user: { uuid: USER_UUID },
    roles: [],
    session: { uuid: SESSION_UUID, readonly_access: options.readOnlyAccess === true },
    belongs_to_shared_vaults: [{ shared_vault_uuid: VAULT_UUID, permission: 'write' }],
    shared_vault_owner_context: { upload_bytes_limit: UPLOAD_BYTES_LIMIT },
  }

  const sessionValidator: HomeServerSessionValidationPort = {
    validateSession: async () => ({ status: 200, data: { authToken: 'fresh-auth-token' } }),
  }

  return {
    mints,
    authorizer: new CanonicalHomeServerFileResourceAuthorizer({
      sessionValidator,
      services,
      authTokenDecoder: { decodeToken: () => token },
      // A real decoder of what the controller above really signed, so a claim
      // the controller never produced cannot be asserted into existence.
      valetTokenDecoder: {
        decodeToken: (value: string) =>
          JSON.parse(value) as HomeServerPersonalValetToken | HomeServerSharedVaultValetToken,
      },
    }),
  }
}

describe('CanonicalHomeServerFileResourceAuthorizer over the direct-call service container', () => {
  it('authorizes a personal upload through a controller that stamps a response header after minting', async () => {
    const { authorizer, mints } = compose()

    await expect(
      authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ storageOwnerUuid: USER_UUID })

    // The mint is the side effect that precedes the stamp: were the stamp to
    // throw, the token would already exist and the caller would still be told
    // nothing but "denied".
    expect(mints).toHaveLength(1)
    expect(mints[0].method).toBe('auth.valet-tokens.create')
    expect(mints[0].parameters).toEqual({
      operation: 'write',
      resources: [{ remoteIdentifier: FILE_UUID, unencryptedFileSize: 100 }],
    })
  })

  it('authorizes a shared-vault download through a controller that stamps a response header after minting', async () => {
    const { authorizer, mints } = compose()

    await expect(
      authorizer.authorize({ identity, resource: sharedResource, operation: 'download' }, new AbortController().signal),
    ).resolves.toEqual({ storageOwnerUuid: VAULT_UUID })

    expect(mints).toHaveLength(1)
    expect(mints[0].method).toBe('sync.shared-vaults.create-file-valet-token')
    expect(mints[0].parameters).toEqual({
      sharedVaultUuid: VAULT_UUID,
      file_uuid: FILE_UUID,
      remote_identifier: FILE_UUID,
      operation: 'read',
    })
    // The owner's quota reaches the use case through `response.locals`, so the
    // response has to carry both halves: the locals AND a usable header sink.
    expect(mints[0].locals.sharedVaultOwnerContext).toEqual({ upload_bytes_limit: UPLOAD_BYTES_LIMIT })
  })

  it('hands the controller a header sink whose writes read back', async () => {
    const { authorizer, mints } = compose()

    await authorizer.authorize(
      { identity, resource: personalResource, operation: 'download' },
      new AbortController().signal,
    )

    expect(mints).toHaveLength(1)
    const response = mints[0].response
    expect((response.locals as DirectCallLocals).user.uuid).toBe(USER_UUID)
    // A sink that swallowed every write would tell a controller branching on
    // its own header "unset" -- the quieter half of the same defect.
    expect(response.getHeader('x-invalidate-cache')).toBe(USER_UUID)
    expect(response.getHeader('X-Invalidate-Cache')).toBe(USER_UUID)
    expect(response.hasHeader('x-invalidate-cache')).toBe(true)
    expect(response.getHeaderNames()).toEqual(['x-invalidate-cache'])
    response.removeHeader('X-Invalidate-Cache')
    expect(response.hasHeader('x-invalidate-cache')).toBe(false)
    expect(response.getHeaderNames()).toEqual([])
  })

  it('still carries a controller refusal through as a denial', async () => {
    // A read-only session: `BaseValetTokenController.create` answers 401 BEFORE
    // it mints or stamps, so the authorizer must deny without a valet token --
    // the refusal path must stay distinguishable from the fabrication defect.
    const { authorizer, mints } = compose({ readOnlyAccess: true })

    await expect(
      authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    expect(mints).toHaveLength(0)
  })

  it('authorizes identically when the controller stamps no header at all', async () => {
    // Today's real methods touch nothing but `response.locals`. Pinning that
    // too keeps this spec a statement about the RESPONSE rather than about one
    // controller's current body.
    const { authorizer, mints } = compose({ stampCacheInvalidation: false })

    await expect(
      authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ storageOwnerUuid: USER_UUID })
    expect(mints).toHaveLength(1)
    expect(mints[0].response.getHeaderNames()).toEqual([])
  })
})
