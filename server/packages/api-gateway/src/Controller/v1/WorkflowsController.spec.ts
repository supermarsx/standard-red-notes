import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { WorkflowsController } from './WorkflowsController'
import { WorkflowsService } from '../../Service/Workflows/WorkflowsService'
import { WorkflowsPairingStore } from '../../Service/Workflows/WorkflowsPairingStore'

describe('WorkflowsController', () => {
  let pairingStore: jest.Mocked<WorkflowsPairingStore>
  let logger: jest.Mocked<Logger>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let cookieMock: jest.Mock
  let clearCookieMock: jest.Mock

  const makeService = (enabled: boolean) =>
    new WorkflowsService(
      {
        enabled,
        n8nUrl: 'http://n8n:5678',
        uiBasePath: '/workflows-ui',
        jwtSecret: 'test-secret',
        cookieSecure: false,
        uiTokenTtlSeconds: 3600,
      },
      pairingStore as unknown as WorkflowsPairingStore,
    )

  const makeController = (enabled: boolean) =>
    new WorkflowsController(makeService(enabled), logger as unknown as Logger)

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    cookieMock = jest.fn()
    clearCookieMock = jest.fn()
    return {
      locals: { user: { uuid: '1-2-3' }, settings },
      json: jsonMock,
      status: statusMock,
      cookie: cookieMock,
      clearCookie: clearCookieMock,
    } as unknown as Response
  }

  const request = { headers: {}, ip: '10.0.0.1' } as unknown as Request

  const entitled = { [SettingName.NAMES.WorkflowsEnabled]: 'true' }

  beforeEach(() => {
    pairingStore = {
      isPaired: jest.fn().mockResolvedValue(false),
      pair: jest.fn().mockResolvedValue({ userUuid: '1-2-3', pairedAt: 1, mcpTokenUuid: null, webhookUuids: null }),
      unpair: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<WorkflowsPairingStore>
    logger = { info: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  describe('status', () => {
    it('reports enabled only when env master switch AND per-user flag are on', async () => {
      await makeController(true).status(request, responseWith(entitled))
      expect(jsonMock).toHaveBeenCalledWith({ enabled: true, paired: false, editorUrl: null })
    })

    it('reports disabled when the env master switch is off', async () => {
      await makeController(false).status(request, responseWith(entitled))
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, editorUrl: null }))
    })

    it('fails closed (disabled) when the per-user flag is absent from the token settings', async () => {
      await makeController(true).status(request, responseWith(undefined))
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, editorUrl: null }))
    })

    it('returns the editor url and refreshes the ui-access cookie when enabled and paired', async () => {
      pairingStore.isPaired.mockResolvedValue(true)

      await makeController(true).status(request, responseWith(entitled))

      expect(jsonMock).toHaveBeenCalledWith({ enabled: true, paired: true, editorUrl: '/workflows-ui/' })
      expect(cookieMock).toHaveBeenCalledWith(
        'srn_workflows_ui',
        expect.any(String),
        expect.objectContaining({ httpOnly: true, path: '/workflows-ui' }),
      )
    })

    it('withholds the editor url for a stale pairing on a no-longer-entitled account', async () => {
      pairingStore.isPaired.mockResolvedValue(true)

      await makeController(true).status(request, responseWith(undefined))

      expect(jsonMock).toHaveBeenCalledWith({ enabled: false, paired: true, editorUrl: null })
      expect(cookieMock).not.toHaveBeenCalled()
    })
  })

  describe('pair', () => {
    it('refuses with 403 when the env master switch is off', async () => {
      await makeController(false).pair(request, responseWith(entitled))
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(pairingStore.pair).not.toHaveBeenCalled()
    })

    it('refuses with 403 when the user is not entitled', async () => {
      await makeController(true).pair(request, responseWith({ [SettingName.NAMES.WorkflowsEnabled]: 'false' }))
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(pairingStore.pair).not.toHaveBeenCalled()
    })

    it('pairs, arms the ui-access cookie and returns the editor url', async () => {
      await makeController(true).pair(request, responseWith(entitled))

      expect(pairingStore.pair).toHaveBeenCalledWith('1-2-3')
      expect(cookieMock).toHaveBeenCalledWith('srn_workflows_ui', expect.any(String), expect.any(Object))
      expect(jsonMock).toHaveBeenCalledWith({ paired: true, editorUrl: '/workflows-ui/' })
      expect(logger.info).toHaveBeenCalled()
    })

    it('is idempotent: pairing an already-paired user still succeeds', async () => {
      pairingStore.isPaired.mockResolvedValue(true)

      await makeController(true).pair(request, responseWith(entitled))

      expect(jsonMock).toHaveBeenCalledWith({ paired: true, editorUrl: '/workflows-ui/' })
    })

    it('audits the TRUST_PROXY-resolved request.ip and IGNORES a spoofed X-Forwarded-For', async () => {
      // Was reading the raw X-Forwarded-For here (spoofable) — now the canonical resolver.
      const spoofed = { headers: { 'x-forwarded-for': '9.9.9.9' }, ip: '10.0.0.1' } as unknown as Request
      await makeController(true).pair(spoofed, responseWith(entitled))
      expect(logger.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ip: '10.0.0.1' }))
    })
  })

  describe('unpair', () => {
    it('refuses with 403 when the env master switch is off', async () => {
      await makeController(false).unpair(request, responseWith(entitled))
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(pairingStore.unpair).not.toHaveBeenCalled()
    })

    it('unpairs, clears the ui-access cookie and reports unpaired', async () => {
      await makeController(true).unpair(request, responseWith(entitled))

      expect(pairingStore.unpair).toHaveBeenCalledWith('1-2-3')
      expect(clearCookieMock).toHaveBeenCalledWith('srn_workflows_ui', { path: '/workflows-ui' })
      expect(jsonMock).toHaveBeenCalledWith({ paired: false })
    })

    it('is idempotent: unpairing an already-unpaired user still succeeds silently', async () => {
      pairingStore.unpair.mockResolvedValue(false)

      await makeController(true).unpair(request, responseWith(entitled))

      expect(jsonMock).toHaveBeenCalledWith({ paired: false })
      expect(logger.info).not.toHaveBeenCalled()
    })
  })

  describe('ui-access token', () => {
    it('mints a verifiable, purpose-scoped token bound to the user', () => {
      const service = makeService(true)
      const token = service.mintUiAccessToken('1-2-3')
      expect(service.verifyUiAccessToken(token)).toEqual('1-2-3')
    })

    it('fails closed for a garbage or absent token', () => {
      const service = makeService(true)
      expect(service.verifyUiAccessToken('not-a-jwt')).toBeNull()
      expect(service.verifyUiAccessToken(undefined)).toBeNull()
    })
  })
})
