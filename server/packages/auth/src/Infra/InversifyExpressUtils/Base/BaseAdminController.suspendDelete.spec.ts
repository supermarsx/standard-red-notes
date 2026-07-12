import 'reflect-metadata'

import { Request, Response } from 'express'
import { Result, RoleName } from '@standardnotes/domain-core'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { SetUserSuspension } from '../../../Domain/UseCase/SetUserSuspension/SetUserSuspension'
import { DeleteAccount } from '../../../Domain/UseCase/DeleteAccount/DeleteAccount'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { User } from '../../../Domain/User/User'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../../../Domain/Webhook/WebhookDispatcherInterface'
import { BaseAdminController } from './BaseAdminController'

describe('BaseAdminController suspend + delete endpoints', () => {
  let userRepository: UserRepositoryInterface
  let doSetUserSuspension: SetUserSuspension
  let doDeleteAccount: DeleteAccount
  let auditLogWriter: AuditLogWriterInterface
  let webhookDispatcher: WebhookDispatcherInterface
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  const targetUuid = '00000000-0000-0000-0000-000000000002'
  const actorUuid = '00000000-0000-0000-0000-000000000001'

  // Build a target user with a resolvable `roles` relation (admin or not).
  const makeTarget = (isAdmin: boolean): User =>
    ({
      uuid: targetUuid,
      email: 'target@test.com',
      suspended: false,
      suspendedAt: null,
      suspendedReason: null,
      isSuspended: () => false,
      roles: Promise.resolve(isAdmin ? [{ name: RoleName.NAMES.AdminUser }] : []),
    }) as unknown as User

  // The controller has many optional trailing deps. Construct with the base
  // required 7, plus the audit writer (position 10) and webhook dispatcher
  // (position 12) that these endpoints exercise, then a run of undefineds up to
  // lockRepository, then the two new trailing suspend/delete deps.
  const createController = (options?: { withSuspension?: boolean; withDeletion?: boolean }) => {
    const suspension = options?.withSuspension === false ? undefined : doSetUserSuspension
    const deletion = options?.withDeletion === false ? undefined : doDeleteAccount
    return new BaseAdminController(
      {} as DeleteSetting,
      {} as GetSetting,
      userRepository,
      {} as CreateSubscriptionToken,
      {} as CreateOfflineSubscriptionToken,
      {} as SetSettingValue,
      {} as SetUserBanStatus,
      undefined,
      undefined,
      auditLogWriter,
      undefined,
      webhookDispatcher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      suspension,
      deletion,
    )
  }

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(makeTarget(false))
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(makeTarget(false))
    // Default: two admins exist, so the last-admin guard does not trip.
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ rows: [], total: 2 })

    doSetUserSuspension = {} as jest.Mocked<SetUserSuspension>
    doSetUserSuspension.execute = jest.fn().mockResolvedValue(
      Result.ok({
        uuid: targetUuid,
        suspended: true,
        suspendedAt: new Date('2026-07-11T00:00:00.000Z'),
        suspendedReason: 'review',
        isSuspended: () => true,
      } as unknown as User),
    )

    doDeleteAccount = {} as jest.Mocked<DeleteAccount>
    doDeleteAccount.execute = jest.fn().mockResolvedValue(Result.ok('Successfully deleted account.'))

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn().mockResolvedValue(undefined)

    webhookDispatcher = {} as jest.Mocked<WebhookDispatcherInterface>
    webhookDispatcher.dispatch = jest.fn().mockResolvedValue(undefined)

    request = {
      params: { userUuid: targetUuid, email: 'target@test.com' },
      body: {},
      headers: {},
    } as unknown as Request

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }], user: { uuid: actorUuid } },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }], user: { uuid: actorUuid } },
    } as unknown as Response
  })

  /* SUSPENSION ---------------------------------------------------------- */

  it('setUserSuspensionEndpoint rejects a non-admin requestor with 403', async () => {
    request.body = { suspended: true }
    const result = await createController().setUserSuspensionEndpoint(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doSetUserSuspension.execute).not.toHaveBeenCalled()
  })

  it('setUserSuspensionEndpoint returns 500 when the use case is not wired', async () => {
    request.body = { suspended: true }
    const result = await createController({ withSuspension: false }).setUserSuspensionEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })

  it('setUserSuspensionEndpoint requires a boolean suspended flag', async () => {
    request.body = {}
    const result = await createController().setUserSuspensionEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doSetUserSuspension.execute).not.toHaveBeenCalled()
  })

  it('setUserSuspensionEndpoint refuses to suspend your own account', async () => {
    request.params = { userUuid: actorUuid } as unknown as Request['params']
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ ...makeTarget(false), uuid: actorUuid })
    request.body = { suspended: true }

    const result = await createController().setUserSuspensionEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doSetUserSuspension.execute).not.toHaveBeenCalled()
  })

  it('setUserSuspensionEndpoint refuses to suspend the last administrator', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(makeTarget(true))
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ rows: [], total: 1 })
    request.body = { suspended: true }

    const result = await createController().setUserSuspensionEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doSetUserSuspension.execute).not.toHaveBeenCalled()
  })

  it('setUserSuspensionEndpoint suspends a user and writes an audit entry', async () => {
    request.body = { suspended: true, suspendedReason: 'review' }

    const result = await createController().setUserSuspensionEndpoint(request, adminResponse)

    expect(doSetUserSuspension.execute).toHaveBeenCalledWith({
      userUuid: targetUuid,
      suspended: true,
      suspendedReason: 'review',
    })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.SuspensionChanged, targetUuid }),
    )
    expect(webhookDispatcher.dispatch).toHaveBeenCalled()
    expect(result.json).toMatchObject({ success: true, suspended: true })
  })

  it('setUserSuspensionEndpoint unsuspends without applying the suspend-only guards', async () => {
    // Even the last admin can be UNsuspended (guards apply only when suspending).
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(makeTarget(true))
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ rows: [], total: 1 })
    doSetUserSuspension.execute = jest.fn().mockResolvedValue(
      Result.ok({
        uuid: targetUuid,
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
        isSuspended: () => false,
      } as unknown as User),
    )
    request.body = { suspended: false }

    const result = await createController().setUserSuspensionEndpoint(request, adminResponse)

    expect(doSetUserSuspension.execute).toHaveBeenCalledWith({
      userUuid: targetUuid,
      suspended: false,
      suspendedReason: null,
    })
    expect(result.json).toMatchObject({ success: true, suspended: false })
  })

  it('getUserSuspensionStatus returns the current suspension state', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({
      uuid: targetUuid,
      email: 'target@test.com',
      suspendedAt: new Date('2026-07-11T00:00:00.000Z'),
      suspendedReason: 'review',
      isSuspended: () => true,
    } as unknown as User)

    const result = await createController().getUserSuspensionStatus(request, adminResponse)

    expect(result.json).toMatchObject({
      uuid: targetUuid,
      email: 'target@test.com',
      suspended: true,
      suspendedReason: 'review',
    })
  })

  /* DELETE -------------------------------------------------------------- */

  it('deleteUser rejects a non-admin requestor with 403', async () => {
    request.body = { confirmEmail: 'target@test.com' }
    const result = await createController().deleteUser(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doDeleteAccount.execute).not.toHaveBeenCalled()
  })

  it('deleteUser returns 500 when the delete pipeline is not wired', async () => {
    request.body = { confirmEmail: 'target@test.com' }
    const result = await createController({ withDeletion: false }).deleteUser(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })

  it('deleteUser refuses to delete your own account', async () => {
    request.params = { userUuid: actorUuid } as unknown as Request['params']
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ ...makeTarget(false), uuid: actorUuid })
    request.body = { confirmEmail: 'target@test.com' }

    const result = await createController().deleteUser(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doDeleteAccount.execute).not.toHaveBeenCalled()
  })

  it('deleteUser refuses to delete the last administrator', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(makeTarget(true))
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ rows: [], total: 1 })
    request.body = { confirmEmail: 'target@test.com' }

    const result = await createController().deleteUser(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doDeleteAccount.execute).not.toHaveBeenCalled()
  })

  it('deleteUser refuses when confirmEmail does not match the target email', async () => {
    request.body = { confirmEmail: 'wrong@test.com' }

    const result = await createController().deleteUser(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doDeleteAccount.execute).not.toHaveBeenCalled()
  })

  it('deleteUser delegates to DeleteAccount, audits, and returns success on a matching confirmEmail', async () => {
    // A case-insensitive, whitespace-trimmed match is accepted.
    request.body = { confirmEmail: ' Target@Test.com ' }

    const result = await createController().deleteUser(request, adminResponse)

    expect(doDeleteAccount.execute).toHaveBeenCalledWith({ userUuid: targetUuid })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AccountDeleted, targetUuid }),
    )
    expect(webhookDispatcher.dispatch).toHaveBeenCalled()
    expect(result.json).toMatchObject({ success: true, userUuid: targetUuid, email: 'target@test.com' })
  })
})
