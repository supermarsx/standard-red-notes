import { ChatGptOAuthConfig } from './oauthConfig'

/**
 * OAuth token endpoint calls for the ChatGPT / Codex subscription pairing flow:
 * the authorization-code exchange and the refresh-token rotation, plus the small
 * JWT helper that reads the account id out of the returned id_token.
 *
 * Uses the global `fetch` so tests can mock it. NEVER logs the authorization
 * code, the PKCE verifier, or any token — those are secrets in transit.
 *
 * UNVERIFIED: the request/response wire shape assumed here (a JSON body of
 * `{ access_token, refresh_token, id_token, expires_in }` and a form-encoded
 * grant request) is the standard OAuth 2.0 shape but MUST be verified against a
 * live ChatGPT account. See oauthConfig.ts.
 */

/** Normalized result of a token exchange or refresh. `expiresAt` is epoch ms. */
export interface TokenExchangeResult {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt: number
  accountId?: string
}

/** Raw OAuth token endpoint JSON (only the fields we consume). */
interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  token_type?: string
}

// Assume a 1-hour access-token lifetime when the provider omits expires_in.
const DEFAULT_EXPIRES_IN_SECONDS = 3600

function base64UrlDecodeToString(segment: string): string {
  return Buffer.from(segment, 'base64url').toString('utf8')
}

/**
 * Reads a dot-path claim (e.g. `https://api.openai.com/auth.chatgpt_account_id`)
 * out of an id_token JWT payload. Returns undefined for any malformed token,
 * missing segment, or absent claim — never throws, so a surprising token shape
 * degrades to "no account id" instead of failing the whole pairing.
 *
 * Note: the claim key itself may contain dots (as the default URL-style claim
 * does). We first try the whole path as a single literal key, then fall back to
 * walking it as a dot-separated path.
 */
export function parseAccountIdFromIdToken(idToken: string | undefined, claimPath: string): string | undefined {
  if (!idToken || typeof idToken !== 'string') {
    return undefined
  }
  const segments = idToken.split('.')
  if (segments.length < 2) {
    return undefined
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(base64UrlDecodeToString(segments[1])) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  // Exact-key match first (handles URL-style claim keys that contain dots).
  const exact = payload[claimPath]
  if (typeof exact === 'string' && exact.length > 0) {
    return exact
  }

  // Otherwise walk the dot-path.
  let current: unknown = payload
  for (const key of claimPath.split('.')) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

async function postTokenRequest(
  config: ChatGptOAuthConfig,
  body: Record<string, string>,
): Promise<TokenExchangeResult> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  })

  if (!response.ok) {
    // Do not include the response body verbatim — it can echo the code/token.
    throw new Error(`OAuth token request failed with status ${response.status}`)
  }

  const json = (await response.json()) as RawTokenResponse
  const accessToken = (json.access_token ?? '').trim()
  if (!accessToken) {
    throw new Error('OAuth token response did not include an access_token')
  }

  const expiresInSeconds = typeof json.expires_in === 'number' ? json.expires_in : DEFAULT_EXPIRES_IN_SECONDS
  const expiresAt = Date.now() + expiresInSeconds * 1000

  return {
    accessToken,
    refreshToken: json.refresh_token || undefined,
    idToken: json.id_token || undefined,
    expiresAt,
    accountId: parseAccountIdFromIdToken(json.id_token, config.accountIdClaimPath),
  }
}

/** Exchanges an authorization `code` (+ PKCE `verifier`) for tokens. */
export function exchangeCodeForToken(
  config: ChatGptOAuthConfig,
  code: string,
  verifier: string,
): Promise<TokenExchangeResult> {
  return postTokenRequest(config, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: verifier,
  })
}

/** Rotates an access token using a stored refresh token. */
export function refreshAccessToken(config: ChatGptOAuthConfig, refreshToken: string): Promise<TokenExchangeResult> {
  return postTokenRequest(config, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  })
}
