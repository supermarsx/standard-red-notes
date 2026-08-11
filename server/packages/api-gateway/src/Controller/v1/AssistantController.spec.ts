import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { AssistantController } from './AssistantController'
import { AssistantProviderConfig, listProviderModels } from '../../Service/Assistant/providers/factory'

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
  let redis: {
    incr: jest.Mock
    expire: jest.Mock
    decr: jest.Mock
    get: jest.Mock
    zadd: jest.Mock
    zrangebyscore: jest.Mock
    zremrangebyscore: jest.Mock
  }

  const makeController = (globalLimit = 0, tokenLimits?: { fiveHour?: number; weekly?: number }) =>
    new AssistantController(
      {} as AssistantProviderConfig,
      'openai',
      'gpt-test',
      globalLimit,
      [],
      redis as never,
      undefined,
      undefined,
      tokenLimits?.fiveHour ?? 0,
      tokenLimits?.weekly ?? 0,
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

  const streamRequest = (): Request => ({ body: { messages: [] }, on: jest.fn() }) as unknown as Request

  beforeEach(() => {
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      zadd: jest.fn().mockResolvedValue(1),
      // Default: no prior token usage recorded.
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
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

  describe('rolling-window token metering', () => {
    const now = Date.now()

    it('rejects (429) naming the window + reset when the 5h token cap is already reached', async () => {
      // 5000 tokens already spent inside the week; the 5h limit is 1000.
      redis.zrangebyscore.mockResolvedValue([`${now}:5000:abc`])
      const response = responseWith({})

      await makeController(0, { fiveHour: 1000 }).streamCompletion(streamRequest(), response)

      expect(statusMock).toHaveBeenCalledWith(429)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            tag: 'ai-token-limit-reached',
            window: 'fiveHour',
            limitTokens: 1000,
            resetsAt: expect.any(String),
          }),
        }),
      )
    })

    it('treats a 0 token limit as UNLIMITED (no token 429 even with heavy usage)', async () => {
      redis.zrangebyscore.mockResolvedValue([`${now}:9999999:abc`])
      const response = responseWith({})

      await makeController(0, { fiveHour: 0, weekly: 0 }).streamCompletion(streamRequest(), response)

      // The token gate never fires; the request proceeds to the mocked provider
      // resolution (which fails), so no 429 is produced.
      expect(statusMock).not.toHaveBeenCalledWith(429)
    })

    it('FAILS OPEN when the token meter read errors (request not blocked)', async () => {
      redis.zrangebyscore.mockRejectedValue(new Error('redis down'))
      const response = responseWith({})

      await makeController(0, { fiveHour: 1000 }).streamCompletion(streamRequest(), response)

      expect(statusMock).not.toHaveBeenCalledWith(429)
    })
  })

  describe('usage endpoint', () => {
    it('reports the daily request meter plus both token windows', async () => {
      redis.get.mockResolvedValue('3')
      redis.zrangebyscore.mockResolvedValue([`${Date.now()}:120:abc`])
      const response = responseWith({})

      await makeController(0, { fiveHour: 1000, weekly: 5000 }).usage({ query: {} } as unknown as Request, response)

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          used: 3,
          tokens: expect.objectContaining({
            fiveHour: expect.objectContaining({ usedTokens: 120, limitTokens: 1000 }),
            weekly: expect.objectContaining({ usedTokens: 120, limitTokens: 5000 }),
          }),
        }),
      )
    })
  })

  describe('assigned/default profile discovery', () => {
    const profile = {
      id: 'assigned-local',
      name: 'Assigned local model',
      provider: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
      enabled: true,
    }

    let resolver: {
      resolveAssistantProfiles: jest.Mock
      resolveActiveProfile: jest.Mock
    }

    beforeEach(() => {
      resolver = {
        resolveAssistantProfiles: jest.fn().mockResolvedValue({
          profiles: [profile],
          defaultProfileId: profile.id,
        }),
        resolveActiveProfile: jest.fn().mockResolvedValue(profile),
      }
    })

    const controller = () =>
      new AssistantController(
        {} as AssistantProviderConfig,
        '',
        'fallback-model',
        0,
        [],
        redis as never,
        resolver as never,
      )

    it('advertises that a named server profile is configured without exposing its secret', async () => {
      const response = responseWith({})

      await controller().config({} as Request, response)

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ profileConfigured: true, defaultModel: 'local-model' }),
      )
    })

    it('uses the authenticated user assignment for Automatic model discovery', async () => {
      ;(listProviderModels as jest.Mock).mockResolvedValueOnce(['local-model'])
      const response = responseWith({})

      await controller().models({ query: {}, headers: {} } as unknown as Request, response)

      expect(resolver.resolveActiveProfile).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ userIdentifiers: ['user-1'] }),
      )
      expect(jsonMock).toHaveBeenCalledWith({
        provider: 'openai',
        profileId: 'assigned-local',
        models: ['local-model'],
      })
    })
  })
})
