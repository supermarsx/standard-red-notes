import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { AssistantController } from './AssistantController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'

// The provider factory is mocked so the controller never reaches a real LLM
// provider: these tests only exercise the per-user gate + metering logic that
// runs BEFORE any proxying.
jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue(['openai']),
  listProviderModels: jest.fn(),
  resolveProvider: jest.fn().mockImplementation(() => {
    throw new Error('provider should not be resolved when the request is gated')
  }),
}))

describe('AssistantController', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let redis: { incr: jest.Mock; expire: jest.Mock; decr: jest.Mock; get: jest.Mock }

  const makeController = (globalLimit = 0) =>
    new AssistantController(
      {} as AssistantProviderConfig,
      'openai',
      'gpt-test',
      globalLimit,
      [],
      redis as never,
    )

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'user-1' }, settings },
      status: statusMock,
      json: jsonMock,
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    } as unknown as Response
  }

  const streamRequest = (): Request =>
    ({ body: { messages: [] }, on: jest.fn() }) as unknown as Request

  beforeEach(() => {
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
    }
  })

  describe('streamCompletion gating', () => {
    it('FAILS CLOSED with 403 when AI is explicitly disabled for the user', async () => {
      const response = responseWith({ [SettingName.NAMES.AiEnabled]: 'false' })

      await makeController().streamCompletion(streamRequest(), response)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ tag: 'ai-disabled' }) }),
      )
      // The provider is never resolved and the meter is never touched.
      expect(redis.incr).not.toHaveBeenCalled()
    })

    it('allows a user whose AI flag is not set (default-on) past the disable gate', async () => {
      const response = responseWith({})

      await makeController().streamCompletion(streamRequest(), response)

      // Not blocked by the disable gate (no 403 ai-disabled); it proceeds to meter
      // (incr) and then hits the mocked provider resolution error path.
      expect(statusMock).not.toHaveBeenCalledWith(403)
    })

    it('enforces the per-user AI_REQUEST_LIMIT ahead of the global cap (429 over limit)', async () => {
      // Per-user limit of 2; this is the 3rd request of the day.
      redis.incr.mockResolvedValue(3)
      const response = responseWith({ [SettingName.NAMES.AiRequestLimit]: 2 })

      // A high global limit must NOT override the lower per-user limit.
      await makeController(1000).streamCompletion(streamRequest(), response)

      expect(statusMock).toHaveBeenCalledWith(429)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ tag: 'ai-rate-limited', limit: 2 }) }),
      )
      // The metered request that exceeded the cap is rolled back.
      expect(redis.decr).toHaveBeenCalled()
    })

    it('applies the global cap when there is no per-user override', async () => {
      redis.incr.mockResolvedValue(6)
      const response = responseWith({})

      await makeController(5).streamCompletion(streamRequest(), response)

      expect(statusMock).toHaveBeenCalledWith(429)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ tag: 'ai-rate-limited', limit: 5 }) }),
      )
    })
  })
})
