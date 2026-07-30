import 'reflect-metadata'

import { Result, SettingName } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { BaseSettingsController } from './BaseSettingsController'

describe('BaseSettingsController cross-service token cache invalidation', () => {
  const user = { uuid: 'user-1', email: 'user@example.com' }
  let setHeader: jest.Mock
  let setSettingValue: { execute: jest.Mock }
  let triggerPostSettingUpdateActions: { execute: jest.Mock }
  let doDeleteSetting: { execute: jest.Mock }
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
    settingHttMapper = { toProjection: jest.fn().mockReturnValue({ name: SettingName.NAMES.CaldavEnabled }) }

    controller = new BaseSettingsController(
      {} as never,
      {} as never,
      setSettingValue as never,
      triggerPostSettingUpdateActions as never,
      doDeleteSetting as never,
      {} as never,
      {} as never,
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
})
