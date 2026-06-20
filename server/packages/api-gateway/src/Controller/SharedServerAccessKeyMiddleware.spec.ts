import { NextFunction, Request, Response } from 'express'
import {
  createSharedServerAccessKeyMiddleware,
  resolveSharedServerAccessKeyConfig,
  SharedServerAccessKeyMode,
  SHARED_SERVER_ACCESS_KEY_HEADER,
} from './SharedServerAccessKeyMiddleware'

const buildRequest = (overrides: Partial<Request> = {}): Request => {
  return {
    method: 'GET',
    path: '/v1/items/sync',
    headers: {},
    ...overrides,
  } as unknown as Request
}

const buildResponse = (): {
  response: Response
  status: jest.Mock
  send: jest.Mock
} => {
  const send = jest.fn()
  const status = jest.fn().mockReturnValue({ send })
  const response = { status, send } as unknown as Response

  return { response, status, send }
}

describe('SharedServerAccessKeyMiddleware', () => {
  describe('resolveSharedServerAccessKeyConfig', () => {
    it('disables the gate when no key is set', () => {
      expect(resolveSharedServerAccessKeyConfig(undefined, 'all')).toEqual({
        key: undefined,
        mode: SharedServerAccessKeyMode.Off,
      })
      expect(resolveSharedServerAccessKeyConfig('', 'all')).toEqual({
        key: undefined,
        mode: SharedServerAccessKeyMode.Off,
      })
    })

    it('resolves explicit modes when a key is set', () => {
      expect(resolveSharedServerAccessKeyConfig('secret', 'all').mode).toEqual(SharedServerAccessKeyMode.All)
      expect(resolveSharedServerAccessKeyConfig('secret', 'registration').mode).toEqual(
        SharedServerAccessKeyMode.Registration,
      )
      expect(resolveSharedServerAccessKeyConfig('secret', 'off').mode).toEqual(SharedServerAccessKeyMode.Off)
    })

    it('defaults to `all` when a key is set but the mode is missing or unknown', () => {
      expect(resolveSharedServerAccessKeyConfig('secret', undefined).mode).toEqual(SharedServerAccessKeyMode.All)
      expect(resolveSharedServerAccessKeyConfig('secret', 'bogus').mode).toEqual(SharedServerAccessKeyMode.All)
    })

    it('is case-insensitive and tolerates whitespace in the mode', () => {
      expect(resolveSharedServerAccessKeyConfig('secret', ' Registration ').mode).toEqual(
        SharedServerAccessKeyMode.Registration,
      )
    })
  })

  describe('off mode (default)', () => {
    it('passes every request through with no key configured', () => {
      const middleware = createSharedServerAccessKeyMiddleware(
        resolveSharedServerAccessKeyConfig(undefined, undefined),
      )
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'POST', path: '/v1/users' }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('all mode', () => {
    const config = { key: 's3cret', mode: SharedServerAccessKeyMode.All }

    it('rejects a request with no key header', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status, send } = buildResponse()

      middleware(buildRequest(), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(401)
      expect(send).toHaveBeenCalled()
    })

    it('rejects a request with the wrong key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ headers: { [SHARED_SERVER_ACCESS_KEY_HEADER]: 'wrong' } }), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(401)
    })

    it('accepts a request with the correct key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ headers: { [SHARED_SERVER_ACCESS_KEY_HEADER]: 's3cret' } }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('reads the key from an array-valued header', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response } = buildResponse()

      middleware(buildRequest({ headers: { [SHARED_SERVER_ACCESS_KEY_HEADER]: ['s3cret'] } }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
    })

    it('exempts the healthcheck path even without a key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'GET', path: '/healthcheck' }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('exempts nested healthcheck paths', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response } = buildResponse()

      middleware(buildRequest({ method: 'GET', path: '/healthcheck/' }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
    })

    it('honors a custom healthcheck allowlist', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config, { healthcheckPaths: ['/ping'] })
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'GET', path: '/ping' }), response, next)
      expect(next).toHaveBeenCalledTimes(1)

      const next2: NextFunction = jest.fn()
      const second = buildResponse()
      middleware(buildRequest({ method: 'GET', path: '/healthcheck' }), second.response, next2)
      expect(next2).not.toHaveBeenCalled()
      expect(second.status).toHaveBeenCalledWith(401)
      void status
    })
  })

  describe('registration mode', () => {
    const config = { key: 's3cret', mode: SharedServerAccessKeyMode.Registration }

    it('passes through non-registration requests without a key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'POST', path: '/v1/items/sync' }), response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('rejects the modern registration route without a key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'POST', path: '/v1/users' }), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(401)
    })

    it('rejects the trailing-slash registration route without a key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'POST', path: '/v1/users/' }), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(401)
    })

    it('rejects the legacy registration route without a key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(buildRequest({ method: 'POST', path: '/auth' }), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(401)
    })

    it('accepts the registration route with the correct key', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(
        buildRequest({ method: 'POST', path: '/v1/users', headers: { [SHARED_SERVER_ACCESS_KEY_HEADER]: 's3cret' } }),
        response,
        next,
      )

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })

    it('does not gate credential changes (only initial account creation)', () => {
      const middleware = createSharedServerAccessKeyMiddleware(config)
      const next: NextFunction = jest.fn()
      const { response, status } = buildResponse()

      middleware(
        buildRequest({ method: 'PUT', path: '/v1/users/some-uuid/attributes/credentials' }),
        response,
        next,
      )

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    })
  })
})
