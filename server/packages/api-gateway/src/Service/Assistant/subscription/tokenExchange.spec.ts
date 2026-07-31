import { ChatGptOAuthConfig } from './oauthConfig'
import {
  exchangeCodeForToken,
  MAX_OAUTH_TOKEN_RESPONSE_BYTES,
  OAuthTokenRequestError,
  parseAccountIdFromIdToken,
  refreshAccessToken,
} from './tokenExchange'

const CLAIM = 'https://api.openai.com/auth.chatgpt_account_id'
const NOW = 2_000_000_000_000

const config: ChatGptOAuthConfig = {
  authorizeUrl: 'https://id.test/authorize',
  tokenUrl: 'https://id.test/token',
  clientId: 'client-x',
  redirectUri: 'https://notes.test/v1/assistant/subscription/callback',
  scopes: 'openid offline_access',
  accountIdClaimPath: CLAIM,
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-not-verified`
}

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockFetchOnce(body: unknown, status = 200, headers?: Record<string, string>): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue(response(body, status, headers))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('parseAccountIdFromIdToken', () => {
  it('reads exact and nested header-safe claims', () => {
    expect(parseAccountIdFromIdToken(makeIdToken({ [CLAIM]: 'acct-abc' }), CLAIM)).toBe('acct-abc')
    expect(parseAccountIdFromIdToken(makeIdToken({ auth: { id: 'acct-nested' } }), 'auth.id')).toBe('acct-nested')
  })

  it('ignores malformed, control-bearing, and oversized account ids', () => {
    expect(parseAccountIdFromIdToken(undefined, CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken('not-a-jwt', CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken('a.!!notbase64json!!.c', CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken(makeIdToken({ [CLAIM]: 'acct\r\nInjected: yes' }), CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken(makeIdToken({ [CLAIM]: 'a'.repeat(1_025) }), CLAIM)).toBeUndefined()
  })
})

describe('bounded OAuth token exchange', () => {
  it('posts an authorization grant and uses the injected clock exactly', async () => {
    const idToken = makeIdToken({ [CLAIM]: 'acct-123' })
    const fetchMock = mockFetchOnce({
      access_token: ' access-is-opaque ',
      refresh_token: 'refresh-1',
      id_token: idToken,
      expires_in: 3600,
    })

    const result = await exchangeCodeForToken(config, 'the-code', 'the-verifier', () => NOW)

    expect(result).toMatchObject({
      accessToken: ' access-is-opaque ',
      refreshToken: 'refresh-1',
      idToken,
      accountId: 'acct-123',
      expiresAt: NOW + 3600 * 1000,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(config.tokenUrl)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('error')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
  })

  it('classifies a bounded OAuth error code without echoing provider descriptions', async () => {
    const secret = 'SECRET_CODE_OR_TOKEN'
    mockFetchOnce({ error: 'invalid_grant', error_description: secret }, 400)

    let failure: unknown
    try {
      await exchangeCodeForToken(config, secret, 'verifier')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(OAuthTokenRequestError)
    expect((failure as OAuthTokenRequestError).oauthCode).toBe('invalid_grant')
    expect((failure as Error).message).not.toContain(secret)
  })

  it.each([
    [{ refresh_token: 'r' }, 'missing access token'],
    [{ access_token: 'a\r\nInjected: yes' }, 'control-bearing access token'],
    [{ access_token: 'a', refresh_token: 'r\nbad' }, 'control-bearing refresh token'],
    [{ access_token: 'a', id_token: 'id\r\nbad' }, 'control-bearing id token'],
    [{ access_token: 'a', expires_in: 0 }, 'zero expiry'],
    [{ access_token: 'a', expires_in: -1 }, 'negative expiry'],
    [{ access_token: 'a', expires_in: Number.POSITIVE_INFINITY }, 'non-finite expiry'],
    [{ access_token: 'a', expires_in: 31 * 24 * 60 * 60 + 1 }, 'unbounded expiry'],
    [{ access_token: 'a', expires_in: 1.5 }, 'fractional expiry'],
  ])('rejects hostile/malformed token response: %s (%s)', async (body) => {
    mockFetchOnce(body)
    await expect(exchangeCodeForToken(config, 'code', 'verifier', () => NOW)).rejects.toBeInstanceOf(
      OAuthTokenRequestError,
    )
  })

  it('defaults a missing expiry to one hour', async () => {
    mockFetchOnce({ access_token: 'a' })
    await expect(exchangeCodeForToken(config, 'c', 'v', () => NOW)).resolves.toMatchObject({
      expiresAt: NOW + 3600 * 1000,
    })
  })

  it('rejects a declared or streamed response over the byte ceiling', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_OAUTH_TOKEN_RESPONSE_BYTES + 1) },
        }),
      )
      .mockResolvedValueOnce(
        new Response('x'.repeat(MAX_OAUTH_TOKEN_RESPONSE_BYTES + 1), {
          status: 200,
        }),
      ) as unknown as typeof fetch

    await expect(exchangeCodeForToken(config, 'c', 'v')).rejects.toBeInstanceOf(OAuthTokenRequestError)
    await expect(exchangeCodeForToken(config, 'c', 'v')).rejects.toBeInstanceOf(OAuthTokenRequestError)
  })

  it('aborts a token endpoint that never settles and exposes no fetch error text', async () => {
    jest.useFakeTimers()
    const secret = 'REFRESH_SECRET_IN_FAKE_ERROR'
    global.fetch = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        ;(init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error(secret)), { once: true })
      })
    }) as unknown as typeof fetch

    const pending = refreshAccessToken(config, secret).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(15_000)

    const failure = await pending
    expect(failure).toBeInstanceOf(OAuthTokenRequestError)
    expect((failure as Error).message).not.toContain(secret)
  })

  it.each([
    ['authorization code', (secret: string) => exchangeCodeForToken(config, secret, 'pkce-verifier')],
    ['refresh token', (secret: string) => refreshAccessToken(config, secret)],
  ])('refuses token-endpoint redirects without replaying the %s', async (_grant, invoke) => {
    const secret = 'CREDENTIAL_THAT_MUST_NOT_BE_REPLAYED'
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      throw new TypeError(`redirect rejected near ${secret}`)
    })
    global.fetch = fetchMock as unknown as typeof fetch

    let failure: unknown
    try {
      await invoke(secret)
    } catch (error) {
      failure = error
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(failure).toBeInstanceOf(OAuthTokenRequestError)
    expect((failure as OAuthTokenRequestError).status).toBe(0)
    expect((failure as Error).message).not.toContain(secret)
  })
})

describe('refreshAccessToken', () => {
  it('posts a refresh grant and returns rotated tokens', async () => {
    const fetchMock = mockFetchOnce({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 })

    const result = await refreshAccessToken(config, 'old-refresh', () => NOW)

    expect(result).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
  })
})
