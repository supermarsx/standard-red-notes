import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'
import { TokenDecoderInterface, ValetTokenData } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import { Logger } from 'winston'

import { InMemoryValetTokenRepository } from '../../InMemory/InMemoryValetTokenRepository'
import { ValetTokenAuthMiddleware } from './ValetTokenAuthMiddleware'

describe('zero-Redis valet-token authorization', () => {
  it.each(['write', 'read'] as const)('authorizes a fresh %s token and rejects its replay', async (operation) => {
    const timer = { getTimestampInSeconds: () => 1_000 } as unknown as TimerInterface
    const repository = new InMemoryValetTokenRepository(timer)
    const tokenDecoder = {
      decodeToken: jest.fn().mockReturnValue({
        userUuid: 'user-uuid',
        permittedResources: [
          {
            remoteIdentifier: '00000000-0000-0000-0000-000000000000',
            unencryptedFileSize: 1,
          },
        ],
        permittedOperation: operation,
        uploadBytesLimit: -1,
        uploadBytesUsed: 0,
      }),
    } as unknown as TokenDecoderInterface<ValetTokenData>
    const middleware = new ValetTokenAuthMiddleware(tokenDecoder, repository, {
      debug: jest.fn(),
    } as unknown as Logger)
    const request = {
      headers: { 'x-valet-token': 'valet-token' },
      body: {},
      query: {},
    } as unknown as Request
    const response = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response
    const next = jest.fn() as NextFunction

    await middleware.handler(request, response, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(response.locals.permittedOperation).toBe(operation)

    await repository.markAsUsed('valet-token')
    await middleware.handler(request, response, next)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(next).toHaveBeenCalledTimes(1)
  })
})
