import 'reflect-metadata'

import { Request, Response } from 'express'
import { Result, RoleName, SettingName } from '@standardnotes/domain-core'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { BaseAdminController } from './BaseAdminController'

/**
 * Measured on the all-in-one before this was fixed: 18 malformed admin requests
 * answered 200 and changed stored state. An empty body to the registration
 * switch opened sign-ups, a string "false" closed them, a feature flag sent
 * without a value was cleared, and a role or group sent without its list lost
 * every permission or role. Each request below must now be refused with 400
 * and must not reach the use case that writes.
 */
describe('BaseAdminController refuses malformed admin write bodies without writing', () => {
  const userUuid = '00000000-0000-0000-0000-0000000000bb'
  const roleUuid = '00000000-0000-0000-0000-0000000000cc'
  const groupUuid = '00000000-0000-0000-0000-0000000000aa'

  let setSettingValue: { execute: jest.Mock }
  let doSetRolePermissions: { execute: jest.Mock }
  let doSetGroupRoles: { execute: jest.Mock }
  let doCreateCustomRole: { execute: jest.Mock }
  let doCreateGroup: { execute: jest.Mock }
  let auditLogWriter: jest.Mocked<AuditLogWriterInterface>
  let adminResponse: Response

  // Positional construction as in BaseAdminController.roles.spec.ts and
  // .groups.spec.ts: the audit-log writer is parameter 10, the group use cases
  // start at 20 (setGroupRoles is 25, the group mapper 28) and the role use
  // cases at 29.
  const createController = () =>
    new BaseAdminController(
      {} as DeleteSetting,
      {} as GetSetting,
      {} as UserRepositoryInterface,
      {} as CreateSubscriptionToken,
      {} as CreateOfflineSubscriptionToken,
      setSettingValue as unknown as SetSettingValue,
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
      undefined,
      undefined,
      undefined,
      doSetGroupRoles as never,
      undefined,
      undefined,
      { toProjection: jest.fn().mockReturnValue({ uuid: groupUuid, name: 'Support', roleNames: [] }) } as never,
      undefined,
      doSetRolePermissions as never,
      doCreateCustomRole as never,
    )

  const request = (body: unknown): Request =>
    ({
      params: { userUuid, roleUuid, groupUuid },
      body,
      headers: {},
    }) as unknown as Request

  beforeEach(() => {
    setSettingValue = { execute: jest.fn().mockResolvedValue(Result.ok({})) }
    doSetRolePermissions = {
      execute: jest.fn().mockResolvedValue(Result.ok({ uuid: roleUuid, name: 'CORE_USER', permissionNames: [] })),
    }
    doSetGroupRoles = {
      execute: jest
        .fn()
        .mockResolvedValue(Result.ok({ id: { toString: () => groupUuid }, props: { name: 'Support', roleNames: [] } })),
    }
    doCreateCustomRole = {
      execute: jest.fn().mockResolvedValue(Result.ok({ uuid: roleUuid, name: 'SUPPORT', permissionNames: [] })),
    }
    doCreateGroup = {
      execute: jest
        .fn()
        .mockResolvedValue(Result.ok({ id: { toString: () => groupUuid }, props: { name: 'Support', roleNames: [] } })),
    }
    auditLogWriter = { write: jest.fn().mockResolvedValue(undefined) }
    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }], user: { uuid: 'admin-1' } },
      setHeader: jest.fn(),
    } as unknown as Response
  })

  const errorMessage = (result: { json: unknown }): string =>
    (result.json as { error?: { message?: string } }).error?.message ?? ''

  describe('PUT /v1/admin/registration', () => {
    it.each([
      ['an empty body', {}],
      ['no body at all', undefined],
      ['the field missing', { somethingElse: true }],
      ['null', { registrationDisabled: null }],
      ['the string "false"', { registrationDisabled: 'false' }],
      ['the string "true"', { registrationDisabled: 'true' }],
      ['a number', { registrationDisabled: 0 }],
    ])('refuses %s with 400 and writes nothing', async (_label, body) => {
      const result = await createController().setRegistrationFlag(request(body), adminResponse)

      expect(result.statusCode).toEqual(400)
      expect(errorMessage(result)).toContain('registrationDisabled')
      expect(setSettingValue.execute).not.toHaveBeenCalled()
    })

    it.each([
      [true, 'true'],
      [false, 'false'],
    ])('stores an explicit boolean %s', async (registrationDisabled, stored) => {
      const result = await createController().setRegistrationFlag(request({ registrationDisabled }), adminResponse)

      expect(result.statusCode).toEqual(200)
      expect(result.json).toEqual({ success: true, registrationDisabled })
      expect(setSettingValue.execute).toHaveBeenCalledWith({
        settingName: SettingName.NAMES.RegistrationDisabled,
        value: stored,
        userUuid: 'admin-1',
        checkUserPermissions: false,
      })
    })
  })

  describe('PUT /v1/admin/users/:uuid/feature-flags', () => {
    const flags = [
      SettingName.NAMES.AiEnabled,
      SettingName.NAMES.CollaborationEnabled,
      SettingName.NAMES.LiveSyncEnabled,
      SettingName.NAMES.WorkflowsEnabled,
      SettingName.NAMES.AiRequestLimit,
      SettingName.NAMES.EmailBackupFrequency,
    ]

    it.each(flags)('refuses %s sent without a value instead of clearing it', async (name) => {
      const result = await createController().setUserFeatureFlag(request({ name }), adminResponse)

      expect(result.statusCode).toEqual(400)
      expect(errorMessage(result)).toContain('`value` is required')
      expect(setSettingValue.execute).not.toHaveBeenCalled()
      expect(adminResponse.setHeader).not.toHaveBeenCalled()
    })

    it.each([
      ['an empty body', {}],
      ['no body at all', undefined],
      ['a non-string name', { name: 7, value: 'true' }],
      ['an empty name', { name: '', value: 'true' }],
      ['an object value', { name: SettingName.NAMES.EmailBackupFrequency, value: { daily: true } }],
      ['an array value', { name: SettingName.NAMES.EmailBackupFrequency, value: ['daily'] }],
    ])('refuses %s with 400 and writes nothing', async (_label, body) => {
      const result = await createController().setUserFeatureFlag(request(body), adminResponse)

      expect(result.statusCode).toEqual(400)
      expect(setSettingValue.execute).not.toHaveBeenCalled()
    })

    it('still clears a setting on an explicit null, which is how the Users pane clears an AI limit', async () => {
      const result = await createController().setUserFeatureFlag(
        request({ name: SettingName.NAMES.AiRequestLimit, value: null }),
        adminResponse,
      )

      expect(result.statusCode).toEqual(200)
      expect(setSettingValue.execute).toHaveBeenCalledWith({
        settingName: SettingName.NAMES.AiRequestLimit,
        value: null,
        userUuid,
        checkUserPermissions: false,
      })
    })

    it('still stores a well-formed value', async () => {
      const result = await createController().setUserFeatureFlag(
        request({ name: SettingName.NAMES.AiEnabled, value: 'false' }),
        adminResponse,
      )

      expect(result.statusCode).toEqual(200)
      expect(setSettingValue.execute).toHaveBeenCalledWith(
        expect.objectContaining({ settingName: SettingName.NAMES.AiEnabled, value: 'false' }),
      )
    })
  })

  describe('PUT /v1/admin/roles/:uuid/permissions', () => {
    it.each([
      ['an empty body', {}],
      ['no body at all', undefined],
      ['null', { permissionNames: null }],
      ['a single name instead of a list', { permissionNames: 'SYNC_ITEMS' }],
      ['a list with a non-name in it', { permissionNames: ['SYNC_ITEMS', 3] }],
    ])('refuses %s with 400 instead of removing every permission', async (_label, body) => {
      const result = await createController().setRolePermissions(request(body), adminResponse)

      expect(result.statusCode).toEqual(400)
      expect(errorMessage(result)).toContain('permissionNames')
      expect(doSetRolePermissions.execute).not.toHaveBeenCalled()
      expect(auditLogWriter.write).not.toHaveBeenCalled()
    })

    it.each([[['SYNC_ITEMS']], [[]]])(
      'accepts an explicit list %j (empty is the pane unticking every permission)',
      async (permissionNames) => {
        const result = await createController().setRolePermissions(request({ permissionNames }), adminResponse)

        expect(result.statusCode).toEqual(200)
        expect(doSetRolePermissions.execute).toHaveBeenCalledWith({ roleUuid, permissionNames })
      },
    )
  })

  describe('PUT /v1/admin/groups/:uuid/roles', () => {
    it.each([
      ['an empty body', {}],
      ['no body at all', undefined],
      ['null', { roleNames: null }],
      ['a single name instead of a list', { roleNames: 'PRO_USER' }],
      ['a list with a non-name in it', { roleNames: ['PRO_USER', null] }],
    ])('refuses %s with 400 instead of removing every role', async (_label, body) => {
      const result = await createController().setGroupRoles(request(body), adminResponse)

      expect(result.statusCode).toEqual(400)
      expect(errorMessage(result)).toContain('roleNames')
      expect(doSetGroupRoles.execute).not.toHaveBeenCalled()
      expect(auditLogWriter.write).not.toHaveBeenCalled()
    })

    it.each([[['PRO_USER']], [[]]])(
      'accepts an explicit list %j (empty is the pane unticking the last role)',
      async (roleNames) => {
        const result = await createController().setGroupRoles(request({ roleNames }), adminResponse)

        expect(result.statusCode).toEqual(200)
        expect(doSetGroupRoles.execute).toHaveBeenCalledWith({ groupUuid, roleNames })
      },
    )
  })

  describe('creating a role or a group', () => {
    it('refuses a role whose permissionNames is not a list', async () => {
      const result = await createController().createCustomRole(
        request({ name: 'SUPPORT', permissionNames: 'SYNC_ITEMS' }),
        adminResponse,
      )

      expect(result.statusCode).toEqual(400)
      expect(doCreateCustomRole.execute).not.toHaveBeenCalled()
    })

    it('refuses a group whose roleNames is not a list', async () => {
      const result = await createController().createGroup(
        request({ name: 'Support', roleNames: 'PRO_USER' }),
        adminResponse,
      )

      expect(result.statusCode).toEqual(400)
      expect(doCreateGroup.execute).not.toHaveBeenCalled()
    })

    it('still creates a role or a group that starts empty when the list is left out', async () => {
      await createController().createCustomRole(request({ name: 'SUPPORT' }), adminResponse)
      await createController().createGroup(request({ name: 'Support' }), adminResponse)

      expect(doCreateCustomRole.execute).toHaveBeenCalledWith({
        name: 'SUPPORT',
        description: null,
        permissionNames: [],
      })
      expect(doCreateGroup.execute).toHaveBeenCalledWith({ name: 'Support', description: null, roleNames: [] })
    })
  })
})
