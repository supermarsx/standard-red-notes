import 'reflect-metadata'

import * as fs from 'fs'
import * as path from 'path'
import { Request, Response } from 'express'
import { getControllerMethodMetadata } from 'inversify-express-utils'

import * as barrel from './index'

/**
 * Standard Red Notes: cross-cutting checks over EVERY versioned route controller.
 *
 * The v1/v2 controllers are almost entirely thin dispatchers: each handler picks a
 * backend (auth / syncing / payments / revisions / ...) and forwards the request
 * along with the route's path parameters. Two classes of bug are invisible to the
 * type checker and to any per-controller test that only covers a few handlers:
 *
 *   1. a handler that forgets a `:param`, so the action lands on the wrong record
 *      (or on the collection instead of the item), and
 *   2. a route that ends up on no authentication middleware at all.
 *
 * These tests exercise every registered route of every controller, so a new or
 * edited handler is checked the moment it is added — no per-route test needed.
 *
 * Controllers are instantiated without their real dependencies: the instance is a
 * Proxy over the prototype that auto-stubs any field the handler reaches for and
 * records the calls. That keeps this spec independent of each controller's
 * constructor signature.
 */

const controllerDir = __dirname

type RecordedCall = { field: string; method: string; args: unknown[] }

/** Marker returned by every auto-stubbed method so forwarded values stay traceable. */
const resolved = (call: RecordedCall) => `resolved(${call.field}.${call.method})`

/**
 * Builds an instance whose prototype methods are real but whose injected fields
 * are recording stubs, so a handler can be invoked with no container at all.
 */
const buildRecordingController = (
  ControllerClass: new (...args: never[]) => unknown,
): { instance: Record<string, (request: Request, response: Response) => Promise<void>>; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = []
  const stubs = new Map<string, unknown>()

  const target = Object.create(ControllerClass.prototype) as Record<string | symbol, unknown>

  const instance = new Proxy(target, {
    get(receiver, property) {
      if (typeof property === 'symbol' || property in receiver) {
        return receiver[property]
      }

      if (!stubs.has(property)) {
        stubs.set(
          property,
          new Proxy(
            {},
            {
              get(_stubTarget, method) {
                if (typeof method === 'symbol') {
                  return undefined
                }

                return (...args: unknown[]) => {
                  const call = { field: property, method, args }
                  calls.push(call)

                  return resolved(call)
                }
              },
            },
          ),
        )
      }

      return stubs.get(property)
    },
  })

  return { instance: instance as never, calls }
}

/** `/groups/:groupUuid/members/:userUuid` -> ['groupUuid', 'userUuid'] */
const pathParamsOf = (routePath: string): string[] =>
  routePath
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))

const controllerModules = fs
  .readFileSync(path.join(controllerDir, 'index.ts'), 'utf-8')
  .split('\n')
  .map((line) => /^export \* from '\.\/(v\d+\/\w+Controller)'$/.exec(line)?.[1])
  .filter((moduleName): moduleName is string => Boolean(moduleName))

type RouteUnderTest = {
  controllerName: string
  handlerName: string
  routePath: string
  routeGuarded: boolean
  controllerGuarded: boolean
  ControllerClass: new (...args: never[]) => unknown
}

/**
 * Whether each versioned controller class carries middleware on its `@controller`
 * decorator: `@controller('/v1/messages', TYPES.X)` guards EVERY route on the
 * controller, even routes that declare none of their own. Read from source
 * because the decorator's middleware is not exposed on the runtime metadata.
 * Keyed by class name, which is also what restricts the run below to the v1/v2
 * controllers (the barrel also exports middlewares and root-level controllers).
 */
const controllerGuardedByClassName = new Map<string, boolean>()

for (const moduleName of controllerModules) {
  const source = fs.readFileSync(path.join(controllerDir, `${moduleName}.ts`), 'utf-8')

  for (const declaration of source.matchAll(/@controller\(\s*'[^']*'\s*(,[\s\S]*?)?\)\s*\nexport class (\w+)/g)) {
    controllerGuardedByClassName.set(declaration[2], Boolean(declaration[1]?.trim()))
  }
}

const routes: RouteUnderTest[] = []

for (const exported of Object.values(barrel)) {
  if (typeof exported !== 'function') {
    continue
  }

  const ControllerClass = exported as unknown as new (...args: never[]) => unknown
  const controllerGuarded = controllerGuardedByClassName.get(ControllerClass.name)
  if (controllerGuarded === undefined) {
    continue
  }

  for (const route of getControllerMethodMetadata(ControllerClass as never)) {
    routes.push({
      controllerName: ControllerClass.name,
      handlerName: String(route.key),
      routePath: route.path,
      routeGuarded: route.middleware.length > 0,
      controllerGuarded,
      ControllerClass,
    })
  }
}

const invoke = async (route: RouteUnderTest) => {
  const params = Object.fromEntries(pathParamsOf(route.routePath).map((name) => [name, `value-of-${name}`]))
  const { instance, calls } = buildRecordingController(route.ControllerClass)

  const request = { params, body: { some: 'body' }, headers: {}, query: {} } as unknown as Request
  const response = {
    locals: {},
    setHeader: jest.fn(),
    status: jest.fn().mockReturnValue({ send: jest.fn(), json: jest.fn() }),
    send: jest.fn(),
    json: jest.fn(),
  } as unknown as Response

  try {
    await instance[route.handlerName](request, response)
  } catch {
    // Gateway-local handlers may reject against these bare stubs; the recorded
    // calls are what these tests assert on.
  }

  return { calls, params, request, response }
}

/**
 * Path parameters a handler deliberately does NOT act on, with the reason. These
 * are asserted to stay ignored: `getKeyParams` in particular must keep deriving
 * the user from the verified cross-service token rather than from the URL, so a
 * change that started honouring `:userId` would be a privilege-escalation bug.
 */
const deliberatelyIgnoredPathParams = new Set([
  'UsersController.getKeyParams (/:userId/params):userId',
  'UsersController.blockMFA (/:userId/mfa):userId',
])

const routeLabel = (route: RouteUnderTest) => `${route.controllerName}.${route.handlerName} (${route.routePath})`

describe('versioned route controllers', () => {
  it('discovers every controller exported from the barrel', () => {
    expect(controllerModules.length).toBeGreaterThanOrEqual(30)
    expect(routes.length).toBeGreaterThanOrEqual(180)
  })

  describe('downstream dispatch', () => {
    it.each(routes.map((route) => [routeLabel(route), route]))(
      '%s never fans a single request out to more than one backend',
      async (_label, route) => {
        const { calls } = await invoke(route as RouteUnderTest)

        // Sending the same request to two services would double-apply a mutation.
        expect(calls.filter((call) => call.method.startsWith('call')).length).toBeLessThanOrEqual(1)
      },
    )

    it.each(routes.map((route) => [routeLabel(route), route]))(
      '%s passes the express request and response straight through when it forwards',
      async (_label, route) => {
        const { calls } = await invoke(route as RouteUnderTest)

        const proxyCall = calls.find((call) => call.method.startsWith('call'))
        if (!proxyCall) {
          // Answered by the gateway itself; covered by that controller's own spec.
          return
        }

        expect(proxyCall.args[0]).toMatchObject({ params: expect.anything(), body: { some: 'body' } })
        expect(proxyCall.args[1]).toMatchObject({ locals: expect.anything() })
      },
    )

    it.each(
      routes.filter((route) => pathParamsOf(route.routePath).length > 0).map((route) => [routeLabel(route), route]),
    )('%s forwards every one of its path parameters downstream', async (_label, route) => {
      const typedRoute = route as RouteUnderTest
      const { calls, params, request, response } = await invoke(typedRoute)

      if (!calls.some((call) => call.method.startsWith('call'))) {
        return
      }

      // Only values the handler CHOSE to pass count — as a resolver argument or
      // in the payload. The express request itself is excluded deliberately: it
      // always carries every path parameter, so counting it would let a handler
      // drop a parameter from the endpoint it builds and still look correct.
      const chosenArguments = calls
        .filter((call) => call.field !== 'logger')
        .flatMap((call) => call.args)
        .filter((argument) => argument !== request && argument !== response)

      const forwarded = JSON.stringify(chosenArguments)

      for (const name of pathParamsOf(typedRoute.routePath)) {
        if (deliberatelyIgnoredPathParams.has(`${routeLabel(typedRoute)}:${name}`)) {
          expect({ route: routeLabel(typedRoute), param: name, forwarded: forwarded.includes(params[name]) }).toEqual({
            route: routeLabel(typedRoute),
            param: name,
            forwarded: false,
          })
          continue
        }

        expect({ route: routeLabel(typedRoute), param: name, forwarded: forwarded.includes(params[name]) }).toEqual({
          route: routeLabel(typedRoute),
          param: name,
          forwarded: true,
        })
      }
    })

    it('keeps the great majority of routes on the proxy path', async () => {
      let forwarding = 0
      for (const route of routes) {
        const { calls } = await invoke(route)
        if (calls.some((call) => call.method.startsWith('call'))) {
          forwarding += 1
        }
      }

      // Guards the conditional assertions above: were a batch of handlers to stop
      // forwarding, they would quietly opt out of every check without this floor.
      expect(forwarding).toBeGreaterThanOrEqual(150)
    })
  })

  describe('authentication surface', () => {
    /**
     * Routes reachable with no authentication middleware at all — login, signup,
     * password reset, public share reads, the payments site's own pages, and the
     * routes whose credential IS the URL token. This list is a CHANGE DETECTOR:
     * if a route stops being guarded, or a new unguarded route appears, this test
     * fails and the change has to be made deliberately.
     */
    const knownUnauthenticatedRoutes = [
      // Credentials are the point of the request.
      'ActionsController.login (/login)',
      'ActionsController.recoveryLogin (/recovery/login)',
      'ActionsController.recoveryParams (/recovery/login-params)',
      'ActionsController.accountRecoveryLookup (/account-recovery/lookup)',
      'AuthenticatorsController.generateAuthenticationOptions (/generate-authentication-options)',
      'McpTokensController.authenticate (/authenticate)',
      'MagicLinkController.request (/request)',
      'SessionsController.refreshSession (/refresh)',
      'UsersController.register (/)',
      'UsersController.claimAccount (/claim-account)',
      // The URL token IS the credential.
      'ActionsController.emailUnsubscribe (/unsubscribe/:token)',
      'PendingMfaApprovalsController.status (/:challengeId/status)',
      'SharesController.get (/:shareId)',
      'UsersController.resendEmailConfirmation (/email-confirmation/resend)',
      'UsersController.verifyEmailConfirmation (/email-confirmation/verify)',
      // Public, unauthenticated reads.
      'ActionsController.serverMetadata (/meta)',
      'AssistantController.transcriptionModelList (/transcription/models)',
      'PluginsController.component (/component/{*splat})',
      // Offline (subscription-token) activation flow, which has no session.
      'OfflineController.createOfflineSubscriptionToken (/subscription-tokens)',
      'OfflineController.createStripeSetupIntent (/payments/stripe-setup-intent)',
      'OfflineController.getOfflineFeatures (/features)',
      // OAuth redirect back from the assistant subscription provider.
      'AssistantController.subscriptionCallback (/subscription/callback)',
      // Websocket connection lifecycle hooks, called by the websocket tier.
      'WebSocketsController.deleteWebSocketConnection (/connections)',
      // The payments site's own pages and its separate admin login, proxied as-is.
      'PaymentsController.adminLogin (/admin/auth/login)',
      'PaymentsController.adminLogout (/admin/auth/logout)',
      'PaymentsController.categoriesHelp (/help/categories)',
      'PaymentsController.categoriesKnowledge (/knowledge/categories)',
      'PaymentsController.downloadInfo (/downloads/download-info)',
      'PaymentsController.downloads (/downloads)',
      'PaymentsController.extensions (/extensions)',
      'PaymentsController.platformDownloads (/downloads/platforms)',
      'PaymentsController.proUsers (/pro_users{/*splat})',
      'PaymentsController.refunds (/refunds)',
      'PaymentsController.reset (/reset)',
      'PaymentsController.resetRequest (/reset)',
      'PaymentsController.students (/students)',
      'PaymentsController.studentsApprove (/students/:token/approve)',
      'PaymentsController.subscriptions (/subscriptions{/*splat})',
      'PaymentsController.subscriptionsLess (/email_subscriptions/:token/less)',
      'PaymentsController.subscriptionsMore (/email_subscriptions/:token/more)',
      'PaymentsController.subscriptionsMute (/email_subscriptions/:token/mute/:campaignId)',
      'PaymentsController.subscriptionsUnsubscribe (/email_subscriptions/:token/unsubscribe)',
      'PaymentsController.userRegistration (/user-registration)',
      'PaymentsController.validateReset (/reset/validate)',
    ]

    const unauthenticated = routes
      .filter((route) => !route.routeGuarded && !route.controllerGuarded)
      .map(routeLabel)
      .sort()

    it('exposes no unauthenticated route beyond the known public surface', () => {
      const unexpected = unauthenticated.filter((route) => !knownUnauthenticatedRoutes.includes(route))

      expect(unexpected).toEqual([])
    })

    it('still guards every route the known public surface does not name', () => {
      const noLongerUnauthenticated = knownUnauthenticatedRoutes.filter((route) => !unauthenticated.includes(route))

      expect(noLongerUnauthenticated).toEqual([])
    })

    it('guards the whole admin surface', () => {
      const adminRoutes = routes.filter((route) => route.controllerName === 'AdminController')

      expect(adminRoutes.length).toBeGreaterThan(0)
      for (const route of adminRoutes) {
        expect({ route: routeLabel(route), guarded: route.routeGuarded || route.controllerGuarded }).toEqual({
          route: routeLabel(route),
          guarded: true,
        })
      }
    })
  })
})
