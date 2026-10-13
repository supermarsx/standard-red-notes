import 'reflect-metadata'

import { Request, Response } from 'express'
import { Logger } from 'winston'

import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { GatewayUserDataPurger } from '../../Service/UserData/GatewayUserDataPurger'
import { AdminController } from './AdminController'
import { UsersController } from './UsersController'

/**
 * The two routes that delete an account, and what the gateway does with its
 * own per-user stores afterwards.
 *
 * The auth service decides whether the account is deleted. The gateway only
 * relays that request, so the purge must follow auth's answer exactly: after a
 * success, never after a refusal, and never in a way that can change or delay
 * the answer the caller already received.
 */

const USER = '11111111-1111-4111-8111-111111111111'

type SentResponse = Response & { statusCode: number; headersSent: boolean; body: unknown }

function responseStub(): SentResponse {
  const response = {
    locals: { user: { uuid: USER }, roles: [] },
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    status(code: number) {
      response.statusCode = code
      return response
    },
    send(body: unknown) {
      response.body = body
      response.headersSent = true
      return response
    },
    json(body: unknown) {
      return response.send(body)
    },
  }
  return response as unknown as SentResponse
}

/** A service proxy whose auth call answers the way the real one does: by writing to the response. */
function proxyAnswering(statusCode: number | 'nothing' | 'throws'): {
  proxy: ServiceProxyInterface
  calls: Array<{ endpoint: unknown; payload: unknown }>
} {
  const calls: Array<{ endpoint: unknown; payload: unknown }> = []
  const proxy = {
    callAuthServer: jest.fn(async (_request: Request, response: Response, endpoint: unknown, payload: unknown) => {
      calls.push({ endpoint, payload })
      if (statusCode === 'throws') {
        throw new Error('auth is unreachable')
      }
      if (statusCode !== 'nothing') {
        response.status(statusCode).send({ data: statusCode < 300 ? { message: 'Successfully deleted user' } : {} })
      }
    }),
  } as unknown as ServiceProxyInterface
  return { proxy, calls }
}

const endpointResolver = {
  resolveEndpointOrMethodIdentifier: (method: string, endpoint: string) => `[${method}]:${endpoint}`,
} as unknown as EndpointResolverInterface

const purgerSpy = (): { purger: GatewayUserDataPurger; purge: jest.Mock } => {
  const purge = jest.fn().mockResolvedValue({ stores: {}, removed: 0, failed: 0 })
  return { purger: { purge } as unknown as GatewayUserDataPurger, purge }
}

const request = (params: Record<string, string>, body?: unknown): Request =>
  ({ params, body, headers: {} }) as unknown as Request

describe('deleting an account removes what the gateway stores about it', () => {
  describe('DELETE /v1/users/:userUuid (a user deletes their own account)', () => {
    const controller = (proxy: ServiceProxyInterface, purger?: GatewayUserDataPurger): UsersController =>
      new UsersController(proxy, endpointResolver, {} as Logger, purger)

    it('purges the deleted user after auth answered with a success', async () => {
      const { proxy, calls } = proxyAnswering(200)
      const { purger, purge } = purgerSpy()
      const response = responseStub()

      await controller(proxy, purger).deleteUser(request({ userUuid: USER }), response)

      expect(calls).toHaveLength(1)
      expect(purge).toHaveBeenCalledTimes(1)
      expect(purge).toHaveBeenCalledWith(USER)
      // The caller's answer is auth's answer, untouched.
      expect([response.statusCode, response.body]).toEqual([200, { data: { message: 'Successfully deleted user' } }])
    })

    it.each([
      ['a wrong password or a session that is not the owner', 401],
      ['a refused deletion', 400],
      ['an auth failure', 500],
    ])('purges nothing after %s', async (_label, statusCode) => {
      const { proxy } = proxyAnswering(statusCode)
      const { purger, purge } = purgerSpy()
      const response = responseStub()

      await controller(proxy, purger).deleteUser(request({ userUuid: USER }), response)

      expect(purge).not.toHaveBeenCalled()
      expect(response.statusCode).toBe(statusCode)
    })

    it('purges nothing when auth wrote no answer at all', async () => {
      const { proxy } = proxyAnswering('nothing')
      const { purger, purge } = purgerSpy()

      await controller(proxy, purger).deleteUser(request({ userUuid: USER }), responseStub())

      expect(purge).not.toHaveBeenCalled()
    })

    it('purges nothing when the call to auth threw', async () => {
      const { proxy } = proxyAnswering('throws')
      const { purger, purge } = purgerSpy()

      await expect(controller(proxy, purger).deleteUser(request({ userUuid: USER }), responseStub())).rejects.toThrow(
        'auth is unreachable',
      )
      expect(purge).not.toHaveBeenCalled()
    })

    it('still answers with the success when the purge itself fails', async () => {
      const { proxy } = proxyAnswering(200)
      const purger = { purge: jest.fn().mockRejectedValue(new Error('disk full')) } as unknown as GatewayUserDataPurger
      const response = responseStub()

      await expect(controller(proxy, purger).deleteUser(request({ userUuid: USER }), response)).resolves.toBeUndefined()
      expect(response.statusCode).toBe(200)
    })

    it('works where no purger is bound', async () => {
      const { proxy } = proxyAnswering(200)
      const response = responseStub()

      await controller(proxy).deleteUser(request({ userUuid: USER }), response)

      expect(response.statusCode).toBe(200)
    })

    it('does not purge on any other user route that answers with a success', async () => {
      const { proxy } = proxyAnswering(200)
      const { purger, purge } = purgerSpy()
      const users = controller(proxy, purger)

      await users.deleteSetting(request({ userUuid: USER, settingName: 'MUTE_SIGN_IN_EMAILS' }), responseStub())

      expect(purge).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /v1/admin/users/:userUuid (an administrator deletes an account)', () => {
    const controller = (proxy: ServiceProxyInterface, purger?: GatewayUserDataPurger): AdminController => {
      // Only the three collaborators this route uses; every other constructor
      // slot of the controller is optional and stays unbound.
      const construct = AdminController as unknown as new (...dependencies: unknown[]) => AdminController
      const slots: unknown[] = new Array(AdminController.length).fill(undefined)
      slots[0] = proxy
      slots[1] = endpointResolver
      slots[slots.length - 1] = purger
      return new construct(...slots)
    }

    it('takes the purger as its LAST constructor argument, where the container appends it', () => {
      // If a dependency is ever added after it, the helper above would hand the
      // purger to the wrong slot and every test below would pass on `undefined`.
      const { proxy } = proxyAnswering(200)
      const { purger } = purgerSpy()

      expect((controller(proxy, purger) as unknown as { userDataPurger: unknown }).userDataPurger).toBe(purger)
    })

    it('purges the deleted user after auth answered with a success, and forwards the confirmation', async () => {
      const { proxy, calls } = proxyAnswering(200)
      const { purger, purge } = purgerSpy()
      const response = responseStub()
      const body = { confirmEmail: 'alice@example.org' }

      await controller(proxy, purger).deleteUser(request({ userUuid: USER }, body), response)

      expect(calls).toEqual([{ endpoint: '[DELETE]:admin/users/:userUuid', payload: body }])
      expect(purge).toHaveBeenCalledWith(USER)
      expect(response.statusCode).toBe(200)
    })

    it.each([
      ['a requester who is not an administrator', 403],
      ['the last administrator, a wrong confirmation or an unknown user', 400],
      ['an auth failure', 500],
    ])('purges nothing after %s', async (_label, statusCode) => {
      const { proxy } = proxyAnswering(statusCode)
      const { purger, purge } = purgerSpy()

      await controller(proxy, purger).deleteUser(request({ userUuid: USER }, {}), responseStub())

      expect(purge).not.toHaveBeenCalled()
    })

    it('does not purge when an administrator removes only the MFA secret of an account', async () => {
      const { proxy } = proxyAnswering(200)
      const { purger, purge } = purgerSpy()

      await controller(proxy, purger).resetUserMFA(request({ userUuid: USER }), responseStub())

      expect(purge).not.toHaveBeenCalled()
    })
  })
})
