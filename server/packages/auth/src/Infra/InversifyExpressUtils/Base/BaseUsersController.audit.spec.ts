import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { BaseUsersController } from './BaseUsersController'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { AuditLogWriterInterface, AuditLogWriteParams } from '../../../Domain/AuditLog/AuditLogWriterInterface'

/**
 * Standard Red Notes: changing the account password or email is the single most
 * security-relevant thing a user can do to their own account, and until now it
 * left no trace in the security log at all.
 */
describe('BaseUsersController — credential and account audit', () => {
  const user = { uuid: 'user-1', email: 'user@example.com' }

  let auditLogWriter: jest.Mocked<AuditLogWriterInterface>
  let changeCredentialsUseCase: { execute: jest.Mock }
  let doDeleteAccount: { execute: jest.Mock }
  let clearLoginAttempts: { execute: jest.Mock }
  let increaseLoginAttempts: { execute: jest.Mock }
  let controller: BaseUsersController

  const response = (): Response =>
    ({
      locals: { user, readOnlyAccess: false, authTokenVersion: 1 },
      setHeader: jest.fn(),
    }) as unknown as Response

  const credentialsRequest = (body: Record<string, unknown> = {}) =>
    ({
      params: { userUuid: user.uuid },
      body: {
        current_password: 'the-current-password',
        new_password: 'the-new-password',
        pw_nonce: 'the-nonce',
        ...body,
      },
      headers: { 'x-origin-ip': '198.51.100.7' },
    }) as unknown as Request

  beforeEach(() => {
    auditLogWriter = { write: jest.fn().mockResolvedValue(undefined) }
    changeCredentialsUseCase = {
      execute: jest.fn().mockResolvedValue(Result.ok({ session: null, legacyResponse: { success: true } })),
    }
    doDeleteAccount = { execute: jest.fn().mockResolvedValue(Result.ok('deleted')) }
    clearLoginAttempts = { execute: jest.fn().mockResolvedValue(undefined) }
    increaseLoginAttempts = { execute: jest.fn().mockResolvedValue(undefined) }

    controller = new BaseUsersController(
      doDeleteAccount as never,
      { execute: jest.fn() } as never,
      clearLoginAttempts as never,
      increaseLoginAttempts as never,
      changeCredentialsUseCase as never,
      { createCookieHeaderValue: jest.fn() } as never,
      auditLogWriter,
    )
  })

  it('records a successful password change, attributed to the user and the request IP', async () => {
    await controller.changeCredentials(credentialsRequest(), response())

    expect(auditLogWriter.write).toHaveBeenCalledWith({
      actorUuid: user.uuid,
      action: AuditAction.CredentialsChanged,
      targetType: 'user',
      targetUuid: user.uuid,
      ip: '198.51.100.7',
      metadata: { passwordChanged: true, emailChanged: false },
    })
  })

  it('marks an accompanying email change without recording either address', async () => {
    await controller.changeCredentials(credentialsRequest({ new_email: 'attacker@example.com' }), response())

    const recorded = auditLogWriter.write.mock.calls[0][0] as AuditLogWriteParams
    expect(recorded.metadata).toEqual({ passwordChanged: true, emailChanged: true })
    expect(JSON.stringify(recorded)).not.toContain('attacker@example.com')
  })

  it('records a REJECTED credential change — a live session that could not produce the current password', async () => {
    changeCredentialsUseCase.execute.mockResolvedValueOnce(Result.fail('Invalid password.'))

    const result = await controller.changeCredentials(credentialsRequest(), response())

    expect(result.statusCode).toEqual(401)
    expect(increaseLoginAttempts.execute).toHaveBeenCalled()
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CredentialsChangeFailed,
        targetUuid: user.uuid,
        metadata: { passwordChanged: true, emailChanged: false },
      }),
    )
  })

  it('records nothing when the request is rejected before the use case runs', async () => {
    const result = await controller.changeCredentials(
      { params: { userUuid: user.uuid }, body: { new_password: 'x' }, headers: {} } as unknown as Request,
      response(),
    )

    expect(result.statusCode).toEqual(400)
    expect(changeCredentialsUseCase.execute).not.toHaveBeenCalled()
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('does not weaken the read-only session gate to observe an event', async () => {
    const readOnly = {
      locals: { user, readOnlyAccess: true, authTokenVersion: 1 },
      setHeader: jest.fn(),
    } as unknown as Response

    const result = await controller.changeCredentials(credentialsRequest(), readOnly)

    expect(result.statusCode).toEqual(401)
    expect(changeCredentialsUseCase.execute).not.toHaveBeenCalled()
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('distinguishes a self-serve account deletion from the admin-initiated one', async () => {
    await controller.deleteAccount(
      { params: { userUuid: user.uuid }, headers: {} } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid: user.uuid,
        action: AuditAction.AccountDeleted,
        targetUuid: user.uuid,
        metadata: { selfInitiated: true },
      }),
    )
  })

  it('records no deletion event when the deletion fails', async () => {
    doDeleteAccount.execute.mockResolvedValueOnce(Result.fail('nope'))

    await controller.deleteAccount(
      { params: { userUuid: user.uuid }, headers: {} } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  /**
   * The one that matters: no password, nonce, address or server-password header
   * may reach the audit log on either the success or the failure path.
   */
  it('never leaks a submitted credential into any recorded event', async () => {
    const secrets = [
      'the-current-password',
      'the-new-password',
      'the-nonce',
      'attacker@example.com',
      'user@example.com',
      'server-password-header-value',
    ]

    const request = () =>
      ({
        params: { userUuid: user.uuid },
        body: {
          current_password: secrets[0],
          new_password: secrets[1],
          pw_nonce: secrets[2],
          new_email: secrets[3],
        },
        headers: { 'x-server-password': secrets[5] },
      }) as unknown as Request

    await controller.changeCredentials(request(), response())

    changeCredentialsUseCase.execute.mockResolvedValueOnce(Result.fail('Invalid password.'))
    await controller.changeCredentials(request(), response())

    await controller.deleteAccount(
      { params: { userUuid: user.uuid }, headers: { 'x-server-password': secrets[5] } } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledTimes(3)

    const recorded = JSON.stringify(auditLogWriter.write.mock.calls.map((call) => call[0] as AuditLogWriteParams))
    for (const secret of secrets) {
      expect(recorded).not.toContain(secret)
    }
  })
})
