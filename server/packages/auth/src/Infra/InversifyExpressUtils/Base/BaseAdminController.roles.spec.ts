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
import { ListRolesWithPermissions } from '../../../Domain/UseCase/ListRolesWithPermissions/ListRolesWithPermissions'
import { SetRolePermissions } from '../../../Domain/UseCase/SetRolePermissions/SetRolePermissions'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { BaseAdminController } from './BaseAdminController'

describe('BaseAdminController role endpoints', () => {
  let doListRolesWithPermissions: ListRolesWithPermissions
  let doSetRolePermissions: SetRolePermissions
  let auditLogWriter: AuditLogWriterInterface
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  const roleUuid = '00000000-0000-0000-0000-000000000001'

  // Construct the controller with only the parameters these tests exercise:
  // the audit-log writer (position 10) and the two trailing role use cases.
  const createController = (options?: { withRoleUseCases?: boolean }) =>
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options?.withRoleUseCases === false ? undefined : doListRolesWithPermissions,
      options?.withRoleUseCases === false ? undefined : doSetRolePermissions,
    )

  beforeEach(() => {
    doListRolesWithPermissions = {} as jest.Mocked<ListRolesWithPermissions>
    doListRolesWithPermissions.execute = jest.fn().mockResolvedValue(
      Result.ok({
        roles: [{ uuid: roleUuid, name: 'CORE_USER', version: 1, isBuiltIn: true, permissionNames: ['SYNC_ITEMS'] }],
        permissions: ['SYNC_ITEMS'],
        builtInRoleNames: Object.values(RoleName.NAMES),
      }),
    )

    doSetRolePermissions = {} as jest.Mocked<SetRolePermissions>
    doSetRolePermissions.execute = jest.fn().mockResolvedValue(
      Result.ok({ uuid: roleUuid, name: 'CORE_USER', version: 1, isBuiltIn: true, permissionNames: ['SYNC_ITEMS'] }),
    )

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn().mockResolvedValue(undefined)

    request = {
      params: { roleUuid },
      body: { permissionNames: ['SYNC_ITEMS'] },
      headers: {},
    } as unknown as Request

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.InternalTeamUser }], user: { uuid: 'admin-1' } },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }] },
    } as unknown as Response
  })

  it('listRolesWithPermissions rejects a non-admin with 403', async () => {
    const result = await createController().listRolesWithPermissions(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doListRolesWithPermissions.execute).not.toHaveBeenCalled()
  })

  it('listRolesWithPermissions returns roles + catalog for an admin', async () => {
    const result = await createController().listRolesWithPermissions(request, adminResponse)

    expect(result.json).toMatchObject({ roles: expect.any(Array), permissions: ['SYNC_ITEMS'] })
  })

  it('listRolesWithPermissions reports 500 when the use case is not wired', async () => {
    const result = await createController({ withRoleUseCases: false }).listRolesWithPermissions(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })

  it('setRolePermissions rejects a non-admin with 403 — NOT 401', async () => {
    const result = await createController().setRolePermissions(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(result.statusCode).not.toEqual(401)
    expect(doSetRolePermissions.execute).not.toHaveBeenCalled()
  })

  it('setRolePermissions updates permissions and writes an audit entry for an admin', async () => {
    const result = await createController().setRolePermissions(request, adminResponse)

    expect(doSetRolePermissions.execute).toHaveBeenCalledWith({ roleUuid, permissionNames: ['SYNC_ITEMS'] })
    expect(result.json).toMatchObject({ role: { name: 'CORE_USER', isBuiltIn: true } })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RoleChanged, targetType: 'role', targetUuid: roleUuid }),
    )
  })

  it('setRolePermissions surfaces a use case failure (e.g. unknown permission) as a 400', async () => {
    doSetRolePermissions.execute = jest.fn().mockResolvedValue(Result.fail('unknown permission(s): MADE_UP'))

    const result = await createController().setRolePermissions(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('setRolePermissions reports 500 when the use case is not wired', async () => {
    const result = await createController({ withRoleUseCases: false }).setRolePermissions(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })
})
