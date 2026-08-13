import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName, SettingName } from '@standardnotes/domain-core'

import { AssistantController } from './AssistantController'
import {
  AssistantProviderConfig,
  configuredProviders,
  listProviderModels,
  resolveProvider,
} from '../../Service/Assistant/providers/factory'

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
    eval: jest.Mock
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
    const headers = new Map<string, string>([['vary', 'Origin']])
    const setHeader = jest.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value)
      return response
    })
    const vary = jest.fn((name: string) => {
      const fields = (headers.get('vary') ?? '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
      if (!fields.some((field) => field.toLowerCase() === name.toLowerCase())) {
        fields.push(name)
      }
      headers.set('vary', fields.join(', '))
      return response
    })
    const response = {
      locals: {
        user: { uuid: 'user-1', email: 'user@example.test' },
        roles: [{ name: RoleName.NAMES.ProUser }],
        settings,
      },
      status: statusMock,
      json: jsonMock,
      setHeader,
      getHeader: jest.fn((name: string) => headers.get(name.toLowerCase())),
      vary,
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    } as unknown as Response
    return response
  }

  const streamRequest = (): Request => ({ body: { messages: [] }, headers: {}, on: jest.fn() }) as unknown as Request

  beforeEach(() => {
    jest.clearAllMocks()
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      zadd: jest.fn().mockResolvedValue(1),
      // Default: no prior token usage recorded.
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      eval: jest.fn(async (script: string, _keyCount: number, key: string, limit?: number, ttl?: number) => {
        if (script.includes("redis.call('INCR'")) {
          const count = await redis.incr(key)
          if (count === 1) {
            await redis.expire(key, ttl)
          }
          if (count > (limit ?? 0)) {
            const used = await redis.decr(key)
            return [0, used]
          }
          return [1, count]
        }
        return redis.decr(key)
      }),
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
      apiKey: 'server-only-secret',
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

    it('returns only the authenticated user assignment and marks it private without exposing connection secrets', async () => {
      const response = responseWith({})

      await controller().config({} as Request, response)

      expect(resolver.resolveActiveProfile).toHaveBeenCalledWith(undefined, {
        userIdentifiers: ['user-1', 'user@example.test'],
        roleNames: [RoleName.NAMES.ProUser],
      })
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0')
      expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
      expect(response.vary).toHaveBeenCalledWith('Authorization')
      expect(response.getHeader('Vary')).toBe('Origin, Authorization')
      expect(jsonMock).toHaveBeenCalledWith({
        providers: ['openai'],
        defaultProvider: 'openai',
        defaultModel: 'local-model',
        profileConfigured: true,
        effectiveProfile: {
          id: 'assigned-local',
          name: 'Assigned local model',
          provider: 'openai-compatible',
          model: 'local-model',
        },
      })
      const serialized = JSON.stringify(jsonMock.mock.calls[0][0])
      expect(serialized).not.toContain('server-only-secret')
      expect(serialized).not.toContain('127.0.0.1')
    })

    it('fails closed when the authenticated assignment cannot be resolved', async () => {
      resolver.resolveActiveProfile.mockRejectedValueOnce(new Error('settings unavailable'))
      const response = responseWith({})

      await controller().config({} as Request, response)

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({
        error: { message: 'Assistant profile configuration is unavailable.' },
      })
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0')
    })

    it('uses the authenticated user assignment for Automatic model discovery', async () => {
      ;(listProviderModels as jest.Mock).mockResolvedValueOnce(['local-model'])
      const response = responseWith({})

      await controller().models({ query: {}, headers: {} } as unknown as Request, response)

      expect(resolver.resolveActiveProfile).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ userIdentifiers: ['user-1', 'user@example.test'] }),
      )
      expect(jsonMock).toHaveBeenCalledWith({
        provider: 'openai',
        profileId: 'assigned-local',
        models: ['local-model'],
      })
    })

    it('ignores caller provider, model, profile body, and profile header hints for streams', async () => {
      const assignedProvider = {
        id: 'openai-compatible',
        async *send() {
          yield { kind: 'finish' as const, stopReason: 'end_turn' as const }
        },
      }
      ;(resolveProvider as jest.Mock).mockReturnValueOnce(assignedProvider)
      const response = responseWith({})
      const request = {
        body: {
          messages: [],
          provider: 'anthropic',
          model: 'caller-expensive-model',
          profileId: 'other-users-profile',
        },
        headers: { 'x-assistant-profile': 'header-profile' },
        on: jest.fn(),
      } as unknown as Request

      await controller().streamCompletion(request, response)

      expect(resolver.resolveActiveProfile).toHaveBeenCalledWith(undefined, {
        userIdentifiers: ['user-1', 'user@example.test'],
        roleNames: [RoleName.NAMES.ProUser],
      })
      expect(resolveProvider).toHaveBeenLastCalledWith(
        'openai',
        'local-model',
        expect.objectContaining({ openaiBaseURL: 'http://127.0.0.1:1234/v1' }),
      )
      expect(response.end).toHaveBeenCalled()
    })
  })

  it('keeps the legacy server default discoverable when no profile resolver is configured', async () => {
    const response = responseWith({})

    await makeController().config({} as Request, response)

    expect(jsonMock).toHaveBeenCalledWith({
      providers: ['openai'],
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      profileConfigured: false,
      effectiveProfile: null,
    })
  })

  it('never applies another provider default model to the first configured legacy fallback', async () => {
    const providerConfig = { ollamaUrl: 'http://127.0.0.1:11434' }
    ;(configuredProviders as jest.Mock).mockReturnValue(['ollama'])
    const controller = new AssistantController(
      providerConfig,
      'unavailable-default',
      'fallback-model',
      0,
      [],
      redis as never,
    )
    const configResponse = responseWith({})

    await controller.config({} as Request, configResponse)

    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ defaultProvider: 'ollama', defaultModel: '' }))

    const streamResponse = responseWith({})
    await controller.streamCompletion(streamRequest(), streamResponse)

    expect(resolveProvider).not.toHaveBeenCalled()
    expect(streamResponse.write).toHaveBeenCalledWith(expect.stringContaining('has no model'))
    expect(streamResponse.end).toHaveBeenCalled()
  })

  it('ignores caller provider and model hints in legacy server-managed mode', async () => {
    const providerConfig = { ollamaUrl: 'http://127.0.0.1:11434' }
    ;(configuredProviders as jest.Mock).mockReturnValue(['ollama'])
    ;(resolveProvider as jest.Mock).mockReturnValueOnce({
      id: 'ollama',
      async *send() {
        yield { kind: 'finish' as const, stopReason: 'end_turn' as const }
      },
    })
    const controller = new AssistantController(providerConfig, 'ollama', 'server-model', 0, [], redis as never)
    const request = {
      body: { messages: [], provider: 'anthropic', model: 'caller-model', profileId: 'caller-profile' },
      headers: { 'x-assistant-profile': 'caller-header-profile' },
      on: jest.fn(),
    } as unknown as Request

    await controller.streamCompletion(request, responseWith({}))

    expect(resolveProvider).toHaveBeenLastCalledWith('ollama', 'server-model', providerConfig)
  })
})
