/**
 * ChatGPT / Codex OAuth (PKCE S256) configuration for the subscription pairing
 * flow.
 *
 * IMPORTANT / UNVERIFIED: NONE of these defaults are a stable, public OpenAI API.
 * Every endpoint, the client id, the scopes, and the account-id claim path are
 * best-effort values based on the publicly-observed shape of the Codex CLI login
 * flow. They MUST be verified against a live ChatGPT account before this can be
 * claimed to work end-to-end, and every one of them is fully env-overridable so
 * pointing at the real contract is a config change, not a code change. Tests MOCK
 * these endpoints.
 *
 * HONEST LIMITATION (do not hide): OpenAI's Codex `client_id` historically only
 * permits a LOCALHOST redirect URI (http://localhost:1455/auth/callback), so a
 * server-hosted redirect may be rejected by the live provider unless the operator
 * registers their own OAuth client / redirect URI. `clientId` and `redirectUri`
 * are env-overridable precisely so this is an operator config change.
 */

/** Fully-resolved OAuth parameters the pairing flow needs. Pure data. */
export interface ChatGptOAuthConfig {
  /** OAuth authorize endpoint the admin's browser is sent to. */
  authorizeUrl: string
  /** OAuth token endpoint used for the code exchange and for refreshes. */
  tokenUrl: string
  /** OAuth client id. UNVERIFIED default; env-overridable. */
  clientId: string
  /** Redirect URI registered for this client. Must match the provider exactly. */
  redirectUri: string
  /** Space-delimited OAuth scopes. */
  scopes: string
  /** Dot-path of the account-id claim inside the decoded id_token JWT payload. */
  accountIdClaimPath: string
  /** Optional token-revocation endpoint (best-effort revoke on unpair). */
  revokeUrl?: string
}

/** Accessor over the environment so this stays pure and unit-testable. */
export type EnvGetter = (key: string) => string | undefined

// ---- UNVERIFIED best-effort defaults (see module header) ----

// UNVERIFIED: must be verified against a live ChatGPT account; env-overridable
// via ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL.
const DEFAULT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
// UNVERIFIED: must be verified against a live ChatGPT account; env-overridable
// via ASSISTANT_CHATGPT_OAUTH_TOKEN_URL.
const DEFAULT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
// UNVERIFIED: publicly-observed Codex CLI client id; env-overridable via
// ASSISTANT_CHATGPT_OAUTH_CLIENT_ID. See the localhost-redirect caveat above.
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
// UNVERIFIED: OpenID + offline_access to obtain a refresh token; env-overridable
// via ASSISTANT_CHATGPT_OAUTH_SCOPES.
const DEFAULT_SCOPES = 'openid profile email offline_access'
// UNVERIFIED: account-id claim path inside the id_token; env-overridable via
// ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM.
const DEFAULT_ACCOUNT_ID_CLAIM = 'https://api.openai.com/auth.chatgpt_account_id'

/**
 * Builds the OAuth config from environment, applying the UNVERIFIED defaults
 * above. Pure: reads only through the supplied `env` accessor (never touches
 * process.env directly) so it is trivially testable.
 *
 * The redirect URI defaults to `<PUBLIC_URL>/v1/assistant/subscription/callback`
 * when PUBLIC_URL is set, and is fully overridable via
 * ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI.
 */
export function buildDefaultOAuthConfig(env: EnvGetter): ChatGptOAuthConfig {
  const publicUrl = (env('PUBLIC_URL') ?? '').replace(/\/$/, '')
  const defaultRedirectUri = publicUrl ? `${publicUrl}/v1/assistant/subscription/callback` : ''

  return {
    authorizeUrl: env('ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL') || DEFAULT_AUTHORIZE_URL,
    tokenUrl: env('ASSISTANT_CHATGPT_OAUTH_TOKEN_URL') || DEFAULT_TOKEN_URL,
    clientId: env('ASSISTANT_CHATGPT_OAUTH_CLIENT_ID') || DEFAULT_CLIENT_ID,
    redirectUri: env('ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI') || defaultRedirectUri,
    scopes: env('ASSISTANT_CHATGPT_OAUTH_SCOPES') || DEFAULT_SCOPES,
    accountIdClaimPath: env('ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM') || DEFAULT_ACCOUNT_ID_CLAIM,
    revokeUrl: env('ASSISTANT_CHATGPT_OAUTH_REVOKE_URL') || undefined,
  }
}

/**
 * Builds the authorize URL (PKCE S256) the admin's browser is redirected to.
 * Kept here next to the config so callers never hand-assemble query strings.
 */
export function buildAuthorizeUrl(
  config: ChatGptOAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('scope', config.scopes)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', params.state)
  return url.toString()
}
