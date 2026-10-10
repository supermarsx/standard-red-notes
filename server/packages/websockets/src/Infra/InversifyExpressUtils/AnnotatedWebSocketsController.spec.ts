import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'

import { AddWebSocketsConnection } from '../../Domain/UseCase/AddWebSocketsConnection/AddWebSocketsConnection'
import { CreateWebSocketConnectionToken } from '../../Domain/UseCase/CreateWebSocketConnectionToken/CreateWebSocketConnectionToken'
import { RemoveWebSocketsConnection } from '../../Domain/UseCase/RemoveWebSocketsConnection/RemoveWebSocketsConnection'
import { AnnotatedWebSocketsController } from './AnnotatedWebSocketsController'

/**
 * Standard Red Notes: this spec exists because the file it covers had NO test
 * at all and was outside this package's coverage denominator, behind a flat
 * `'/InversifyExpressUtils/'` entry in `coveragePathIgnorePatterns`.
 *
 * The real `Result` from `@standardnotes/domain-core` is used throughout rather
 * than a hand-rolled `{ isFailed: () => true }`: a fake would make these tests
 * pass against a controller that read some other field, and `Result` is frozen
 * in its own constructor, so only the real class behaves like the real thing.
 *
 * The returned values are asserted both by `instanceof` AND by `statusCode`.
 * `instanceof` alone would pass a cast; `statusCode` alone would pass a
 * different result class that happens to carry the same number.
 */
describe('AnnotatedWebSocketsController', () => {
  let addWebSocketsConnection: AddWebSocketsConnection
  let removeWebSocketsConnection: RemoveWebSocketsConnection
  let createWebSocketConnectionToken: CreateWebSocketConnectionToken

  const createController = () =>
    new AnnotatedWebSocketsController(
      addWebSocketsConnection,
      removeWebSocketsConnection,
      createWebSocketConnectionToken,
    )

  const makeRequest = (connectionId?: string): Request =>
    ({ params: connectionId === undefined ? {} : { connectionId } }) as unknown as Request

  const makeResponse = (): Response =>
    ({
      locals: {
        user: { uuid: 'user-1' },
        session: { uuid: 'session-1' },
      },
    }) as unknown as Response

  beforeEach(() => {
    addWebSocketsConnection = {} as jest.Mocked<AddWebSocketsConnection>
    addWebSocketsConnection.execute = jest.fn().mockResolvedValue(Result.ok())

    removeWebSocketsConnection = {} as jest.Mocked<RemoveWebSocketsConnection>
    removeWebSocketsConnection.execute = jest.fn().mockResolvedValue(Result.ok())

    createWebSocketConnectionToken = {} as jest.Mocked<CreateWebSocketConnectionToken>
    createWebSocketConnectionToken.execute = jest.fn().mockResolvedValue({ token: 'a-connection-token' })
  })

  describe('createConnectionToken', () => {
    // The token is minted for the IDENTITY the auth middleware put on
    // `response.locals`, never for anything the caller sent. A controller that
    // read a uuid off the request body would mint a connection token for
    // somebody else's session, so the DTO is asserted exactly.
    it('mints a token for the authenticated user and session from response locals', async () => {
      const response = await createController().createConnectionToken(makeRequest(), makeResponse())

      expect(createWebSocketConnectionToken.execute).toHaveBeenCalledWith({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
      })
      expect(response).toBeInstanceOf(results.JsonResult)
      expect(response.statusCode).toEqual(200)
      expect(response.json).toEqual({ token: 'a-connection-token' })
    })
  })

  describe('storeWebSocketsConnection', () => {
    it('stores the connection under the authenticated identity and answers 200', async () => {
      const response = await createController().storeWebSocketsConnection(makeRequest('connection-1'), makeResponse())

      expect(addWebSocketsConnection.execute).toHaveBeenCalledWith({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        connectionId: 'connection-1',
      })
      expect(response).toBeInstanceOf(results.OkResult)
      expect(response.statusCode).toEqual(200)
    })

    // A failed use case must not read as success. This is the assertion that
    // makes the `isFailed()` branch load-bearing: without it, deleting the
    // branch entirely would leave every test green.
    it('answers 400 when the use case fails', async () => {
      addWebSocketsConnection.execute = jest.fn().mockResolvedValue(Result.fail('could not persist'))

      const response = await createController().storeWebSocketsConnection(makeRequest('connection-1'), makeResponse())

      expect(response).toBeInstanceOf(results.BadRequestResult)
      expect(response.statusCode).toEqual(400)
    })
  })

  describe('deleteWebSocketsConnection', () => {
    // This route carries NO auth middleware in its decorator, so it must not
    // read an identity it has not been given: it is keyed on the connection id
    // alone. A controller that reached for `response.locals.session` here would
    // throw on every disconnect, which is how connections leak.
    it('removes the connection by id alone, without touching response locals', async () => {
      const response = await createController().deleteWebSocketsConnection(makeRequest('connection-1'))

      expect(removeWebSocketsConnection.execute).toHaveBeenCalledWith({ connectionId: 'connection-1' })
      expect(response).toBeInstanceOf(results.OkResult)
      expect(response.statusCode).toEqual(200)
    })

    it('answers 400 when the removal fails', async () => {
      removeWebSocketsConnection.execute = jest.fn().mockResolvedValue(Result.fail('no such connection'))

      const response = await createController().deleteWebSocketsConnection(makeRequest('connection-1'))

      expect(response).toBeInstanceOf(results.BadRequestResult)
      expect(response.statusCode).toEqual(400)
    })
  })
})
