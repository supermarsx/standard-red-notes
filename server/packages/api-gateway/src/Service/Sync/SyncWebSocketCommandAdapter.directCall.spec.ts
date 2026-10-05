import jwt from 'jsonwebtoken'
import type { Request, Response } from 'express'
import { ServiceContainer, ServiceIdentifier } from '@standardnotes/domain-core'
import type { SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { DirectCallSyncCommandPort } from './DirectCallSyncCommandPort'
import { SyncWebSocketCommandAdapter } from './SyncWebSocketCommandAdapter'

/**
 * The bundled single-container composition, end to end inside the gateway:
 *
 *   SyncWebSocketCommandAdapter  ->  DirectCallSyncCommandPort  ->  the
 *   syncing-server controller, entered in-process with the Request/Response
 *   the adapter FABRICATES (no Express, no middleware, no socket).
 *
 * The two collaborators are the real classes. Only the syncing service is a
 * double, and it is a BEHAVIOURAL one: it performs exactly the `response`
 * operations `BaseItemsController` performs on each of its answer paths
 * (`syncing-server/src/Infra/InversifyExpressUtils/Base/BaseItemsController.ts`
 * -- `setHeader('X-Sync-Command-Status'|'X-Sync-Command-Replayed')` after the
 * durable write commits, `setHeader('Retry-After')` for a pending command).
 *
 * Regression: the adapter used to fabricate `{ locals } as unknown as Response`,
 * so that first `setHeader` threw `TypeError: response.setHeader is not a
 * function` with the items ALREADY persisted. The controller caught its own
 * TypeError, answered 503, and the socket reported `BACKEND_ERROR` -- for every
 * single `SYNC_ITEMS` command on the single container, a lane that advertises
 * the capability on every AUTHENTICATED frame. Both existing specs were blind
 * to it: the adapter's spec supplies its own `DurableSyncCommandPort` double
 * that never touches the response, and the port's spec is handed a response the
 * TEST built rather than the one the adapter builds.
 */

const JWT_SECRET = 'direct-call-response-secret'
const DIGEST = 'a'.repeat(64)

const identity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer session-token',
}

function authToken(): string {
  return jwt.sign(
    {
      user: { uuid: 'user-1', email: 'user@example.test' },
      session: { uuid: 'session-1', readonly_access: false },
      roles: [{ name: 'CORE_USER' }],
      belongs_to_shared_vaults: [],
      hasContentLimit: false,
      live_sync_enabled: true,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

type DirectCallResult = { statusCode: number; json: Record<string, unknown> }

/**
 * Composes the real adapter onto the real direct-call port, with `handler`
 * standing in for the controller method the port resolves out of the service
 * container.
 */
function compose(handler: (request: Request, response: Response, method: string) => DirectCallResult): {
  adapter: SyncWebSocketCommandAdapter
  responses: Response[]
} {
  const responses: Response[] = []
  const services = new ServiceContainer()
  services.register(ServiceIdentifier.create(ServiceIdentifier.NAMES.SyncingServer).getValue(), {
    handleRequest: async (request: Request, response: Response, method: string): Promise<DirectCallResult> => {
      responses.push(response)
      return handler(request, response, method)
    },
  } as never)

  const serviceProxy = {
    validateSession: jest.fn(async () => ({
      status: 200,
      data: { authToken: authToken() },
      headers: { contentType: 'application/json' },
    })),
  } as unknown as ServiceProxyInterface

  return {
    adapter: new SyncWebSocketCommandAdapter(serviceProxy, new DirectCallSyncCommandPort(services), JWT_SECRET),
    responses,
  }
}

/** Verbatim shape of the committed path in `BaseItemsController.sync`. */
function committedController(request: Request, response: Response): DirectCallResult {
  response.setHeader('X-Sync-Command-Status', 'committed')
  response.setHeader('X-Sync-Command-Replayed', 'false')
  const body = request.body as { command?: { id?: string; digest?: string } }
  return {
    statusCode: 200,
    json: {
      saved_items: [{ uuid: 'note-1' }],
      retrieved_items: [],
      command: { id: body.command?.id, digest: body.command?.digest, status: 'committed' },
    },
  }
}

const savePayload = {
  command: 'SYNC_ITEMS',
  body: { api: '20200115', items: [{ uuid: 'note-1', content_type: 'Note' }] },
}

describe('SyncWebSocketCommandAdapter over the direct-call port', () => {
  it('commits a SYNC_ITEMS save through a controller that stamps response headers', async () => {
    const { adapter } = compose(committedController)

    await expect(
      adapter.execute(
        { identity, commandId: 'device-1:command-1', digest: DIGEST, payload: savePayload },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      digest: DIGEST,
      payload: {
        saved_items: [{ uuid: 'note-1' }],
        retrieved_items: [],
        command: { id: 'device-1:command-1', digest: DIGEST, status: 'committed' },
      },
    })
  })

  it('carries the session locals AND a usable header sink into the controller', async () => {
    const { adapter, responses } = compose(committedController)

    await adapter.execute(
      { identity, commandId: 'device-1:command-2', digest: DIGEST, payload: savePayload },
      new AbortController().signal,
    )

    expect(responses).toHaveLength(1)
    const response = responses[0] as Response
    expect(response.locals.user.uuid).toBe('user-1')
    // A header the controller wrote must read back: a sink that swallowed every
    // write would silently tell a controller branching on its own header "unset".
    expect(response.getHeader('X-Sync-Command-Status')).toBe('committed')
    expect(response.hasHeader('x-sync-command-replayed')).toBe(true)
    expect(response.getHeaderNames()).toEqual(['x-sync-command-status', 'x-sync-command-replayed'])
    response.removeHeader('X-Sync-Command-Status')
    expect(response.getHeader('X-Sync-Command-Status')).toBeUndefined()
    expect(response.getHeaderNames()).toEqual(['x-sync-command-replayed'])
  })

  it('reaches the status controller with the same fabricated response', async () => {
    const { adapter, responses } = compose((request, response, method) => {
      expect(method).toBe('sync.items.sync_command_status')
      // `syncCommandError` stamps Retry-After on a pending command; a status
      // lookup that answers pending must not die on the fabricated response.
      response.setHeader('Retry-After', '1')
      return {
        statusCode: 200,
        json: { command: { id: request.params.commandId, digest: DIGEST, status: 'accepted' } },
      }
    })

    await expect(
      adapter.status({ identity, commandId: 'device-1:command-3', digest: DIGEST }, new AbortController().signal),
    ).resolves.toEqual({ status: 'ACCEPTED', digest: DIGEST })
    expect((responses[0] as Response).getHeader('retry-after')).toBe('1')
  })

  it('reports a controller refusal as a failure rather than a thrown TypeError', async () => {
    const { adapter } = compose((_request, response) => {
      response.setHeader('Retry-After', '1')
      return { statusCode: 409, json: { error: { code: 'sync_command_pending' } } }
    })

    await expect(
      adapter.execute(
        { identity, commandId: 'device-1:command-4', digest: DIGEST, payload: savePayload },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Durable sync command failed.')
  })
})
