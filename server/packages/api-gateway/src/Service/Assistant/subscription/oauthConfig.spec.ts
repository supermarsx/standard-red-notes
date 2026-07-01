import { buildAuthorizeUrl, buildDefaultOAuthConfig } from './oauthConfig'

/** Builds an env accessor over a plain object (undefined for absent keys). */
function envFrom(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key]
}

describe('buildDefaultOAuthConfig', () => {
  it('applies the UNVERIFIED best-effort defaults when nothing is set', () => {
    const config = buildDefaultOAuthConfig(envFrom({}))

    expect(config.authorizeUrl).toBe('https://auth.openai.com/oauth/authorize')
    expect(config.tokenUrl).toBe('https://auth.openai.com/oauth/token')
    expect(config.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(config.scopes).toBe('openid profile email offline_access')
    expect(config.accountIdClaimPath).toBe('https://api.openai.com/auth.chatgpt_account_id')
    expect(config.revokeUrl).toBeUndefined()
  })

  it('derives the redirect URI from PUBLIC_URL', () => {
    const config = buildDefaultOAuthConfig(envFrom({ PUBLIC_URL: 'https://notes.example.test/' }))
    expect(config.redirectUri).toBe('https://notes.example.test/v1/assistant/subscription/callback')
  })

  it('leaves the redirect URI empty when neither PUBLIC_URL nor an override is set', () => {
    expect(buildDefaultOAuthConfig(envFrom({})).redirectUri).toBe('')
  })

  it('lets every value be overridden via env', () => {
    const config = buildDefaultOAuthConfig(
      envFrom({
        ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL: 'https://id.local/authorize',
        ASSISTANT_CHATGPT_OAUTH_TOKEN_URL: 'https://id.local/token',
        ASSISTANT_CHATGPT_OAUTH_CLIENT_ID: 'my-client',
        ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI: 'http://localhost:1455/auth/callback',
        ASSISTANT_CHATGPT_OAUTH_SCOPES: 'openid',
        ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM: 'account_id',
        ASSISTANT_CHATGPT_OAUTH_REVOKE_URL: 'https://id.local/revoke',
        PUBLIC_URL: 'https://ignored.example',
      }),
    )

    expect(config.authorizeUrl).toBe('https://id.local/authorize')
    expect(config.tokenUrl).toBe('https://id.local/token')
    expect(config.clientId).toBe('my-client')
    expect(config.redirectUri).toBe('http://localhost:1455/auth/callback')
    expect(config.scopes).toBe('openid')
    expect(config.accountIdClaimPath).toBe('account_id')
    expect(config.revokeUrl).toBe('https://id.local/revoke')
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes response_type, client_id, redirect_uri, scope, challenge (S256) and state', () => {
    const config = buildDefaultOAuthConfig(envFrom({ PUBLIC_URL: 'https://notes.example.test' }))
    const url = new URL(buildAuthorizeUrl(config, { state: 'st-123', codeChallenge: 'chal-abc' }))

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(config.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(url.searchParams.get('code_challenge')).toBe('chal-abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st-123')
  })
})
