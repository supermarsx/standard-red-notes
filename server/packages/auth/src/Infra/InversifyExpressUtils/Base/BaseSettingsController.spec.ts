import 'reflect-metadata'

import { Result, SettingName } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { BaseSettingsController } from './BaseSettingsController'
import { SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE } from '../../../Domain/Auth/SecurityStepUp'

describe('BaseSettingsController cross-service token cache invalidation', () => {
  const user = { uuid: 'user-1', email: 'user@example.com' }
  let setHeader: jest.Mock
  let doGetSettings: { execute: jest.Mock }
  let doGetSetting: { execute: jest.Mock }
  let setSettingValue: { execute: jest.Mock }
  let triggerPostSettingUpdateActions: { execute: jest.Mock }
  let doDeleteSetting: { execute: jest.Mock }
  let validateMfaToken: { execute: jest.Mock }
  let settingHttMapper: { toProjection: jest.Mock }
  let controller: BaseSettingsController

  const response = (): Response =>
    ({
      locals: {
        user,
        readOnlyAccess: false,
        authTokenVersion: 1,
      },
      setHeader,
    }) as unknown as Response

  beforeEach(() => {
    setHeader = jest.fn()
    doGetSettings = { execute: jest.fn().mockResolvedValue(Result.ok({ settings: [], subscriptionSettings: [] })) }
    doGetSetting = { execute: jest.fn().mockResolvedValue(Result.fail('not found')) }
    setSettingValue = {
      execute: jest.fn().mockResolvedValue(
        Result.ok({
          props: {
            name: SettingName.NAMES.CaldavEnabled,
            sensitive: false,
          },
        }),
      ),
    }
    triggerPostSettingUpdateActions = { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) }
    doDeleteSetting = { execute: jest.fn().mockResolvedValue({ success: true }) }
    validateMfaToken = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    settingHttMapper = { toProjection: jest.fn().mockReturnValue({ name: SettingName.NAMES.CaldavEnabled }) }

    controller = new BaseSettingsController(
      doGetSettings as never,
      doGetSetting as never,
      setSettingValue as never,
      triggerPostSettingUpdateActions as never,
      doDeleteSetting as never,
      {} as never,
      validateMfaToken as never,
      settingHttMapper as never,
      {} as never,
      { error: jest.fn() } as never,
    )
  })

  it('invalidates cached cross-service tokens after every successful setting update', async () => {
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.CaldavEnabled, value: 'true' },
      } as unknown as Request,
      response(),
    )

    expect(setHeader).toHaveBeenCalledWith('x-invalidate-cache', user.uuid)
  })

  it('does not invalidate cached tokens when a setting update fails', async () => {
    setSettingValue.execute.mockResolvedValueOnce(Result.fail('invalid setting'))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.CaldavEnabled, value: 'true' },
      } as unknown as Request,
      response(),
    )

    expect(setHeader).not.toHaveBeenCalled()
  })

  it('invalidates cached cross-service tokens only after a successful setting deletion', async () => {
    const request = {
      params: { userUuid: user.uuid, settingName: SettingName.NAMES.CaldavEnabled },
      headers: {},
    } as unknown as Request

    await controller.deleteSetting(request, response())
    expect(setHeader).toHaveBeenCalledWith('x-invalidate-cache', user.uuid)

    setHeader.mockClear()
    doDeleteSetting.execute.mockResolvedValueOnce({ success: false })
    await controller.deleteSetting(request, response())
    expect(setHeader).not.toHaveBeenCalled()
  })

  it('rejects case-insensitive reads of private Nextcloud lifecycle state before the use case runs', async () => {
    const result = await controller.getSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.NextcloudBackupDeliveryState.toLowerCase() },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(result.statusCode).toBe(401)
    expect(result.json).toEqual({ error: { message: 'Operation not allowed.' } })
    expect(doGetSetting.execute).not.toHaveBeenCalled()
  })

  it('rejects case-insensitive deletion of private Nextcloud lifecycle state before the use case runs', async () => {
    const result = await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.NextcloudBackupDeliveryState.toLowerCase() },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(result.statusCode).toBe(401)
    expect(result.json).toEqual({ error: { message: 'Operation not allowed.' } })
    expect(doDeleteSetting.execute).not.toHaveBeenCalled()
  })

  it('rejects case-insensitive writes of private Nextcloud lifecycle state before the use case runs', async () => {
    const result = await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: {
          name: SettingName.NAMES.NextcloudBackupDeliveryState.toLowerCase(),
          value: '{"activeRequest":null}',
        },
      } as unknown as Request,
      response(),
    )

    expect(result.statusCode).toBe(401)
    expect(result.json).toEqual({ error: { message: 'Operation not allowed.' } })
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('does not update MFA when a legacy token cannot provide TOTP step-up proof', async () => {
    validateMfaToken.execute.mockResolvedValueOnce(Result.fail(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'encrypted-secret', totpToken: '123456' },
      } as unknown as Request,
      response(),
    )

    expect(validateMfaToken.execute).toHaveBeenCalledWith({
      userUuid: user.uuid,
      totpToken: '123456',
      authTokenVersion: 1,
    })
    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(setHeader).not.toHaveBeenCalled()
  })
})
