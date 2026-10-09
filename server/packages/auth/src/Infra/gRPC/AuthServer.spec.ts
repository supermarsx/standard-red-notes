import 'reflect-metadata'

import * as grpc from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { Logger } from 'winston'
import { Result } from '@standardnotes/domain-core'
import { ErrorTag } from '@standardnotes/responses'
import { ConnectionValidationResponse, WebsocketConnectionAuthorizationHeader } from '@standardnotes/grpc'
import { TokenDecoderInterface, WebSocketConnectionTokenData } from '@standardnotes/security'

import { AuthServer } from './AuthServer'
import { AuthenticateRequest } from '../../Domain/UseCase/AuthenticateRequest'
import { CreateCrossServiceToken } from '../../Domain/UseCase/CreateCrossServiceToken/CreateCrossServiceToken'

/**
 * `validateWebsocket` is the ONLY caller that mints a cross-service token from a
 * session UUID rather than a resolved `Session`, so it is the one place where
 * "the session named by an authenticated connection no longer exists" has to be
 * answered. It used to answer with a token that simply had no `session` claim —
 * no error, no log — which lost the attribution that `items.updated_with_session`
 * is derived from and, because every consumer reads read-only access as
 * `session?.readonly_access ?? false`, silently upgraded a revoked or read-only
 * session to read-write. These specs pin the refusal and the record of it.
 */
describe('AuthServer', () => {
  let authenticateRequest: AuthenticateRequest
  let createCrossServiceToken: CreateCrossServiceToken
  let tokenDecoder: TokenDecoderInterface<WebSocketConnectionTokenData>
  let logger: Logger

  const createServer = () => new AuthServer(authenticateRequest, createCrossServiceToken, tokenDecoder, logger)

  const websocketCall = (token: string) =>
    ({
      request: { getToken: () => token } as unknown as WebsocketConnectionAuthorizationHeader,
    }) as unknown as grpc.ServerUnaryCall<WebsocketConnectionAuthorizationHeader, ConnectionValidationResponse>

  beforeEach(() => {
    authenticateRequest = {} as jest.Mocked<AuthenticateRequest>
    authenticateRequest.execute = jest.fn()

    createCrossServiceToken = {} as jest.Mocked<CreateCrossServiceToken>
    createCrossServiceToken.execute = jest.fn().mockResolvedValue(Result.ok('a-cross-service-token'))

    tokenDecoder = {} as jest.Mocked<TokenDecoderInterface<WebSocketConnectionTokenData>>
    tokenDecoder.decodeToken = jest
      .fn()
      .mockReturnValue({ userUuid: '00000000-0000-0000-0000-000000000000', sessionUuid: '2-3-4' })

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  describe('validateWebsocket', () => {
    it('should mint a cross service token for the session the connection token names', async () => {
      const callback = jest.fn()

      await createServer().validateWebsocket(websocketCall('a-connection-token'), callback)

      expect(tokenDecoder.decodeToken).toHaveBeenCalledWith('a-connection-token')
      // The session uuid MUST be forwarded: it is what makes a save over this
      // connection attributable (`items.updated_with_session`).
      expect(createCrossServiceToken.execute).toHaveBeenCalledWith({
        userUuid: '00000000-0000-0000-0000-000000000000',
        sessionUuid: '2-3-4',
      })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toBeNull()
      expect((callback.mock.calls[0][1] as ConnectionValidationResponse).getCrossServiceToken()).toEqual(
        'a-cross-service-token',
      )
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('should reject a connection token that does not decode', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(undefined)
      const callback = jest.fn()

      await createServer().validateWebsocket(websocketCall('nonsense'), callback)

      expect(createCrossServiceToken.execute).not.toHaveBeenCalled()
      const error = callback.mock.calls[0][0] as grpc.ServiceError
      expect(error.code).toEqual(Status.PERMISSION_DENIED)
      expect(error.name).toEqual(ErrorTag.AuthInvalid)
      expect(callback.mock.calls[0][1]).toBeNull()
    })

    it('should answer an error, not a token, when the named session cannot be resolved', async () => {
      createCrossServiceToken.execute = jest
        .fn()
        .mockResolvedValue(Result.fail('Could not find an active session for the supplied session uuid'))
      const callback = jest.fn()

      await createServer().validateWebsocket(websocketCall('a-connection-token'), callback)

      expect(callback).toHaveBeenCalledTimes(1)
      const error = callback.mock.calls[0][0] as grpc.ServiceError
      expect(error.code).toEqual(Status.INVALID_ARGUMENT)
      expect(error.message).toEqual('Could not find an active session for the supplied session uuid')
      expect(error.metadata?.get('x-auth-error-response-code')).toEqual(['400'])
      // No token at all: a connection may not proceed on an unattributable,
      // read-only-stripping credential.
      expect(callback.mock.calls[0][1]).toBeNull()
    })

    it('should RECORD the refusal rather than leaving it implied by silence', async () => {
      createCrossServiceToken.execute = jest
        .fn()
        .mockResolvedValue(Result.fail('Could not find an active session for the supplied session uuid'))
      const callback = jest.fn()

      await createServer().validateWebsocket(websocketCall('a-connection-token'), callback)

      expect(logger.warn).toHaveBeenCalledTimes(1)
      const line = (logger.warn as jest.Mock).mock.calls[0][0] as string
      expect(line).toContain('websocket connection')
      expect(line).toContain('no longer active')
      // The log must not carry the session uuid, the user uuid or the token.
      expect(line).not.toContain('2-3-4')
      expect(line).not.toContain('00000000-0000-0000-0000-000000000000')
      expect(line).not.toContain('a-connection-token')
    })

    it('should answer UNKNOWN and log when the mint throws', async () => {
      createCrossServiceToken.execute = jest.fn().mockRejectedValue(new Error('boom'))
      const callback = jest.fn()

      await createServer().validateWebsocket(websocketCall('a-connection-token'), callback)

      expect(logger.error).toHaveBeenCalledTimes(1)
      const error = callback.mock.calls[0][0] as grpc.ServiceError
      expect(error.code).toEqual(Status.UNKNOWN)
      expect(callback.mock.calls[0][1]).toBeNull()
    })
  })
})
