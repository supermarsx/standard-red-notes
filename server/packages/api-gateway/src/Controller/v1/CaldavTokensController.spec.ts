import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { CaldavTokensController, CaldavTodosController } from './CaldavTokensController'
import { CaldavInputError } from '../../Service/Caldav/CaldavInputError'
import { CaldavService } from '../../Service/Caldav/CaldavService'

describe('CalDAV management controllers', () => {
  let caldavService: jest.Mocked<CaldavService>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeTokensController = (basePath = '/dav') =>
    new CaldavTokensController(caldavService as unknown as CaldavService, basePath)
  const makeTodosController = () => new CaldavTodosController(caldavService as unknown as CaldavService)

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
      revokeAllTokens: jest.fn(),
      listTodos: jest.fn(),
      publishTodo: jest.fn(),
      unpublishTodo: jest.fn(),
    } as unknown as jest.Mocked<CaldavService>
  })

  describe('token config', () => {
    it('reports both gates and the exact normalized mounted base path', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeTokensController('/calendar-api/').config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({
        caldavEnabled: true,
        allowed: true,
        available: true,
        basePath: '/calendar-api',
        collectionPathTemplate: '/calendar-api/calendars/{userUuid}/todos/',
      })
    })

    it('fails closed when user settings are absent or the master switch is off', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith(undefined)
      await makeTokensController().config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, available: false }))
    })

    it('rejects an invalid operator base path rather than advertising a fallback', () => {
      expect(() => makeTokensController('../dav')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav?wrong=1')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController(' /dav')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav%2Fadmin')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav*')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav(foo)')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav/../admin')).toThrow(/CALDAV_BASE_PATH/)
      expect(() => makeTokensController('/dav//')).toThrow(/CALDAV_BASE_PATH/)
    })
  })

  describe('token lifecycle', () => {
    it('allows listing and revocation cleanup while the master and user gates are off', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      caldavService.listTokens.mockResolvedValue([])
      caldavService.revokeToken.mockResolvedValue(true)
      caldavService.revokeAllTokens.mockResolvedValue(2)
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'false' })

      await makeTokensController().list({} as Request, response)
      expect(caldavService.listTokens).toHaveBeenCalledWith('user-1')

      await makeTokensController().revoke({ params: { tokenUuid: 't-1' } } as unknown as Request, response)
      expect(caldavService.revokeToken).toHaveBeenCalledWith('user-1', 't-1')

      await makeTokensController().revokeAll({} as Request, response)
      expect(caldavService.revokeAllTokens).toHaveBeenCalledWith('user-1')
      expect(jsonMock).toHaveBeenCalledWith({ revoked: 2 })
    })

    it('requires both gates before issuing a token', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const disabled = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeTokensController().create({ body: { label: 'x' } } as Request, disabled)
      expect(statusMock).toHaveBeenCalledWith(403)

      caldavService.isEnabled.mockReturnValue(true)
      const notAllowed = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'false' })
      await makeTokensController().create({ body: { label: 'x' } } as Request, notAllowed)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(caldavService.createToken).not.toHaveBeenCalled()
    })

    it('issues a token once when both gates pass', async () => {
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
      await makeTokensController().create({ body: { label: 'Apple' } } as Request, response)
      expect(caldavService.createToken).toHaveBeenCalledWith('user-1', 'Apple')
      expect(statusMock).toHaveBeenCalledWith(201)
      expect(jsonMock).toHaveBeenCalledWith({ token: expect.objectContaining({ token: 't-1.secret' }) })
    })

    it('maps only caller validation errors to 400', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.createToken.mockRejectedValue(new CaldavInputError('A label is required.'))
      await makeTokensController().create({ body: {} } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(400)

      caldavService.createToken.mockRejectedValue(new Error('disk unavailable'))
      await expect(makeTokensController().create({ body: { label: 'x' } } as Request, response)).rejects.toThrow(
        'disk unavailable',
      )
    })
  })

  describe('explicit published todos', () => {
    it('lists and unpublishes retained plaintext even while gates are off', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      caldavService.listTodos.mockResolvedValue([])
      caldavService.unpublishTodo.mockResolvedValue(true)
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'false' })

      await makeTodosController().list({} as Request, response)
      expect(caldavService.listTodos).toHaveBeenCalledWith('user-1')
      await makeTodosController().unpublish({ params: { uid: 'todo-1' } } as unknown as Request, response)
      expect(caldavService.unpublishTodo).toHaveBeenCalledWith('user-1', 'todo-1')
      expect(jsonMock).toHaveBeenCalledWith({ unpublished: true })
    })

    it('requires both gates to publish', async () => {
      caldavService.isEnabled.mockReturnValue(false)
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      await makeTodosController().publish({ body: { summary: 'Plan' } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(caldavService.publishTodo).not.toHaveBeenCalled()
    })

    it('passes every supported VTODO field through without silent update loss', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      const body = {
        uid: 'todo-1',
        summary: 'Plan',
        description: 'Release plan',
        start: '2026-08-01T09:00:00Z',
        due: '2026-08-01T10:00:00Z',
        completed: true,
        completedAt: '2026-08-01T09:30:00Z',
        priority: 1,
      }
      caldavService.publishTodo.mockResolvedValue({ ...body, createdAt: 1, updatedAt: 2 })
      await makeTodosController().publish({ body } as Request, response)
      expect(caldavService.publishTodo).toHaveBeenCalledWith('user-1', body)
      expect(jsonMock).toHaveBeenCalledWith({ todo: expect.objectContaining({ uid: 'todo-1', priority: 1 }) })
    })

    it('generates a UID, requires a nonblank summary, and maps validation errors', async () => {
      const response = responseWith({ [SettingName.NAMES.CaldavEnabled]: 'true' })
      caldavService.publishTodo.mockImplementation(async (_userUuid, todo) => todo)
      await makeTodosController().publish({ body: { summary: 'Generated' } } as Request, response)
      expect(caldavService.publishTodo).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          uid: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          summary: 'Generated',
        }),
      )

      await makeTodosController().publish({ body: { summary: '   ' } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(400)

      caldavService.publishTodo.mockRejectedValue(new CaldavInputError('bad calendar value'))
      await makeTodosController().publish({ body: { summary: 'Bad' } } as Request, response)
      expect(jsonMock).toHaveBeenCalledWith({ error: { message: 'bad calendar value' } })
    })

    it('returns 404 when an item is already absent', async () => {
      caldavService.unpublishTodo.mockResolvedValue(false)
      const response = responseWith()
      await makeTodosController().unpublish({ params: { uid: 'missing' } } as unknown as Request, response)
      expect(statusMock).toHaveBeenCalledWith(404)
    })
  })
})
