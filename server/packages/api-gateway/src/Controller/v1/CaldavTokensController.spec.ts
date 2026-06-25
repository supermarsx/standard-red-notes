import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { CaldavTokensController } from './CaldavTokensController'
import { CaldavService } from '../../Service/Caldav/CaldavService'

describe('CaldavTokensController', () => {
  let caldavService: jest.Mocked<CaldavService>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = () => new CaldavTokensController(caldavService as unknown as CaldavService)

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'user-1' }, settings },
      json: jsonMock,
      status: statusMock,
    } as unknown as Response
  }

  beforeEach(() => {
    caldavService = {
      isEnabled: jest.fn().mockReturnValue(true),
      createToken: jest.fn(),
      listTokens: jest.fn(),
      revokeToken: jest.fn(),
    } as unknown as jest.Mocked<CaldavService>
  })

  describe('config', () => {
    it('reports available only when env enabled AND user allowed', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeController().config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({ caldavEnabled: true, allowed: true, available: true })
    })

    it('reports not available when the user is not allowed', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'false' })
      await makeController().config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({ caldavEnabled: true, allowed: false, available: false })
    })

    it('fails closed (not allowed) when settings are absent', async () => {
      const response = responseWith(undefined)
      await makeController().config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, available: false }))
    })

    it('reports not available when env disabled even if allowed', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeController().config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ caldavEnabled: false, available: false }))
    })
  })

  describe('create', () => {
    it('refuses with 403 when the env master switch is off', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeController().create({ body: { label: 'x' } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(caldavService.createToken).not.toHaveBeenCalled()
    })

    it('refuses with 403 when the user is not allowed', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'false' })
      await makeController().create({ body: { label: 'x' } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(caldavService.createToken).not.toHaveBeenCalled()
    })

    it('issues a token (returned once) when enabled and allowed', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.createToken.mockResolvedValue({
        uuid: 't-1',
        userUuid: 'user-1',
        label: 'Apple',
        scope: 'calendar-read',
        createdAt: 1,
        lastUsedAt: null,
        token: 't-1.secret',
      })
      await makeController().create({ body: { label: 'Apple' } } as Request, response)
      expect(caldavService.createToken).toHaveBeenCalledWith('user-1', 'Apple')
      expect(statusMock).toHaveBeenCalledWith(201)
      expect(jsonMock).toHaveBeenCalledWith({ token: expect.objectContaining({ token: 't-1.secret' }) })
    })

    it('maps a store error (e.g. empty label) to 400', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.createToken.mockRejectedValue(new Error('A label is required to create a CalDAV token.'))
      await makeController().create({ body: {} } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(400)
    })
  })

  describe('list', () => {
    it('returns the user tokens when enabled', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.listTokens.mockResolvedValue([])
      await makeController().list({} as Request, response)
      expect(caldavService.listTokens).toHaveBeenCalledWith('user-1')
      expect(jsonMock).toHaveBeenCalledWith({ tokens: [] })
    })
  })

  describe('revoke', () => {
    it('returns 404 when the token does not exist for the user', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.revokeToken.mockResolvedValue(false)
      await makeController().revoke({ params: { tokenUuid: 'nope' } } as unknown as Request, response)
      expect(statusMock).toHaveBeenCalledWith(404)
    })

    it('revokes an existing token', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.revokeToken.mockResolvedValue(true)
      await makeController().revoke({ params: { tokenUuid: 't-1' } } as unknown as Request, response)
      expect(caldavService.revokeToken).toHaveBeenCalledWith('user-1', 't-1')
      expect(jsonMock).toHaveBeenCalledWith({ revoked: true })
    })
  })
})
