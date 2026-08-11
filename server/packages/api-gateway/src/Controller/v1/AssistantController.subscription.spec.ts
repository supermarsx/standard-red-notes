import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AssistantController } from './AssistantController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { SubscriptionCredentialProviderInterface } from '../../Service/Assistant/subscription/SubscriptionCredentialProvider'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

const ADMIN_UUID = '11111111-1111-4111-8111-111111111111'
const VALID_STATE = Buffer.alloc(32, 7).toString('base64url')
const ORIGINAL_FETCH = global.fetch

type ResponseHarness = {
  response: Response
  status: jest.Mock
  json: jest.Mock
  send: jest.Mock
  setHeader: jest.Mock
  vary: jest.Mock
  write: jest.Mock
  end: jest.Mock
}

function responseHarness(options?: { uuid?: string; admin?: boolean }): ResponseHarness {
  const response = {
    locals: {
      user: { uuid: options?.uuid ?? ADMIN_UUID },
      roles: options?.admin === false ? [] : [{ name: RoleName.NAMES.AdminUser }],
    },
  } as unknown as Response
  const status = jest.fn(() => response)
  const json = jest.fn(() => response)
  const send = jest.fn(() => response)
  const setHeader = jest.fn(() => response)
  const vary = jest.fn(() => response)
  const write = jest.fn(() => true)
  const end = jest.fn(() => response)
  Object.assign(response, {
    status,
    json,
    send,
    setHeader,
    vary,
    write,
    end,
    flushHeaders: jest.fn(),
    type: jest.fn(() => response),
  })
  return { response, status, json, send, setHeader, vary, write, end }
}

function request(values: Partial<Request>): Request {
  return { body: {}, query: {}, ...values } as Request
}

function providerMock(): jest.Mocked<SubscriptionCredentialProviderInterface> {
  return {
    beginPairing: jest.fn(),
    completePairing: jest.fn(),
    getFreshCredential: jest.fn(),
    getStatus: jest.fn(),
    listStatuses: jest.fn(),
    unpair: jest.fn(),
    unpairLegacy: jest.fn(),
    unpairAll: jest.fn(),
  }
}

function controller(
  provider: SubscriptionCredentialProviderInterface | undefined,
  resolver?: ServerSettingsResolver,
  providerConfig: AssistantProviderConfig = { openaiAuthMode: 'api-key' },
): AssistantController {
  return new AssistantController(providerConfig, 'openai', 'model', 0, [], undefined, resolver, provider, 0, 0)
}

describe('AssistantController subscription pairing contract', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    jest.restoreAllMocks()
  })

  it('reads status for the explicit id and returns non-secret transient state', async () => {
    const provider = providerMock()
    provider.getStatus.mockResolvedValue({
      paired: true,
      accountId: 'acct-1',
      refreshRetryAt: 2_000_000_000_000,
      refreshFailureCode: 'provider-unavailable',
    })
    const harness = responseHarness()

    await controller(provider).subscriptionStatus(request({ query: { subscriptionId: 'team-a' } }), harness.response)

    expect(provider.getStatus).toHaveBeenCalledWith('team-a')
    expect(harness.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0')
    expect(harness.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
    expect(harness.json).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'team-a',
        paired: true,
        refreshFailureCode: 'provider-unavailable',
      }),
    )
    expect(JSON.stringify(harness.json.mock.calls)).not.toContain('token')
  })

  it.each([
    [
      'status',
      (instance: AssistantController, response: Response) => instance.subscriptionStatus(request({}), response),
    ],
    ['start', (instance: AssistantController, response: Response) => instance.subscriptionStart(request({}), response)],
    ['list', (instance: AssistantController, response: Response) => instance.subscriptionList(request({}), response)],
    [
      'complete',
      (instance: AssistantController, response: Response) => instance.subscriptionComplete(request({}), response),
    ],
    [
      'unpair',
      (instance: AssistantController, response: Response) => instance.subscriptionUnpair(request({}), response),
    ],
    [
      'unpair-all',
      (instance: AssistantController, response: Response) => instance.subscriptionUnpairAll(request({}), response),
    ],
    ['usage', (instance: AssistantController, response: Response) => instance.subscriptionUsage(request({}), response)],
  ])('marks authenticated subscription %s errors private and non-cacheable', async (_name, invoke) => {
    const harness = responseHarness({ admin: false })

    await invoke(controller(providerMock()), harness.response)

    expect(harness.status).toHaveBeenCalledWith(403)
    expect(harness.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0')
    expect(harness.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
  })

  it('reports an unreadable encrypted store as unknown/unpaired with 503', async () => {
    const provider = providerMock()
    provider.getStatus.mockResolvedValue({ paired: false, needsRepair: true, storeUnreadable: true })
    const harness = responseHarness()

    await controller(provider).subscriptionStatus(request({}), harness.response)

    expect(harness.status).toHaveBeenCalledWith(503)
    expect(harness.json).toHaveBeenCalledWith(
      expect.objectContaining({
        paired: false,
        storeUnreadable: true,
        reason: expect.stringContaining('could not be authenticated'),
      }),
    )
  })

  it('uses the legacy env bearer only when durable pairing is unavailable at boot', async () => {
    const withoutPairing = responseHarness()
    await controller(undefined, undefined, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'legacy-env-token',
    }).subscriptionStatus(request({}), withoutPairing.response)
    expect(withoutPairing.json).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'default', paired: false, usingEnvFallback: true }),
    )

    const provider = providerMock()
    provider.getStatus.mockResolvedValue({ paired: false, needsRepair: true })
    const durablePairing = responseHarness()
    await controller(provider, undefined, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'legacy-env-token',
    }).subscriptionStatus(request({}), durablePairing.response)
    expect(durablePairing.json).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'default', paired: false, usingEnvFallback: false }),
    )
  })

  it.each([
    {
      label: 'blank',
      config: { openaiAuthMode: 'subscription' as const, openaiSubscriptionToken: '   ' },
    },
    {
      label: 'unsafe endpoint',
      config: {
        openaiAuthMode: 'subscription' as const,
        openaiSubscriptionToken: 'legacy-env-token',
        openaiSubscriptionBaseURL: 'http://remote.example.test/codex',
      },
    },
  ])('does not claim an unusable $label env bearer is active', async ({ config }) => {
    const harness = responseHarness()

    await controller(undefined, undefined, config).subscriptionStatus(request({}), harness.response)

    expect(harness.json).toHaveBeenCalledWith(expect.objectContaining({ usingEnvFallback: false }))
  })

  it('never falls back to a fabricated admin identity', async () => {
    const provider = providerMock()
    const harness = responseHarness({ uuid: 'not-a-uuid' })

    await controller(provider).subscriptionStart(request({ body: { subscriptionId: 'team-a' } }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(401)
    expect(provider.beginPairing).not.toHaveBeenCalled()
  })

  it('binds start and manual completion to the authenticated admin UUID', async () => {
    const provider = providerMock()
    provider.beginPairing.mockResolvedValue({
      authorizeUrl: `https://id.test/oauth?state=${VALID_STATE}`,
      state: VALID_STATE,
    })
    provider.completePairing.mockResolvedValue({
      accessToken: 'never-returned',
      expiresAt: 2_000_000_000_000,
      pairedAt: 1_999_999_000_000,
      accountId: 'acct-1',
    })
    const harness = responseHarness()

    await controller(provider).subscriptionStart(request({ body: { subscriptionId: 'team-a' } }), harness.response)
    expect(provider.beginPairing).toHaveBeenCalledWith(ADMIN_UUID, 'team-a')

    await controller(provider).subscriptionComplete(
      request({ body: { state: VALID_STATE, code: 'opaque-code' } }),
      harness.response,
    )
    expect(provider.completePairing).toHaveBeenCalledWith(VALID_STATE, 'opaque-code', ADMIN_UUID)
    expect(JSON.stringify(harness.json.mock.calls)).not.toContain('never-returned')
  })

  it('requires an explicit valid id for targeted unpair', async () => {
    const provider = providerMock()
    const harness = responseHarness()

    await controller(provider).subscriptionUnpair(request({ body: {} }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(400)
    expect(provider.unpair).not.toHaveBeenCalled()
  })

  it('removes a listed legacy-invalid id only with an exact id confirmation', async () => {
    const provider = providerMock()
    const resolver = {
      getPersistedBackendProfiles: jest.fn().mockResolvedValue([]),
      resolveAssistantProfiles: jest.fn().mockResolvedValue({ profiles: [], defaultProfileId: undefined }),
    } as unknown as ServerSettingsResolver
    const instance = controller(provider, resolver)

    for (const legacySubscriptionIdConfirmation of [undefined, 'legacy/other']) {
      const rejected = responseHarness()
      await instance.subscriptionUnpair(
        request({ body: { subscriptionId: 'legacy/team', legacySubscriptionIdConfirmation } }),
        rejected.response,
      )
      expect(rejected.status).toHaveBeenCalledWith(400)
    }
    expect(provider.unpairLegacy).not.toHaveBeenCalled()

    const accepted = responseHarness()
    await instance.subscriptionUnpair(
      request({
        body: {
          subscriptionId: 'legacy/team',
          legacySubscriptionIdConfirmation: 'legacy/team',
        },
      }),
      accepted.response,
    )
    expect(provider.unpairLegacy).toHaveBeenCalledWith('legacy/team')
    expect(provider.unpair).not.toHaveBeenCalled()
    expect(accepted.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, subscriptionId: 'legacy/team', legacyInvalidId: true }),
    )
  })

  it('lists a legacy-invalid id for remediation without exposing its credential', async () => {
    const provider = providerMock()
    provider.listStatuses.mockResolvedValue([
      {
        id: 'legacy/team',
        paired: true,
        legacyInvalidId: true,
        accountLabel: 'operator-visible-label',
      },
    ])
    const resolver = {
      getPersistedBackendProfiles: jest.fn().mockResolvedValue([]),
      resolveAssistantProfiles: jest.fn().mockResolvedValue({ profiles: [], defaultProfileId: undefined }),
    } as unknown as ServerSettingsResolver
    const harness = responseHarness()

    await controller(provider, resolver).subscriptionList(request({}), harness.response)

    expect(harness.json).toHaveBeenCalledWith({
      subscriptions: [
        expect.objectContaining({
          id: 'legacy/team',
          paired: true,
          legacyInvalidId: true,
          profileReferencesKnown: true,
        }),
      ],
    })
    expect(JSON.stringify(harness.json.mock.calls)).not.toContain('accessToken')
  })

  it.each(['backend profiles', 'assistant profiles'])(
    'fails closed when %s cannot be audited',
    async (unreadableSource) => {
      const provider = providerMock()
      const resolver = {
        getPersistedBackendProfiles:
          unreadableSource === 'backend profiles'
            ? jest.fn().mockRejectedValue(new Error('unreadable backend settings'))
            : jest.fn().mockResolvedValue([]),
        resolveAssistantProfiles:
          unreadableSource === 'assistant profiles'
            ? jest.fn().mockRejectedValue(new Error('unreadable assistant settings'))
            : jest.fn().mockResolvedValue({ profiles: [], defaultProfileId: undefined }),
      } as unknown as ServerSettingsResolver
      const harness = responseHarness()

      await controller(provider, resolver).subscriptionUnpair(
        request({ body: { subscriptionId: 'team-a' } }),
        harness.response,
      )

      expect(harness.status).toHaveBeenCalledWith(503)
      expect(provider.unpair).not.toHaveBeenCalled()
    },
  )

  it('also fails closed when no settings resolver is bound', async () => {
    const provider = providerMock()
    const harness = responseHarness()

    await controller(provider).subscriptionUnpair(request({ body: { subscriptionId: 'team-a' } }), harness.response)

    expect(harness.status).toHaveBeenCalledWith(503)
    expect(provider.unpair).not.toHaveBeenCalled()
  })

  it('finds, safely deduplicates, and guards mixed explicit-backend and direct assistant references', async () => {
    const provider = providerMock()
    const resolver = {
      getPersistedBackendProfiles: jest.fn().mockResolvedValue([
        { id: 'backend-default', name: 'Default backend', type: 'subscription' },
        { id: 'backend-other', name: 'Other backend', type: 'subscription', subscriptionId: 'team-a' },
        { id: 'shared-reference', name: 'Zulu backend', type: 'subscription', subscriptionId: 'default' },
      ]),
      resolveAssistantProfiles: jest.fn().mockResolvedValue({
        defaultProfileId: 'assistant-direct',
        profiles: [
          {
            id: 'assistant-direct',
            name: 'Direct default',
            provider: 'codex-subscription',
            enabled: true,
          },
          {
            id: 'assistant-via-backend',
            name: 'Through backend',
            provider: 'openai-compatible',
            enabled: true,
            backendProfileId: 'backend-default',
          },
          {
            id: 'assistant-inline',
            name: 'Inline credential',
            provider: 'codex-subscription',
            enabled: true,
            apiKey: 'inline-token',
          },
          {
            id: 'shared-reference',
            name: 'Alpha direct',
            provider: 'codex-subscription',
            enabled: true,
          },
        ],
      }),
    } as unknown as ServerSettingsResolver
    const first = responseHarness()
    const instance = controller(provider, resolver)

    await instance.subscriptionUnpair(request({ body: { subscriptionId: 'default' } }), first.response)
    expect(first.status).toHaveBeenCalledWith(409)
    expect(first.json).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        referencedByProfiles: [
          { id: 'assistant-direct', name: 'Direct default' },
          { id: 'assistant-inline', name: 'Inline credential' },
          { id: 'assistant-via-backend', name: 'Through backend' },
          { id: 'backend-default', name: 'Default backend' },
          { id: 'shared-reference', name: 'Alpha direct' },
        ],
      }),
    })
    expect(provider.unpair).not.toHaveBeenCalled()

    const confirmed = responseHarness()
    await instance.subscriptionUnpair(
      request({ body: { subscriptionId: 'default', confirmReferencedProfiles: true } }),
      confirmed.response,
    )
    expect(provider.unpair).toHaveBeenCalledWith('default')
  })

  it('keeps all-pairing cleanup on a separately named, exact-confirmation route', async () => {
    const provider = providerMock()
    const instance = controller(provider)
    const rejected = responseHarness()
    await instance.subscriptionUnpairAll(request({ body: { confirmation: 'yes' } }), rejected.response)
    expect(rejected.status).toHaveBeenCalledWith(400)
    expect(provider.unpairAll).not.toHaveBeenCalled()

    const accepted = responseHarness()
    await instance.subscriptionUnpairAll(
      request({ body: { confirmation: 'UNPAIR ALL SUBSCRIPTIONS' } }),
      accepted.response,
    )
    expect(provider.unpairAll).toHaveBeenCalledTimes(1)
  })

  it('returns inert, non-cacheable callback HTML with restrictive browser headers', async () => {
    const provider = providerMock()
    provider.completePairing.mockResolvedValue({
      accessToken: 'never-render-this-token',
      expiresAt: 2_000_000_000_000,
      pairedAt: 1_999_999_000_000,
    })
    const harness = responseHarness()

    await controller(provider).subscriptionCallback(
      request({ query: { state: VALID_STATE, code: 'opaque-code' } }),
      harness.response,
    )

    expect(provider.completePairing).toHaveBeenCalledWith(VALID_STATE, 'opaque-code')
    expect(harness.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0')
    expect(harness.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer')
    expect(harness.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff')
    expect(harness.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY')
    expect(harness.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      expect.stringContaining("default-src 'none'"),
    )
    const html = String(harness.send.mock.calls[0][0])
    expect(html).not.toContain('<script')
    expect(html).not.toContain('window.opener')
    expect(html).not.toContain('postMessage')
    expect(html).not.toContain('never-render-this-token')
    expect(html).not.toContain(VALID_STATE)
    expect(html).not.toContain('opaque-code')
  })

  it('does not render an upstream callback error value', async () => {
    const secret = 'UPSTREAM_ERROR_SECRET'
    const provider = providerMock()
    const harness = responseHarness()

    await controller(provider).subscriptionCallback(
      request({ query: { error: secret, error_description: secret } }),
      harness.response,
    )

    expect(String(harness.send.mock.calls[0][0])).not.toContain(secret)
  })

  it.each([
    { condition: 'unpaired', storeThrows: false },
    { condition: 'needs-repair', storeThrows: false },
    { condition: 'unreadable', storeThrows: true },
  ])('performs zero upstream calls when a referenced subscription slot is $condition', async ({ storeThrows }) => {
    const provider = providerMock()
    if (storeThrows) {
      provider.getFreshCredential.mockRejectedValue(new Error('SECRET_STORE_DIAGNOSTIC'))
    } else {
      provider.getFreshCredential.mockResolvedValue(null)
    }
    const resolver = {
      resolveActiveProfile: jest.fn().mockResolvedValue({
        id: 'assistant-profile',
        name: 'Paired backend',
        provider: 'codex-subscription',
        enabled: true,
        model: 'codex-model',
        baseUrl: 'https://chatgpt.example.test/backend-api/codex',
        subscriptionId: 'team-a',
      }),
    } as unknown as ServerSettingsResolver
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(provider, resolver).streamCompletion(
      request({ body: { profileId: 'assistant-profile', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(provider.getFreshCredential).toHaveBeenCalledWith('team-a')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('credential'))
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('SECRET_STORE_DIAGNOSTIC')
    expect(harness.end).toHaveBeenCalled()
  })

  it('ignores a legacy inline subscription token, audits its profile reference, and performs zero upstream calls', async () => {
    const secret = 'LEGACY_PLAINTEXT_SUBSCRIPTION_SECRET'
    const provider = providerMock()
    provider.getFreshCredential.mockResolvedValue(null)
    const resolver = {
      resolveActiveProfile: jest.fn().mockResolvedValue({
        id: 'assistant-inline',
        name: 'Legacy inline subscription',
        provider: 'codex-subscription',
        enabled: true,
        model: 'codex-model',
        baseUrl: 'https://chatgpt.example.test/backend-api/codex',
        apiKey: secret,
      }),
      getPersistedBackendProfiles: jest.fn().mockResolvedValue([]),
      resolveAssistantProfiles: jest.fn().mockResolvedValue({
        defaultProfileId: 'assistant-inline',
        profiles: [
          {
            id: 'assistant-inline',
            name: 'Legacy inline subscription',
            provider: 'codex-subscription',
            enabled: true,
            apiKey: secret,
          },
        ],
      }),
    } as unknown as ServerSettingsResolver
    const instance = controller(provider, resolver)
    const streamHarness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await instance.streamCompletion(
      request({ body: { profileId: 'assistant-inline', messages: [] }, headers: {}, on: jest.fn() }),
      streamHarness.response,
    )

    expect(provider.getFreshCredential).toHaveBeenCalledWith(undefined)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(streamHarness.write.mock.calls)).not.toContain(secret)

    const unpairHarness = responseHarness()
    await instance.subscriptionUnpair(request({ body: { subscriptionId: 'default' } }), unpairHarness.response)
    expect(unpairHarness.status).toHaveBeenCalledWith(409)
    expect(unpairHarness.json).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        referencedByProfiles: [{ id: 'assistant-inline', name: 'Legacy inline subscription' }],
      }),
    })
    expect(provider.unpair).not.toHaveBeenCalled()
  })

  it.each([
    { condition: 'unpaired', storeThrows: false },
    { condition: 'needs-repair', storeThrows: false },
    { condition: 'unreadable', storeThrows: true },
  ])('performs zero upstream calls when the default legacy subscription is $condition', async ({ storeThrows }) => {
    const provider = providerMock()
    if (storeThrows) {
      provider.getFreshCredential.mockRejectedValue(new Error('SECRET_LEGACY_STORE_DIAGNOSTIC'))
    } else {
      provider.getFreshCredential.mockResolvedValue(null)
    }
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(provider, undefined, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'legacy-env-token-must-not-bypass-pairing',
      openaiSubscriptionBaseURL: 'https://chatgpt.example.test/backend-api/codex',
    }).streamCompletion(
      request({ body: { provider: 'openai', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(provider.getFreshCredential).toHaveBeenCalledWith('default')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('credential'))
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('SECRET_LEGACY_STORE_DIAGNOSTIC')
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('legacy-env-token-must-not-bypass-pairing')
  })

  it('allows the explicit legacy env bearer when durable pairing is not configured', async () => {
    const harness = responseHarness()
    const fetchMock = jest.fn().mockResolvedValue(
      new globalThis.Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(undefined, undefined, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'legacy-env-token',
      openaiSubscriptionBaseURL: 'https://chatgpt.example.test/backend-api/codex',
    }).streamCompletion(
      request({ body: { provider: 'openai', model: 'codex-model', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(requestHeaders.get('authorization')).toBe('Bearer legacy-env-token')
    expect(harness.end).toHaveBeenCalled()
  })

  it('does not alias a named subscription profile to the single legacy env bearer', async () => {
    const resolver = {
      resolveActiveProfile: jest.fn().mockResolvedValue({
        id: 'assistant-team',
        name: 'Named team subscription',
        provider: 'codex-subscription',
        enabled: true,
        model: 'codex-model',
        baseUrl: 'https://chatgpt.example.test/backend-api/codex',
        subscriptionId: 'team-a',
      }),
    } as unknown as ServerSettingsResolver
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(undefined, resolver, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'legacy-env-token-for-default-only',
      openaiSubscriptionBaseURL: 'https://chatgpt.example.test/backend-api/codex',
    }).streamCompletion(
      request({ body: { profileId: 'assistant-team', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('named subscription credential is unavailable'))
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('legacy-env-token-for-default-only')
  })

  it('performs zero upstream calls when the default legacy subscription endpoint is unsafe', async () => {
    const provider = providerMock()
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(provider, undefined, {
      openaiAuthMode: 'subscription',
      openaiSubscriptionToken: 'opaque-token',
      openaiSubscriptionBaseURL: 'http://remote.example.test/codex?secret=value',
    }).streamCompletion(
      request({ body: { provider: 'openai', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(provider.getFreshCredential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('No assistant provider'))
  })

  it('performs zero upstream calls when an explicit backend reference cannot be resolved', async () => {
    const provider = providerMock()
    const resolver = {
      resolveActiveProfile: jest
        .fn()
        .mockRejectedValue(new Error('Referenced assistant backend profile is unavailable: SECRET_BACKEND_ID')),
    } as unknown as ServerSettingsResolver
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(provider, resolver).streamCompletion(
      request({ body: { profileId: 'assistant-profile', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(provider.getFreshCredential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('could not be resolved safely'))
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('SECRET_BACKEND_ID')
  })

  it('performs zero upstream calls when a paired profile points at an unsafe subscription endpoint', async () => {
    const provider = providerMock()
    provider.getFreshCredential.mockResolvedValue({ token: 'opaque-token' })
    const resolver = {
      resolveActiveProfile: jest.fn().mockResolvedValue({
        id: 'assistant-profile',
        name: 'Unsafe backend',
        provider: 'codex-subscription',
        enabled: true,
        model: 'codex-model',
        baseUrl: 'http://remote.example.test/codex?userinfo=secret',
        subscriptionId: 'team-a',
      }),
    } as unknown as ServerSettingsResolver
    const harness = responseHarness()
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await controller(provider, resolver).streamCompletion(
      request({ body: { profileId: 'assistant-profile', messages: [] }, headers: {}, on: jest.fn() }),
      harness.response,
    )

    expect(provider.getFreshCredential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining('not configured'))
  })
})
