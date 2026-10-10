import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { CaldavProjectionController } from './CaldavTokensController'
import { CaldavService } from '../../Service/Caldav/CaldavService'
import { DEFAULT_CALENDAR_PROJECTION } from '../../Service/Caldav/CalendarProjection'

describe('CaldavProjectionController', () => {
  let caldavService: jest.Mocked<CaldavService>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const controller = () => new CaldavProjectionController(caldavService as unknown as CaldavService)

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'user-1' }, settings },
      json: jsonMock,
      status: statusMock,
    } as unknown as Response
  }

  const allowed = (): Record<string, unknown> => ({ [SettingName.NAMES.CaldavEnabled]: 'true' })

  beforeEach(() => {
    caldavService = {
      isEnabled: jest.fn().mockReturnValue(true),
      getProjection: jest.fn().mockResolvedValue({ ...DEFAULT_CALENDAR_PROJECTION }),
      setProjection: jest.fn(async (_uuid: string, settings: unknown) => settings),
      resetProjection: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<CaldavService>
  })

  describe('read', () => {
    it('returns the settings alongside both gates', async () => {
      const response = responseWith(allowed())
      await controller().read({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({
        projection: DEFAULT_CALENDAR_PROJECTION,
        caldavEnabled: true,
        allowed: true,
      })
    })

    it('stays readable while the gates are shut, so the pane can explain WHY it is inactive', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith(undefined)
      await controller().read({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ caldavEnabled: false, allowed: false, projection: DEFAULT_CALENDAR_PROJECTION }),
      )
      expect(caldavService.getProjection).toHaveBeenCalledWith('user-1')
    })
  })

  describe('write', () => {
    it('refuses when the operator master switch is off', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith(allowed())
      await controller().write({ body: { enabled: true } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() }))
      expect(caldavService.setProjection).not.toHaveBeenCalled()
    })

    it('refuses when the per-user setting is absent: it fails CLOSED', async () => {
      const response = responseWith(undefined)
      await controller().write({ body: { enabled: true } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(caldavService.setProjection).not.toHaveBeenCalled()
    })

    it('accepts a bare settings object', async () => {
      const response = responseWith(allowed())
      await controller().write({ body: { enabled: true, allDay: 'always' } } as Request, response)
      expect(caldavService.setProjection).toHaveBeenCalledWith('user-1', { enabled: true, allDay: 'always' })
      expect(statusMock).toHaveBeenCalledWith(200)
    })

    it('accepts the { projection } envelope GET returns, so the client can round-trip', async () => {
      const response = responseWith(allowed())
      await controller().write({ body: { projection: { enabled: true } } } as Request, response)
      expect(caldavService.setProjection).toHaveBeenCalledWith('user-1', { enabled: true })
    })

    it('echoes the EFFECTIVE settings the store returned, not the submitted body', async () => {
      caldavService.setProjection = jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_CALENDAR_PROJECTION, enabled: true, durationMinutes: 1_440 })
      const response = responseWith(allowed())
      await controller().write({ body: { enabled: true, durationMinutes: 100_000 } } as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({
        projection: expect.objectContaining({ durationMinutes: 1_440 }),
      })
    })

    it('tolerates a missing body', async () => {
      const response = responseWith(allowed())
      await controller().write({} as Request, response)
      expect(caldavService.setProjection).toHaveBeenCalledWith('user-1', {})
    })
  })

  describe('reset', () => {
    it('stays available while the gates are shut, so a user can always stop the projection', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith(undefined)
      await controller().reset({} as Request, response)
      expect(statusMock).toHaveBeenCalledWith(200)
      expect(caldavService.resetProjection).toHaveBeenCalledWith('user-1')
      expect(jsonMock).toHaveBeenCalledWith({ reset: true, projection: DEFAULT_CALENDAR_PROJECTION })
    })
  })
})
