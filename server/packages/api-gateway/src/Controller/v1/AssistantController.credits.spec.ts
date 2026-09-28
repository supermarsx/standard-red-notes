import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AssistantController } from './AssistantController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { PersistedAiProfile } from '../../Service/Assistant/profiles'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

const ADMIN_UUID = '11111111-1111-4111-8111-111111111111'
const ORIGINAL_FETCH = global.fetch

type ResponseHarness = {
  response: Response
  status: jest.Mock
  json: jest.Mock
  setHeader: jest.Mock
}

function responseHarness(options?: { admin?: boolean }): ResponseHarness {
  const response = {
    locals: {
      user: { uuid: ADMIN_UUID },
      roles: options?.admin === false ? [] : [{ name: RoleName.NAMES.AdminUser }],
    },
  } as unknown as Response
  const status = jest.fn(() => response)
  const json = jest.fn(() => response)
  const setHeader = jest.fn(() => response)
  const vary = jest.fn(() => response)
  Object.assign(response, { status, json, setHeader, vary })
  return { response, status, json, setHeader }
}

function request(query: Record<string, unknown>): Request {
  return { body: {}, query } as unknown as Request
}

function resolverWith(profile: PersistedAiProfile | undefined): ServerSettingsResolver {
  return {
    resolveActiveProfile: jest.fn().mockResolvedValue(profile),
  } as unknown as ServerSettingsResolver
}

function controller(resolver?: ServerSettingsResolver): AssistantController {
  const providerConfig: AssistantProviderConfig = { openaiAuthMode: 'api-key' }
  return new AssistantController(providerConfig, 'openai', 'model', 0, [], undefined, resolver, undefined, 0, 0)
}

const openRouterProfile: PersistedAiProfile = {
  id: 'p-openrouter',
  name: 'OpenRouter',
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  enabled: true,
  apiKey: 'sk-or-v1-super-secret',
}

describe('AssistantController GET /credits', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    // jest.config sets resetMocks: true, so implementations must be set here.
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
  })

  it('refuses a non-admin caller, so an unprivileged user cannot probe key validity', async () => {
    const harness = responseHarness({ admin: false })
    await controller(resolverWith(openRouterProfile)).credits(request({ profileId: 'p-openrouter' }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the answer out of shared caches', async () => {
    const harness = responseHarness()
    await controller(resolverWith(openRouterProfile)).credits(request({}), harness.response)

    expect(harness.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0')
  })

  it('requires a profileId', async () => {
    const harness = responseHarness()
    await controller(resolverWith(openRouterProfile)).credits(request({}), harness.response)

    expect(harness.status).toHaveBeenCalledWith(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown profile', async () => {
    const harness = responseHarness()
    await controller(resolverWith(undefined)).credits(request({ profileId: 'nope' }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // resolveActiveProfile falls back to the default profile when the requested id
  // is unknown; without this identity check a caller could read the default
  // profile's balance by naming any id at all.
  it('rejects a resolution that fell back to a different profile', async () => {
    const harness = responseHarness()
    await controller(resolverWith(openRouterProfile)).credits(
      request({ profileId: 'some-other-profile' }),
      harness.response,
    )

    expect(harness.status).toHaveBeenCalledWith(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when profile configuration is unavailable', async () => {
    const harness = responseHarness()
    await controller(undefined).credits(request({ profileId: 'p-openrouter' }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(503)
  })

  it('returns the normalized balance and never the key or the raw body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { label: 'my-prod-key', limit_remaining: 8.25, usage: 1.75 } }),
    })

    const harness = responseHarness()
    await controller(resolverWith(openRouterProfile)).credits(request({ profileId: 'p-openrouter' }), harness.response)

    const payload = harness.json.mock.calls[0][0]
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'OpenRouter',
      remaining: 8.25,
      usage: 1.75,
      currency: 'USD',
    })
    expect(typeof (payload as { fetchedAt: string }).fetchedAt).toBe('string')

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('sk-or-v1-super-secret')
    expect(serialized).not.toContain('my-prod-key')
    expect(harness.status).not.toHaveBeenCalledWith(500)
  })

  it('reports an unsupported provider as a normal 200 answer naming the provider', async () => {
    const anthropic: PersistedAiProfile = {
      id: 'p-anthropic',
      name: 'Claude',
      provider: 'anthropic',
      enabled: true,
      apiKey: 'sk-ant-secret',
    }

    const harness = responseHarness()
    await controller(resolverWith(anthropic)).credits(request({ profileId: 'p-anthropic' }), harness.response)

    expect(harness.json).toHaveBeenCalledWith({ status: 'unsupported', provider: 'Anthropic' })
    expect(harness.status).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a configured-but-keyless profile as not-configured', async () => {
    const keyless: PersistedAiProfile = { ...openRouterProfile, apiKey: undefined }

    const harness = responseHarness()
    await controller(resolverWith(keyless)).credits(request({ profileId: 'p-openrouter' }), harness.response)

    expect(harness.json).toHaveBeenCalledWith({ status: 'not-configured', provider: 'OpenRouter' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not fail the request when the provider is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const harness = responseHarness()
    await controller(resolverWith(openRouterProfile)).credits(request({ profileId: 'p-openrouter' }), harness.response)

    expect(harness.json).toHaveBeenCalledWith({
      status: 'unavailable',
      provider: 'OpenRouter',
      reason: 'network',
    })
    expect(harness.status).not.toHaveBeenCalled()
  })

  it('finds the key on a referenced backend profile, since resolution merges it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { limit_remaining: 2, usage: 0 } }),
    })

    // What resolveActiveProfile hands back after merging the backend profile.
    const merged: PersistedAiProfile = {
      id: 'p-via-backend',
      name: 'Via backend',
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      enabled: true,
      backendProfileId: 'b-1',
      apiKey: 'sk-or-v1-from-backend',
    }

    const harness = responseHarness()
    await controller(resolverWith(merged)).credits(request({ profileId: 'p-via-backend' }), harness.response)

    expect(harness.json.mock.calls[0][0]).toMatchObject({ status: 'ok', remaining: 2 })
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-from-backend' })
  })
})
