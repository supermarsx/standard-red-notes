import 'reflect-metadata'

import { Request, Response } from 'express'
import { Result, RoleName } from '@standardnotes/domain-core'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { BaseAdminController } from './BaseAdminController'

/**
 * Standard Red Notes: RBAC group endpoints confer roles — and therefore
 * permissions — on their members. They were previously the only privilege
 * mutation on the admin surface that left no audit trail at all.
 */
describe('BaseAdminController group endpoints — privilege attribution audit', () => {
  const groupUuid = '00000000-0000-0000-0000-0000000000aa'
  const userUuid = '00000000-0000-0000-0000-0000000000bb'

  let auditLogWriter: jest.Mocked<AuditLogWriterInterface>
  let doCreateGroup: { execute: jest.Mock }
  let doDeleteGroup: { execute: jest.Mock }
  let doAddUserToGroup: { execute: jest.Mock }
  let doRemoveUserFromGroup: { execute: jest.Mock }
  let doSetGroupRoles: { execute: jest.Mock }
  let groupHttpMapper: { toProjection: jest.Mock }
  let adminResponse: Response
  let nonAdminResponse: Response

  // Positional construction, mirroring BaseAdminController.roles.spec.ts: the
  // audit-log writer is parameter 10 and the group deps start at parameter 20.
  const createController = () =>
    new BaseAdminController(
      {} as DeleteSetting,
      {} as GetSetting,
      {} as UserRepositoryInterface,
      {} as CreateSubscriptionToken,
      {} as CreateOfflineSubscriptionToken,
      {} as SetSettingValue,
      {} as SetUserBanStatus,
      undefined,
      undefined,
      auditLogWriter,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      doCreateGroup as never,
      undefined,
      doDeleteGroup as never,
      doAddUserToGroup as never,
      doRemoveUserFromGroup as never,
      doSetGroupRoles as never,
      undefined,
      undefined,
      groupHttpMapper as never,
    )

  beforeEach(() => {
    auditLogWriter = { write: jest.fn().mockResolvedValue(undefined) }

    const group = {
      id: { toString: () => groupUuid },
      props: { name: 'Support', description: null, roleNames: ['CORE_USER'] },
    }

    doCreateGroup = { execute: jest.fn().mockResolvedValue(Result.ok(group)) }
    doDeleteGroup = { execute: jest.fn().mockResolvedValue(Result.ok(groupUuid)) }
    doAddUserToGroup = { execute: jest.fn().mockResolvedValue(Result.ok(userUuid)) }
    doRemoveUserFromGroup = { execute: jest.fn().mockResolvedValue(Result.ok(userUuid)) }
    doSetGroupRoles = { execute: jest.fn().mockResolvedValue(Result.ok(group)) }
    groupHttpMapper = {
      toProjection: jest.fn().mockReturnValue({
        uuid: groupUuid,
        name: 'Support',
        description: null,
        roleNames: ['CORE_USER'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    }

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }], user: { uuid: 'admin-1' } },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }] },
    } as unknown as Response
  })

  const request = (overrides: Partial<{ params: unknown; body: unknown; headers: unknown }> = {}) =>
    ({
      params: { groupUuid, userUuid },
      body: {},
      headers: { 'x-origin-ip': '203.0.113.9' },
      ...overrides,
    }) as unknown as Request

  it('records the creation of a group with the roles it confers', async () => {
    await createController().createGroup(
      request({ body: { name: 'Support', roleNames: ['CORE_USER'] } }),
      adminResponse,
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid: 'admin-1',
        action: AuditAction.GroupChanged,
        targetType: 'group',
        targetUuid: groupUuid,
        ip: '203.0.113.9',
        metadata: { group: 'Support', created: true, roleNames: ['CORE_USER'] },
      }),
    )
  })

  it('records the deletion of a group', async () => {
    await createController().deleteGroup(request(), adminResponse)

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.GroupChanged,
        targetUuid: groupUuid,
        metadata: { deleted: true },
      }),
    )
  })

  it('records a replacement of the roles a group confers', async () => {
    await createController().setGroupRoles(request({ body: { roleNames: ['ADMIN_USER'] } }), adminResponse)

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.GroupChanged,
        targetType: 'group',
        targetUuid: groupUuid,
        metadata: { group: 'Support', roleNames: ['CORE_USER'] },
      }),
    )
  })

  it('records a group membership grant against the USER who gained the privilege', async () => {
    await createController().addUserToGroup(request({ body: { userUuid } }), adminResponse)

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid: 'admin-1',
        action: AuditAction.GroupMembershipChanged,
        targetType: 'user',
        targetUuid: userUuid,
        metadata: { groupUuid, added: true },
      }),
    )
  })

  it('records a group membership withdrawal', async () => {
    await createController().removeUserFromGroup(request(), adminResponse)

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.GroupMembershipChanged,
        targetType: 'user',
        targetUuid: userUuid,
        metadata: { groupUuid, added: false },
      }),
    )
  })

  it('records nothing when the membership grant fails', async () => {
    doAddUserToGroup.execute.mockResolvedValueOnce(Result.fail('group not found'))

    const result = await createController().addUserToGroup(request({ body: { userUuid } }), adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('does not weaken the admin gate to observe an event', async () => {
    const result = await createController().addUserToGroup(request({ body: { userUuid } }), nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doAddUserToGroup.execute).not.toHaveBeenCalled()
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })
})
