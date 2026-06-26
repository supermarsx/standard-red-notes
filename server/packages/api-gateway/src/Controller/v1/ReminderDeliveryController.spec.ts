import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { ReminderDeliveryController } from './ReminderDeliveryController'
import { ReminderDeliveryService } from '../../Service/ReminderDelivery/ReminderDeliveryService'

describe('ReminderDeliveryController', () => {
  let service: jest.Mocked<ReminderDeliveryService>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = () => new ReminderDeliveryController(service as unknown as ReminderDeliveryService)

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'user-1' }, settings },
      json: jsonMock,
      status: statusMock,
    } as unknown as Response
  }

  const allowed = { [SettingName.NAMES.ReminderDeliveryEnabled]: 'true' }

  beforeEach(() => {
    service = {
      isEnabled: jest.fn().mockReturnValue(true),
      publish: jest.fn(),
      listReminders: jest.fn(),
      getConfig: jest.fn(),
      setConfig: jest.fn(),
    } as unknown as jest.Mocked<ReminderDeliveryService>
  })

  describe('config', () => {
    it('reports available only when env enabled AND user allowed', async () => {
      await makeController().config({} as Request, responseWith(allowed))
      expect(jsonMock).toHaveBeenCalledWith({ reminderDeliveryEnabled: true, allowed: true, available: true })
    })

    it('fails closed (not allowed) when settings are absent', async () => {
      await makeController().config({} as Request, responseWith(undefined))
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, available: false }))
    })

    it('reports not available when env disabled even if allowed', async () => {
      service.isEnabled.mockReturnValue(false)
      await makeController().config({} as Request, responseWith(allowed))
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reminderDeliveryEnabled: false, available: false }))
    })
  })

  describe('gating', () => {
    it('list refuses with 403 when the env master switch is off', async () => {
      service.isEnabled.mockReturnValue(false)
      await makeController().list({} as Request, responseWith(allowed))
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(service.listReminders).not.toHaveBeenCalled()
    })

    it('list refuses with 403 when the user is not allowed', async () => {
      await makeController().list({} as Request, responseWith({ [SettingName.NAMES.ReminderDeliveryEnabled]: 'false' }))
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(service.listReminders).not.toHaveBeenCalled()
    })

    it('publish fails closed when settings are absent', async () => {
      await makeController().publish(
        { body: { id: 'r1', message: 'x', dueAtUtc: '2026-06-25T12:00:00.000Z' } } as Request,
        responseWith(undefined),
      )
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(service.publish).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('returns the user reminders when enabled and allowed', async () => {
      service.listReminders.mockResolvedValue([])
      await makeController().list({} as Request, responseWith(allowed))
      expect(service.listReminders).toHaveBeenCalledWith('user-1')
      expect(jsonMock).toHaveBeenCalledWith({ reminders: [] })
    })
  })

  describe('publish', () => {
    it('rejects an invalid dueAtUtc with 400', async () => {
      await makeController().publish({ body: { id: 'r1', dueAtUtc: 'nope' } } as Request, responseWith(allowed))
      expect(statusMock).toHaveBeenCalledWith(400)
      expect(service.publish).not.toHaveBeenCalled()
    })

    it('persists a valid published reminder and returns 201', async () => {
      service.publish.mockResolvedValue({
        id: 'r1',
        message: 'Call Bob',
        dueAtUtc: '2026-06-25T12:00:00.000Z',
        sent: false,
        createdAt: 1,
        updatedAt: 1,
      })
      await makeController().publish(
        { body: { id: 'r1', message: 'Call Bob', dueAtUtc: '2026-06-25T12:00:00.000Z' } } as Request,
        responseWith(allowed),
      )
      expect(service.publish).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ id: 'r1', message: 'Call Bob', dueAtUtc: '2026-06-25T12:00:00.000Z' }),
      )
      expect(statusMock).toHaveBeenCalledWith(201)
    })
  })

  describe('setDeliveryConfig', () => {
    it('rejects an invalid channel with 400', async () => {
      await makeController().setDeliveryConfig(
        { body: { channel: 'carrier-pigeon', destination: 'x', enabled: true } } as Request,
        responseWith(allowed),
      )
      expect(statusMock).toHaveBeenCalledWith(400)
      expect(service.setConfig).not.toHaveBeenCalled()
    })

    it('saves a valid config', async () => {
      service.setConfig.mockResolvedValue({ channel: 'telegram', destination: 'chat-1', enabled: true })
      await makeController().setDeliveryConfig(
        { body: { channel: 'telegram', destination: 'chat-1', enabled: true } } as Request,
        responseWith(allowed),
      )
      expect(service.setConfig).toHaveBeenCalledWith('user-1', {
        channel: 'telegram',
        destination: 'chat-1',
        enabled: true,
      })
    })
  })
})
