import 'reflect-metadata'

import * as fs from 'fs'
import * as path from 'path'
import { Request, Response } from 'express'
import { getControllerMethodMetadata } from 'inversify-express-utils'

import { AdminController } from './AdminController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: the /v1/admin routes that are pure pass-throughs to the auth
 * server's own /admin controller. Every one of them administers privileged state
 * (roles, bans, invite links, account deletion), so a handler pointed at the wrong
 * auth endpoint — or one that silently drops a path parameter — is a real security
 * bug: the action lands on a different resource than the route promises.
 *
 * Rather than restate each mapping (which would only mirror the source), these
 * tests assert the two INVARIANTS the whole pass-through layer must hold:
 *
 *   1. the resolved auth endpoint is exactly `admin` + the route's own path, and
 *   2. the positional parameters are the route's `:params`, in declaration order.
 *
 * Both are derived from the @httpX decorator, independently of the handler body,
 * so a handler that resolves a different endpoint or reorders its parameters goes
 * red here.
 */
describe('AdminController auth-server pass-through routes', () => {
  let serviceProxy: ServiceProxyInterface
  let endpointResolver: EndpointResolverInterface

  /**
   * Handlers that are answered by the gateway itself instead of being proxied to
   * the auth server. Listed explicitly so a NEW route is never silently treated
   * as gateway-local: the completeness test below fails if this list drifts.
   */
  const gatewayLocalHandlers = new Set([
    'getServerStatus',
    'listControllableServices',
    'restartContainer',
    'restartService',
    'stopService',
    'startService',
    'getLogs',
    'getServerSettings',
    'setServerSettings',
    'getAntiAbuse',
    'blockIp',
    'unblockIp',
    'allowIp',
    'unallowIp',
  ])

  const makeController = () =>
    new AdminController(serviceProxy, endpointResolver, true, false, undefined, {} as AssistantProviderConfig, '')

  const routeMetadata = getControllerMethodMetadata(AdminController as never)

  /**
   * The runtime metadata records the handler and path but not the HTTP verb, so
   * the verb is read from the @httpX decorator in the source. The completeness
   * test below cross-checks this parse against the runtime metadata, so the two
   * views cannot drift apart unnoticed.
   */
  const verbByHandler = ((): Map<string, string> => {
    const source = fs.readFileSync(path.join(__dirname, 'AdminController.ts'), 'utf-8')
    const declarations = source.matchAll(
      /@http(Get|Post|Put|Delete|Patch)\(\s*'([^']*)'[\s\S]*?\n\s*(?:private |public )?async (\w+)\(/g,
    )

    return new Map([...declarations].map((match) => [match[3], match[1].toUpperCase()]))
  })()

  /** `/groups/:groupUuid/members/:userUuid` -> ['groupUuid', 'userUuid'] */
  const pathParamsOf = (routePath: string): string[] =>
    routePath
      .split('/')
      .filter((segment) => segment.startsWith(':'))
      .map((segment) => segment.slice(1))

  const buildRequest = (params: Record<string, string>): Request =>
    ({ params, body: { some: 'body' }, headers: {}, query: {} }) as unknown as Request

  const buildResponse = (): Response =>
    ({
      locals: {},
      setHeader: jest.fn(),
      status: jest.fn().mockReturnValue({ send: jest.fn(), json: jest.fn() }),
      send: jest.fn(),
      json: jest.fn(),
    }) as unknown as Response

  beforeEach(() => {
    serviceProxy = {
      callAuthServer: jest.fn().mockResolvedValue(undefined),
    } as unknown as ServiceProxyInterface

    // Echo the resolver arguments back so each assertion can read exactly what
    // the handler asked for, without depending on the resolver's own mapping.
    endpointResolver = {
      resolveEndpointOrMethodIdentifier: jest.fn((...args: unknown[]) => JSON.stringify(args)),
    } as unknown as EndpointResolverInterface
  })

  /** Invokes a handler and reports whether it proxied, plus the resolver arguments. */
  const invoke = async (handlerName: string, routePath: string) => {
    const params = Object.fromEntries(pathParamsOf(routePath).map((name) => [name, `value-of-${name}`]))
    const controller = makeController() as unknown as Record<
      string,
      (request: Request, response: Response) => Promise<void>
    >

    try {
      await controller[handlerName](buildRequest(params), buildResponse())
    } catch {
      // A gateway-local handler may reject against these bare stubs; the only
      // thing that matters here is whether it reached the auth-server proxy.
    }

    const proxied = (serviceProxy.callAuthServer as jest.Mock).mock.calls.length > 0
    const resolverArgs = (endpointResolver.resolveEndpointOrMethodIdentifier as jest.Mock).mock.calls[0] as
      unknown[] | undefined

    return { proxied, resolverArgs, params }
  }

  const proxiedRoutes = routeMetadata.filter((route) => !gatewayLocalHandlers.has(route.key as string))

  it('finds the admin pass-through routes to check', () => {
    expect(proxiedRoutes.length).toBeGreaterThanOrEqual(35)
  })

  it.each(proxiedRoutes.map((route) => [route.key as string, route.path as string]))(
    '%s proxies to the auth server',
    async (handlerName, routePath) => {
      const { proxied } = await invoke(handlerName, routePath)

      expect(proxied).toBe(true)
    },
  )

  it.each(proxiedRoutes.map((route) => [route.key as string, route.path as string]))(
    '%s resolves the auth endpoint as admin + its own route path, using its own HTTP verb',
    async (handlerName, routePath) => {
      const { resolverArgs } = await invoke(handlerName, routePath)

      expect(resolverArgs?.[0]).toBe(verbByHandler.get(handlerName))
      expect(resolverArgs?.[1]).toBe(`admin${routePath}`)
    },
  )

  it.each(proxiedRoutes.map((route) => [route.key as string, route.path as string]))(
    '%s forwards its path parameters in declaration order',
    async (handlerName, routePath) => {
      const { resolverArgs, params } = await invoke(handlerName, routePath)

      const expectedValues = pathParamsOf(routePath).map((name) => params[name])
      expect(resolverArgs?.slice(2)).toEqual(expectedValues)
    },
  )

  it.each(proxiedRoutes.map((route) => [route.key as string, route.path as string]))(
    '%s forwards the request, response and body to the proxy',
    async (handlerName, routePath) => {
      await invoke(handlerName, routePath)

      const call = (serviceProxy.callAuthServer as jest.Mock).mock.calls[0]
      expect(call[0]).toMatchObject({ params: expect.anything() })
      expect(call[1]).toMatchObject({ locals: expect.anything() })
      expect(call[3]).toEqual({ some: 'body' })
    },
  )

  it('every route named gateway-local really is answered without touching the auth server', async () => {
    for (const route of routeMetadata) {
      if (!gatewayLocalHandlers.has(route.key as string)) {
        continue
      }

      const { proxied } = await invoke(route.key as string, route.path as string)

      expect({ handler: route.key, proxied }).toEqual({ handler: route.key, proxied: false })
    }
  })

  it('lists no gateway-local handler that is not an actual route', () => {
    const declared = new Set(routeMetadata.map((route) => route.key as string))

    for (const handlerName of gatewayLocalHandlers) {
      expect({ handlerName, declared: declared.has(handlerName) }).toEqual({ handlerName, declared: true })
    }
  })

  it('parses an HTTP verb for exactly the routes the runtime registered', () => {
    const registered = routeMetadata.map((route) => route.key as string).sort()

    expect([...verbByHandler.keys()].sort()).toEqual(registered)
  })

  it('mounts every admin route behind the required cross service token middleware', () => {
    for (const route of routeMetadata) {
      expect({ handler: route.key, guarded: route.middleware.length > 0 }).toEqual({
        handler: route.key,
        guarded: true,
      })
    }
  })
})
