import 'reflect-metadata'

import type { Request, Response } from 'express'
import {
  ControllerContainer,
  ServiceContainer,
  ServiceIdentifier,
  type ControllerContainerInterface,
  type ServiceConfiguration,
  type ServiceInterface,
} from '@standardnotes/domain-core'

import { DirectCallServiceProxy } from './DirectCallServiceProxy'
import { SessionsController } from '../../Controller/v1/SessionsController'
import { EndpointResolver } from '../Resolver/EndpointResolver'
import { createDirectCallRequest } from '../Sync/DirectCallRequest'

/**
 * THE SINGLE-CONTAINER PAYLOAD LANE, END TO END IN-PROCESS:
 *
 *   SessionsController (api-gateway)
 *     -> DirectCallServiceProxy.callAuthServer(request, response, id, payload)
 *       -> ServiceContainer -> Service.handleRequest -> ControllerContainer
 *         -> the auth controller method, entered with the Request the PROXY
 *            hands over (no Express, no middleware, no HTTP).
 *
 * Everything on that chain is the real class but the auth controller methods,
 * and those are BEHAVIOURAL stand-ins that read exactly the fields their
 * canonical counterparts read:
 *   `auth/src/Infra/InversifyExpressUtils/Base/BaseSessionController.ts`
 *   `auth/src/Infra/InversifyExpressUtils/Base/BaseValetTokenController.ts`
 *
 * WHY THIS FILE EXISTS. `callAuthServer` declared THREE parameters against the
 * interface's FOUR and discarded `payload` -- the same shape as `6e18e3a5`'s
 * `callSyncingServer`, one method over. TypeScript accepts a narrower
 * implementation, so build, lint and the whole suite stayed green, and the
 * pre-existing `DirectCallServiceProxy.spec.ts` asserts the forwarded request
 * with `expect.anything()`, which passes over a proxy that throws the body
 * away.
 *
 * MEASURED LIVE, before the fix, on two containers built from the same tree --
 * `DELETE /v1/sessions/:uuid` with the uuid ONLY in the path:
 *
 *   single container (DirectCallServiceProxy):  500, the session SURVIVES
 *   compose           (HttpServiceProxy):       204, the session is gone
 *
 * The 500 is `TypeError: Cannot read properties of undefined (reading 'uuid')`
 * in the container log: `request.body` is `undefined` for a bodyless DELETE
 * under Express 5, and with the payload discarded that is what
 * `BaseSessionController.deleteSession` read. With an empty `{}` body it
 * degraded to `400 Please provide the session identifier.` instead -- a refusal
 * naming a parameter the caller HAD supplied.
 *
 * SCORING. No check here passes because an error failed to appear. Each one
 * names the field the receiving controller read and the status it answered, and
 * the "no payload" cases assert OBJECT IDENTITY with the request that went in,
 * so a fix that reshapes every request would fail them too.
 */

const USER_UUID = '11111111-1111-4111-8111-111111111111'
const CURRENT_SESSION_UUID = '22222222-2222-4222-8222-222222222222'
const OTHER_SESSION_UUID = '33333333-3333-4333-8333-333333333333'
const FILE_UUID = '44444444-4444-4444-8444-444444444444'

type ControllerResult = { statusCode: number; json: Record<string, unknown> }

/** `ControllerContainerInterface.register` is declared over `never` arguments. */
type ControllerBinding = Parameters<ControllerContainerInterface['register']>[1]

/** The locals `RequiredCrossServiceTokenMiddleware` leaves for the auth controller. */
type AuthLocals = {
  user: { uuid: string }
  session: { uuid: string }
  readOnlyAccess: boolean
  roles: Array<{ name: string }>
}

/**
 * Verbatim `Service.handleRequest` from `auth/src/Bootstrap/Service.ts`: look
 * the registered method up in the controller container and call it with what
 * the caller handed over. No Express, no middleware, nothing in between.
 */
class CanonicalAuthService implements ServiceInterface {
  constructor(private readonly controllerContainer: ControllerContainerInterface) {}

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
    return ServiceIdentifier.create(ServiceIdentifier.NAMES.Auth).getValue()
  }
}

/** What an auth controller stand-in actually observed. */
type Observation = {
  methodIdentifier: string
  body: unknown
  request: Request
}

type Composition = {
  proxy: DirectCallServiceProxy
  controller: SessionsController
  observations: Observation[]
  revoked: string[]
  sent: Array<{ status: number; payload: unknown }>
  response: Response
  locals: AuthLocals
}

function compose(options: { readOnlyAccess?: boolean } = {}): Composition {
  const observations: Observation[] = []
  const revoked: string[] = []
  const sent: Array<{ status: number; payload: unknown }> = []
  const controllers = new ControllerContainer()

  const locals: AuthLocals = {
    user: { uuid: USER_UUID },
    session: { uuid: CURRENT_SESSION_UUID },
    readOnlyAccess: options.readOnlyAccess === true,
    roles: [{ name: 'CORE_USER' }],
  }

  /**
   * `BaseSessionController.deleteSession`, reproduced field for field: the
   * read-only refusal, the `!request.body.uuid` refusal, the current-session
   * refusal, the revocation, and the `x-invalidate-cache` stamp that follows it.
   */
  const deleteSession = async (request: Request, response: Response): Promise<ControllerResult> => {
    const observed = response.locals as AuthLocals
    observations.push({ methodIdentifier: 'auth.sessions.delete', body: request.body, request })

    if (observed.readOnlyAccess) {
      return { statusCode: 401, json: { error: { tag: 'read-only-access' } } }
    }
    // The exact expression that read `undefined` on this topology. A bodyless
    // DELETE leaves `request.body` undefined under Express 5, so this THROWS
    // rather than refusing politely -- which is the live 500.
    if (!request.body.uuid || !observed.session) {
      return { statusCode: 400, json: { error: { message: 'Please provide the session identifier.' } } }
    }
    if (request.body.uuid === observed.session.uuid) {
      return { statusCode: 400, json: { error: { message: 'You can not delete your current session.' } } }
    }
    revoked.push(request.body.uuid as string)
    response.setHeader('x-invalidate-cache', observed.user.uuid)
    return { statusCode: 204, json: {} }
  }

  /**
   * `BaseValetTokenController.create`, reproduced: the whole mint is driven by
   * `request.body`, which is the shape
   * `ValetTokenFileResourceAuthorizer.authorizePersonalResource` supplies ONLY
   * as the proxy's fourth argument.
   */
  const createValetToken = async (request: Request, response: Response): Promise<ControllerResult> => {
    const observed = response.locals as AuthLocals
    observations.push({ methodIdentifier: 'auth.valet-tokens.create', body: request.body, request })

    const payload = request.body as { operation?: string; resources?: Array<{ remoteIdentifier: string }> }
    if (!payload.operation || !Array.isArray(payload.resources) || payload.resources.length === 0) {
      return { statusCode: 400, json: { error: { message: 'Please provide the operation and the resources.' } } }
    }
    return {
      statusCode: 200,
      json: {
        valetToken: JSON.stringify({
          userUuid: observed.user.uuid,
          permittedOperation: payload.operation,
          permittedResources: payload.resources,
        }),
      },
    }
  }

  controllers.register('auth.sessions.delete', deleteSession as unknown as ControllerBinding)
  controllers.register('auth.valet-tokens.create', createValetToken as unknown as ControllerBinding)

  const services = new ServiceContainer()
  services.register(
    ServiceIdentifier.create(ServiceIdentifier.NAMES.Auth).getValue(),
    new CanonicalAuthService(controllers),
  )

  const proxy = new DirectCallServiceProxy(services, 'http://files')

  const response = {
    locals,
    setHeader: (): void => {},
    status: (status: number) => ({
      send: (payload: unknown): void => {
        sent.push({ status, payload })
      },
    }),
  } as unknown as Response

  return {
    proxy,
    controller: new SessionsController(proxy, new EndpointResolver(true)),
    observations,
    revoked,
    sent,
    response,
    locals,
  }
}

/** The request Express hands a controller for `DELETE /v1/sessions/:uuid`. */
const deleteRequest = (sessionUuid: string, body?: unknown): Request =>
  createDirectCallRequest({
    method: 'DELETE',
    url: `/v1/sessions/${sessionUuid}`,
    params: { uuid: sessionUuid },
    headers: { 'x-snjs-version': '2.200.1' },
    // `createDirectCallRequest` defaults an unstated body to `{}`; `null` is
    // how this spec states "Express left no body on this request at all",
    // which is what Express 5 does for a DELETE with no payload.
    body: body === undefined ? null : body,
  })

const dataOf = (sent: Array<{ status: number; payload: unknown }>): Record<string, unknown> =>
  (sent[0]?.payload as { data: Record<string, unknown> }).data

describe('DirectCallServiceProxy.callAuthServer forwards the payload to the auth controller', () => {
  describe('DELETE /v1/sessions/:uuid -- the uuid exists ONLY as the payload', () => {
    it('the auth controller observes request.body.uuid when the gateway request has NO body', async () => {
      const { controller, observations, response } = compose()

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID), response)

      expect(observations).toHaveLength(1)
      expect(observations[0].methodIdentifier).toBe('auth.sessions.delete')
      expect(observations[0].body).toEqual({ uuid: OTHER_SESSION_UUID })
    })

    it('revokes the named session and answers 204 through the whole in-process chain', async () => {
      const { controller, revoked, sent, response } = compose()

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID), response)

      expect(revoked).toEqual([OTHER_SESSION_UUID])
      expect(sent).toHaveLength(1)
      expect(sent[0].status).toBe(204)
    })

    it('refuses the CURRENT session by its uuid rather than for want of an identifier', async () => {
      // The live discriminator: these are two different 400s, and only the
      // second one means the payload arrived.
      const { controller, revoked, sent, response } = compose()

      await controller.deleteSession(deleteRequest(CURRENT_SESSION_UUID), response)

      expect(revoked).toEqual([])
      expect(sent[0].status).toBe(400)
      expect(dataOf(sent)).toEqual({ error: { message: 'You can not delete your current session.' } })
    })

    it('CONTROL: the same call works when the uuid is in the HTTP body, which no proxy can drop', async () => {
      const { controller, revoked, sent, response } = compose()

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID, { uuid: OTHER_SESSION_UUID }), response)

      expect(revoked).toEqual([OTHER_SESSION_UUID])
      expect(sent[0].status).toBe(204)
    })

    it('the payload WINS over an unrelated body the client happened to send', async () => {
      const { controller, observations, revoked, response } = compose()

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID, { uuid: 'not-the-path-uuid' }), response)

      expect(observations[0].body).toEqual({ uuid: OTHER_SESSION_UUID })
      expect(revoked).toEqual([OTHER_SESSION_UUID])
    })

    it('the forwarded request keeps the headers and params the controller may read', async () => {
      const { controller, observations, response } = compose()

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID), response)

      const forwarded = observations[0].request
      expect(forwarded.method).toBe('DELETE')
      expect(forwarded.params).toEqual({ uuid: OTHER_SESSION_UUID })
      expect(forwarded.headers['x-snjs-version']).toBe('2.200.1')
      expect(forwarded.get('X-Snjs-Version')).toBe('2.200.1')
    })

    it('still refuses a read-only session, so the payload did not buy a bypass', async () => {
      const { controller, revoked, sent, response } = compose({ readOnlyAccess: true })

      await controller.deleteSession(deleteRequest(OTHER_SESSION_UUID), response)

      expect(revoked).toEqual([])
      expect(sent[0].status).toBe(401)
    })
  })

  describe('POST valet-tokens -- the mint body exists ONLY as the payload', () => {
    /**
     * `ValetTokenFileResourceAuthorizer.authorizePersonalResource`'s call,
     * reproduced exactly. That composition runs only in the standalone
     * api-gateway process today (where the bound proxy is the HTTP or gRPC
     * one), so this is the LATENT half -- but it is latent because of a binding
     * in `Container.ts`, not because of anything in `callAuthServer`.
     */
    const mint = { operation: 'write', resources: [{ remoteIdentifier: FILE_UUID, unencryptedFileSize: 16 }] }

    it('the auth controller observes the whole mint body', async () => {
      const { proxy, observations, response } = compose()

      await proxy.callAuthServer(deleteRequest(FILE_UUID) as never, response as never, 'auth.valet-tokens.create', mint)

      expect(observations[0].methodIdentifier).toBe('auth.valet-tokens.create')
      expect(observations[0].body).toEqual(mint)
    })

    it('mints a token for the observed operation and resources', async () => {
      const { proxy, sent, response } = compose()

      await proxy.callAuthServer(deleteRequest(FILE_UUID) as never, response as never, 'auth.valet-tokens.create', mint)

      expect(sent[0].status).toBe(200)
      expect(JSON.parse((dataOf(sent) as { valetToken: string }).valetToken)).toEqual({
        userUuid: USER_UUID,
        permittedOperation: 'write',
        permittedResources: mint.resources,
      })
    })

    it('refuses the mint when the payload really is absent, instead of inventing one', async () => {
      const { proxy, observations, sent, response } = compose()

      await proxy.callAuthServer(deleteRequest(FILE_UUID, {}) as never, response as never, 'auth.valet-tokens.create')

      expect(observations[0].body).toEqual({})
      expect(sent[0].status).toBe(400)
    })
  })

  describe('a caller that passes no payload is left exactly as it was', () => {
    it.each([
      ['undefined', undefined],
      ['an empty object', {}],
      ['an empty string', ''],
    ])('callAuthServer forwards the request UNTOUCHED when the payload is %s', async (_label, payload) => {
      const { proxy, observations, response } = compose()
      const request = deleteRequest(OTHER_SESSION_UUID, { uuid: OTHER_SESSION_UUID })

      await proxy.callAuthServer(
        request as never,
        response as never,
        'auth.sessions.delete',
        payload as Record<string, unknown> | string | undefined,
      )

      // The same object, not a copy: no existing caller's request is reshaped.
      expect(observations[0].request).toBe(request)
    })
  })
})
