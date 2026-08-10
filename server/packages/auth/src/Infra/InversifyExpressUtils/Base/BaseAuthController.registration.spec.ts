import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../../../Domain/Event/DomainEventFactoryInterface'
import { ProofOfWorkGate } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { Register } from '../../../Domain/UseCase/Register'
import { VerifyHumanInteraction } from '../../../Domain/UseCase/VerifyHumanInteraction/VerifyHumanInteraction'
import { BaseAuthController } from './BaseAuthController'

describe('BaseAuthController registration', () => {
  it('returns the committed registration when USER_REGISTERED publication fails', async () => {
    const executionOrder: string[] = []
    const registeredUser = {
      uuid: 'user-uuid',
      email: 'registered@example.com',
      protocolVersion: '004',
    }
    const legacyResponse = { token: 'session-token', user: registeredUser }
    const registerUser = {
      execute: jest.fn().mockImplementation(async () => {
        executionOrder.push('registration-persisted')

        return { success: true, result: { legacyResponse } }
      }),
    } as unknown as jest.Mocked<Register>
    const clearLoginAttempts = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<ClearLoginAttempts>
    const domainEventPublisher = {
      publish: jest.fn().mockImplementation(async () => {
        executionOrder.push('event-published')

        throw new Error('SNS request timed out')
      }),
    } as jest.Mocked<DomainEventPublisherInterface>
    const domainEventFactory = {
      createUserRegisteredEvent: jest.fn().mockReturnValue({} as never),
    } as unknown as jest.Mocked<DomainEventFactoryInterface>
    const humanVerification = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<VerifyHumanInteraction>
    const proofOfWorkGate = {
      enforceRegister: jest.fn().mockResolvedValue({ satisfied: true }),
    } as unknown as jest.Mocked<ProofOfWorkGate>
    const logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>
    const controller = new BaseAuthController(
      {} as never,
      {} as never,
      {} as never,
      clearLoginAttempts,
      {} as never,
      logger,
      {} as never,
      registerUser,
      domainEventPublisher,
      domainEventFactory,
      {} as never,
      humanVerification,
      {} as never,
      {} as never,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      proofOfWorkGate,
      {} as never,
      {} as never,
      {} as never,
    )
    const request = {
      body: {
        email: registeredUser.email,
        password: 'test-password',
        api: '20200115',
        ephemeral: false,
      },
      headers: { 'user-agent': 'jest' },
    } as unknown as Request
    const response = { setHeader: jest.fn() } as unknown as Response

    const result = await controller.register(request, response)

    expect(executionOrder).toEqual(['registration-persisted', 'event-published'])
    expect(domainEventFactory.createUserRegisteredEvent).toHaveBeenCalledWith({
      userUuid: registeredUser.uuid,
      email: registeredUser.email,
      protocolVersion: registeredUser.protocolVersion,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish USER_REGISTERED event after registration was committed.',
      {
        userId: registeredUser.uuid,
        errorType: 'Error',
        errorCode: undefined,
        status: undefined,
      },
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('SNS request timed out')
    expect(result.statusCode).toBe(200)
    expect(result.json).toEqual(legacyResponse)
    expect(response.setHeader).not.toHaveBeenCalled()
  })

  it('returns a token-free 200 marker and no cookie when email confirmation is required', async () => {
    const registerUser = {
      execute: jest.fn().mockResolvedValue({ success: true, emailConfirmationRequired: true }),
    } as unknown as jest.Mocked<Register>
    const proofOfWorkGate = {
      enforceRegister: jest.fn().mockResolvedValue({ satisfied: true }),
    } as unknown as jest.Mocked<ProofOfWorkGate>
    const humanVerification = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<VerifyHumanInteraction>
    const cookieFactory = { createCookieHeaderValue: jest.fn() }
    const controller = new BaseAuthController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { error: jest.fn() } as never,
      {} as never,
      registerUser,
      {} as never,
      {} as never,
      {} as never,
      humanVerification,
      cookieFactory as never,
      {} as never,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      proofOfWorkGate,
      {} as never,
      {} as never,
      {} as never,
    )
    const request = {
      body: {
        email: 'unconfirmed@example.com',
        password: 'test-password',
        api: '20200115',
        ephemeral: false,
      },
      headers: { 'user-agent': 'jest' },
    } as unknown as Request
    const response = { setHeader: jest.fn() } as unknown as Response

    const result = await controller.register(request, response)

    expect(result.statusCode).toBe(200)
    expect(result.json).toEqual({ emailConfirmationRequired: true })
    expect(JSON.stringify(result.json)).not.toMatch(/access|refresh|session|token/i)
    expect(response.setHeader).not.toHaveBeenCalled()
    expect(cookieFactory.createCookieHeaderValue).not.toHaveBeenCalled()
  })
})
