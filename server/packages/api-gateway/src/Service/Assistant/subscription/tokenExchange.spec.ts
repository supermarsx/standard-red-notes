import { ChatGptOAuthConfig } from './oauthConfig'
import { exchangeCodeForToken, parseAccountIdFromIdToken, refreshAccessToken } from './tokenExchange'

const CLAIM = 'https://api.openai.com/auth.chatgpt_account_id'

const config: ChatGptOAuthConfig = {
  authorizeUrl: 'https://id.test/authorize',
  tokenUrl: 'https://id.test/token',
  clientId: 'client-x',
  redirectUri: 'https://notes.test/v1/assistant/subscription/callback',
  scopes: 'openid offline_access',
  accountIdClaimPath: CLAIM,
}

/** Builds a real-shaped (unsigned) JWT with the given payload. */
function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-not-verified`
}

function mockFetchOnce(body: unknown, ok = true, status = 200): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('parseAccountIdFromIdToken', () => {
  it('reads a URL-style claim key that itself contains dots', () => {
    const token = makeIdToken({ [CLAIM]: 'acct-abc', sub: 'user-1' })
    expect(parseAccountIdFromIdToken(token, CLAIM)).toBe('acct-abc')
  })

  it('walks a nested dot-path claim', () => {
    const token = makeIdToken({ auth: { chatgpt_account_id: 'acct-nested' } })
    expect(parseAccountIdFromIdToken(token, 'auth.chatgpt_account_id')).toBe('acct-nested')
  })

  it('returns undefined for a missing claim', () => {
    const token = makeIdToken({ sub: 'user-1' })
    expect(parseAccountIdFromIdToken(token, CLAIM)).toBeUndefined()
  })

  it('returns undefined for malformed / empty input without throwing', () => {
    expect(parseAccountIdFromIdToken(undefined, CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken('', CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken('not-a-jwt', CLAIM)).toBeUndefined()
    expect(parseAccountIdFromIdToken('a.!!notbase64json!!.c', CLAIM)).toBeUndefined()
  })
})

describe('exchangeCodeForToken', () => {
  it('POSTs an authorization_code grant and normalizes the token response', async () => {
    const idToken = makeIdToken({ [CLAIM]: 'acct-123' })
    const fetchMock = mockFetchOnce({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      id_token: idToken,
      expires_in: 3600,
    })

    const before = Date.now()
    const result = await exchangeCodeForToken(config, 'the-code', 'the-verifier')

    expect(result.accessToken).toBe('access-1')
    expect(result.refreshToken).toBe('refresh-1')
    expect(result.idToken).toBe(idToken)
    expect(result.accountId).toBe('acct-123')
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(config.tokenUrl)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('client_id')).toBe('client-x')
    expect(body.get('redirect_uri')).toBe(config.redirectUri)
  })

  it('throws on a non-OK response without echoing the body', async () => {
    mockFetchOnce({ error: 'invalid_grant', code: 'the-secret-code' }, false, 400)
    await expect(exchangeCodeForToken(config, 'c', 'v')).rejects.toThrow(/status 400/)
    await expect(exchangeCodeForToken(config, 'c', 'v')).rejects.not.toThrow(/the-secret-code/)
  })

  it('throws when access_token is absent', async () => {
    mockFetchOnce({ refresh_token: 'r' })
    await expect(exchangeCodeForToken(config, 'c', 'v')).rejects.toThrow(/access_token/)
  })

  it('defaults expiry to one hour when expires_in is omitted', async () => {
    const before = Date.now()
    mockFetchOnce({ access_token: 'a' })
    const result = await exchangeCodeForToken(config, 'c', 'v')
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })
})

describe('refreshAccessToken', () => {
  it('POSTs a refresh_token grant and returns rotated tokens', async () => {
    const fetchMock = mockFetchOnce({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 })

    const result = await refreshAccessToken(config, 'old-refresh')

    expect(result.accessToken).toBe('access-2')
    expect(result.refreshToken).toBe('refresh-2')

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.get('client_id')).toBe('client-x')
  })

  it('throws on a failed refresh', async () => {
    mockFetchOnce({ error: 'invalid_grant' }, false, 400)
    await expect(refreshAccessToken(config, 'old-refresh')).rejects.toThrow(/status 400/)
  })
})
