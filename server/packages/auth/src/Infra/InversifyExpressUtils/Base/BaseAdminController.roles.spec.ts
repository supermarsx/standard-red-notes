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
import { CreateCustomRole } from '../../../Domain/UseCase/CreateCustomRole/CreateCustomRole'
import { DeleteCustomRole } from '../../../Domain/UseCase/DeleteCustomRole/DeleteCustomRole'
import { GetPermissionCatalog } from '../../../Domain/UseCase/GetPermissionCatalog/GetPermissionCatalog'
import { GetRoleHolders } from '../../../Domain/UseCase/GetRoleHolders/GetRoleHolders'
import { ResolveRoleSetPermissions } from '../../../Domain/UseCase/ResolveRoleSetPermissions/ResolveRoleSetPermissions'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { BaseAdminController } from './BaseAdminController'

describe('BaseAdminController role endpoints', () => {
  let doListRolesWithPermissions: ListRolesWithPermissions
  let doSetRolePermissions: SetRolePermissions
  let doCreateCustomRole: CreateCustomRole
  let doDeleteCustomRole: DeleteCustomRole
  let doGetPermissionCatalog: GetPermissionCatalog
  let doGetRoleHolders: GetRoleHolders
  let doResolveRoleSetPermissions: ResolveRoleSetPermissions
  let auditLogWriter: AuditLogWriterInterface
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  const roleUuid = '00000000-0000-0000-0000-000000000001'

  // Construct the controller with only the parameters these tests exercise:
  // the audit-log writer (position 10) and the trailing role management use cases.
  const createController = (options?: { withRoleUseCases?: boolean }) => {
    const on = options?.withRoleUseCases !== false
    return new BaseAdminController(
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
      on ? doListRolesWithPermissions : undefined,
      on ? doSetRolePermissions : undefined,
      on ? doCreateCustomRole : undefined,
      on ? doDeleteCustomRole : undefined,
      on ? doGetPermissionCatalog : undefined,
      on ? doGetRoleHolders : undefined,
      on ? doResolveRoleSetPermissions : undefined,
    )
  }

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

    doCreateCustomRole = {} as jest.Mocked<CreateCustomRole>
    doCreateCustomRole.execute = jest.fn().mockResolvedValue(
      Result.ok({
        uuid: roleUuid,
        name: 'SUPPORT_AGENT',
        version: 1,
        isBuiltIn: false,
        isCustom: true,
        description: null,
        permissionNames: ['SYNC_ITEMS'],
      }),
    )

    doDeleteCustomRole = {} as jest.Mocked<DeleteCustomRole>
    doDeleteCustomRole.execute = jest.fn().mockResolvedValue(Result.ok({ uuid: roleUuid, name: 'SUPPORT_AGENT' }))

    doGetPermissionCatalog = {} as jest.Mocked<GetPermissionCatalog>
    doGetPermissionCatalog.execute = jest
      .fn()
      .mockResolvedValue(
        Result.ok({ permissions: [{ name: 'SYNC_ITEMS', category: 'general', grantedByRoleNames: ['CORE_USER'] }], categories: ['general'] }),
      )

    doGetRoleHolders = {} as jest.Mocked<GetRoleHolders>
    doGetRoleHolders.execute = jest
      .fn()
      .mockResolvedValue(Result.ok({ uuid: roleUuid, name: 'CORE_USER', directUserCount: 2, groups: [] }))

    doResolveRoleSetPermissions = {} as jest.Mocked<ResolveRoleSetPermissions>
    doResolveRoleSetPermissions.execute = jest
      .fn()
      .mockResolvedValue(
        Result.ok({ roleNames: ['CORE_USER'], unknownRoleNames: [], effectivePermissionNames: ['SYNC_ITEMS'], perRole: [] }),
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

  // ---- Custom role create -----------------------------------------------------
  it('createCustomRole rejects a non-admin with 403', async () => {
    const result = await createController().createCustomRole(
      { params: {}, body: { name: 'Support' }, headers: {} } as unknown as Request,
      nonAdminResponse,
    )

    expect(result.statusCode).toEqual(403)
    expect(doCreateCustomRole.execute).not.toHaveBeenCalled()
  })

  it('createCustomRole creates a role and writes an audit entry for an admin', async () => {
    const result = await createController().createCustomRole(
      { params: {}, body: { name: 'Support Agent', permissionNames: ['SYNC_ITEMS'] }, headers: {} } as unknown as Request,
      adminResponse,
    )

    expect(result.json).toMatchObject({ role: { name: 'SUPPORT_AGENT', isCustom: true } })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RoleChanged, targetType: 'role' }),
    )
  })

  it('createCustomRole surfaces a use case failure (e.g. reserved name) as 400', async () => {
    doCreateCustomRole.execute = jest.fn().mockResolvedValue(Result.fail('reserved built-in role name'))

    const result = await createController().createCustomRole(
      { params: {}, body: { name: 'CORE_USER' }, headers: {} } as unknown as Request,
      adminResponse,
    )

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('createCustomRole reports 500 when not wired', async () => {
    const result = await createController({ withRoleUseCases: false }).createCustomRole(
      { params: {}, body: { name: 'Support' }, headers: {} } as unknown as Request,
      adminResponse,
    )

    expect(result.statusCode).toEqual(500)
  })

  // ---- Custom role delete -----------------------------------------------------
  it('deleteCustomRole rejects a non-admin with 403', async () => {
    const result = await createController().deleteCustomRole(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doDeleteCustomRole.execute).not.toHaveBeenCalled()
  })

  it('deleteCustomRole removes the role and audits it for an admin', async () => {
    const result = await createController().deleteCustomRole(request, adminResponse)

    expect(doDeleteCustomRole.execute).toHaveBeenCalledWith({ roleUuid })
    expect(result.json).toMatchObject({ success: true, name: 'SUPPORT_AGENT' })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RoleChanged, targetType: 'role' }),
    )
  })

  it('deleteCustomRole surfaces a guard failure (built-in / in use) as 400', async () => {
    doDeleteCustomRole.execute = jest.fn().mockResolvedValue(Result.fail('is a built-in role and cannot be deleted'))

    const result = await createController().deleteCustomRole(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  // ---- Permission catalog / inspector / simulator ----------------------------
  it('getPermissionCatalog rejects a non-admin with 403', async () => {
    const result = await createController().getPermissionCatalog(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doGetPermissionCatalog.execute).not.toHaveBeenCalled()
  })

  it('getPermissionCatalog returns the catalog for an admin', async () => {
    const result = await createController().getPermissionCatalog(request, adminResponse)

    expect(result.json).toMatchObject({ permissions: expect.any(Array), categories: ['general'] })
  })

  it('getRoleHolders returns holders for an admin and 403 for a non-admin', async () => {
    expect((await createController().getRoleHolders(request, nonAdminResponse)).statusCode).toEqual(403)

    const result = await createController().getRoleHolders(request, adminResponse)
    expect(result.json).toMatchObject({ directUserCount: 2 })
  })

  it('resolveRoleSetPermissions unions permissions for an admin and 403 for a non-admin', async () => {
    expect((await createController().resolveRoleSetPermissions(request, nonAdminResponse)).statusCode).toEqual(403)

    const result = await createController().resolveRoleSetPermissions(
      { params: {}, body: { roleNames: ['CORE_USER'] }, headers: {} } as unknown as Request,
      adminResponse,
    )
    expect(result.json).toMatchObject({ effectivePermissionNames: ['SYNC_ITEMS'] })
  })

  it('the new read/simulator endpoints report 500 when not wired', async () => {
    const controller = createController({ withRoleUseCases: false })
    expect((await controller.getPermissionCatalog(request, adminResponse)).statusCode).toEqual(500)
    expect((await controller.getRoleHolders(request, adminResponse)).statusCode).toEqual(500)
    expect((await controller.resolveRoleSetPermissions(request, adminResponse)).statusCode).toEqual(500)
  })
})
