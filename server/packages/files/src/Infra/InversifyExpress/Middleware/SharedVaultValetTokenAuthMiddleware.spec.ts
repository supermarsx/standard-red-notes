import 'reflect-metadata'

import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'
import { SharedVaultValetTokenData, TokenDecoderInterface, ValetTokenOperation } from '@standardnotes/security'

import { ValetTokenRepositoryInterface } from '../../../Domain/ValetToken/ValetTokenRepositoryInterface'

import { SharedVaultValetTokenAuthMiddleware } from './SharedVaultValetTokenAuthMiddleware'

describe('SharedVaultValetTokenAuthMiddleware', () => {
  let tokenDecoder: TokenDecoderInterface<SharedVaultValetTokenData>
  let valetTokenRepository: ValetTokenRepositoryInterface
  let request: Request
  let response: Response
  let next: NextFunction

  const remoteIdentifier = '00000000-0000-0000-0000-000000000000'

  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as jest.Mocked<Logger>

  const createMiddleware = () => new SharedVaultValetTokenAuthMiddleware(tokenDecoder, valetTokenRepository, logger)

  const tokenData = (overrides: Partial<SharedVaultValetTokenData> = {}) =>
    ({
      sharedVaultUuid: 'shared-vault-uuid',
      vaultOwnerUuid: 'vault-owner-uuid',
      remoteIdentifier,
      permittedOperation: ValetTokenOperation.Read,
      uploadBytesUsed: 0,
      uploadBytesLimit: 100,
      unencryptedFileSize: 10,
      ...overrides,
    }) as SharedVaultValetTokenData

  const expectRejectedAsInvalid = () => {
    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.send).toHaveBeenCalledWith({
      error: { tag: 'invalid-auth', message: 'Invalid valet token.' },
    })
    expect(next).not.toHaveBeenCalled()
    expect(response.locals).toEqual({})
  }

  beforeEach(() => {
    jest.clearAllMocks()

    valetTokenRepository = {} as jest.Mocked<ValetTokenRepositoryInterface>
    valetTokenRepository.isUsed = jest.fn().mockResolvedValue(false)

    tokenDecoder = {} as jest.Mocked<TokenDecoderInterface<SharedVaultValetTokenData>>
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(tokenData())

    request = { headers: { 'x-valet-token': 'valet-token' }, query: {}, body: {} } as unknown as Request
    response = { locals: {} } as jest.Mocked<Response>
    response.status = jest.fn().mockReturnThis()
    response.send = jest.fn()
    next = jest.fn()
  })

  it('whitelists the decoded token data onto the response and continues', async () => {
    await createMiddleware().handler(request, response, next)

    expect(next).toHaveBeenCalled()
    expect(response.status).not.toHaveBeenCalled()
    expect(response.locals).toEqual({
      valetToken: 'valet-token',
      valetTokenData: {
        sharedVaultUuid: 'shared-vault-uuid',
        vaultOwnerUuid: 'vault-owner-uuid',
        remoteIdentifier,
        permittedOperation: ValetTokenOperation.Read,
        uploadBytesUsed: 0,
        uploadBytesLimit: 100,
        unencryptedFileSize: 10,
        moveOperation: undefined,
      },
    })
  })

  it('accepts the valet token from the request body', async () => {
    request = { headers: {}, query: {}, body: { valetToken: 'body-token' } } as unknown as Request

    await createMiddleware().handler(request, response, next)

    expect(tokenDecoder.decodeToken).toHaveBeenCalledWith('body-token')
    expect(next).toHaveBeenCalled()
  })

  it('accepts the valet token from the query string', async () => {
    request = { headers: {}, query: { valetToken: 'query-token' }, body: {} } as unknown as Request

    await createMiddleware().handler(request, response, next)

    expect(tokenDecoder.decodeToken).toHaveBeenCalledWith('query-token')
    expect(next).toHaveBeenCalled()
  })

  it('rejects a request that presents no valet token at all', async () => {
    request = { headers: {}, query: {}, body: {} } as unknown as Request

    await createMiddleware().handler(request, response, next)

    expect(tokenDecoder.decodeToken).not.toHaveBeenCalled()
    expectRejectedAsInvalid()
  })

  it('rejects a valet token that has already been used', async () => {
    valetTokenRepository.isUsed = jest.fn().mockResolvedValue(true)

    await createMiddleware().handler(request, response, next)

    expect(valetTokenRepository.isUsed).toHaveBeenCalledWith('valet-token')
    expect(tokenDecoder.decodeToken).not.toHaveBeenCalled()
    expectRejectedAsInvalid()
  })

  it('rejects a valet token that does not decode', async () => {
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(undefined)

    await createMiddleware().handler(request, response, next)

    expectRejectedAsInvalid()
  })

  it('rejects a valet token whose remote identifier is not a uuid', async () => {
    tokenDecoder.decodeToken = jest.fn().mockReturnValue(tokenData({ remoteIdentifier: 'not-a-uuid' }))

    await createMiddleware().handler(request, response, next)

    expectRejectedAsInvalid()
  })

  it('hands an unexpected failure to the express error handler rather than authorising', async () => {
    const error = new Error('Redis is down')
    valetTokenRepository.isUsed = jest.fn().mockRejectedValue(error)

    await createMiddleware().handler(request, response, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(response.status).not.toHaveBeenCalled()
    expect(response.locals).toEqual({})
  })

  describe('upload space enforcement', () => {
    const expectRejectedForNoSpace = () => {
      expect(response.status).toHaveBeenCalledWith(403)
      expect(response.send).toHaveBeenCalledWith({
        error: {
          tag: 'no-space',
          message: 'The file you are trying to upload is too big. Please ask the vault owner to upgrade subscription',
        },
      })
      expect(next).not.toHaveBeenCalled()
    }

    it('refuses a write that would exhaust the remaining upload space', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Write,
          uploadBytesUsed: 95,
          uploadBytesLimit: 100,
          unencryptedFileSize: 10,
        }),
      )

      await createMiddleware().handler(request, response, next)

      expectRejectedForNoSpace()
    })

    it('allows a write that fits within the remaining upload space', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Write,
          uploadBytesUsed: 10,
          uploadBytesLimit: 100,
          unencryptedFileSize: 10,
        }),
      )

      await createMiddleware().handler(request, response, next)

      expect(next).toHaveBeenCalled()
      expect(response.status).not.toHaveBeenCalled()
    })

    it('refuses a write when the token carries no upload limit at all', async () => {
      tokenDecoder.decodeToken = jest
        .fn()
        .mockReturnValue(tokenData({ permittedOperation: ValetTokenOperation.Write, uploadBytesLimit: undefined }))

      await createMiddleware().handler(request, response, next)

      expectRejectedForNoSpace()
    })

    it('allows a write against an unlimited (-1) upload limit', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Write,
          uploadBytesLimit: -1,
          uploadBytesUsed: 10_000,
        }),
      )

      await createMiddleware().handler(request, response, next)

      expect(next).toHaveBeenCalled()
    })

    it('does not check the upload space for a read', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Read,
          uploadBytesUsed: 100,
          uploadBytesLimit: 100,
        }),
      )

      await createMiddleware().handler(request, response, next)

      expect(next).toHaveBeenCalled()
    })

    it('refuses a move into the vault that would exhaust the remaining upload space', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Move,
          uploadBytesUsed: 95,
          uploadBytesLimit: 100,
          unencryptedFileSize: 10,
          moveOperation: { type: 'user-to-shared-vault' },
        } as Partial<SharedVaultValetTokenData>),
      )

      await createMiddleware().handler(request, response, next)

      expectRejectedForNoSpace()
    })

    it('does not charge the vault for a move out of it to a user', async () => {
      tokenDecoder.decodeToken = jest.fn().mockReturnValue(
        tokenData({
          permittedOperation: ValetTokenOperation.Move,
          uploadBytesUsed: 95,
          uploadBytesLimit: 100,
          unencryptedFileSize: 10,
          moveOperation: { type: 'shared-vault-to-user' },
        } as Partial<SharedVaultValetTokenData>),
      )

      await createMiddleware().handler(request, response, next)

      expect(next).toHaveBeenCalled()
      expect(response.status).not.toHaveBeenCalled()
    })
  })
})
