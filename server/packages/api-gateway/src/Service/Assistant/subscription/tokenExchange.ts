import { ChatGptOAuthConfig, parseSafeOAuthUrl } from './oauthConfig'

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

export class OAuthTokenRequestError extends Error {
  constructor(
    readonly status: number,
    readonly oauthCode: string | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(
      status > 0 ? `OAuth token request failed with status ${status}.` : 'OAuth token request could not be reached.',
    )
    this.name = 'OAuthTokenRequestError'
  }
}

// Assume a 1-hour access-token lifetime when the provider omits expires_in.
const DEFAULT_EXPIRES_IN_SECONDS = 3600
const MAX_EXPIRES_IN_SECONDS = 31 * 24 * 60 * 60
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000
export const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 15_000
export const MAX_OAUTH_TOKEN_RESPONSE_BYTES = 512 * 1024
const MAX_OAUTH_TOKEN_LENGTH = 256 * 1024
const MAX_ACCOUNT_ID_LENGTH = 1_024

function isHeaderSafeOpaqueValue(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function safeOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined
}

function parseRetryAfter(response: Response, now: () => number): number | undefined {
  const raw = response.headers?.get?.('retry-after')
  if (!raw) {
    return undefined
  }
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
  }
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) {
    return undefined
  }
  return Math.min(Math.max(0, date - now()), MAX_RETRY_AFTER_MS)
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_OAUTH_TOKEN_RESPONSE_BYTES) {
      throw new OAuthTokenRequestError(response.status, undefined, undefined)
    }
  }

  const reader = response.body?.getReader()
  if (!reader) {
    return undefined
  }
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      bytes += value.byteLength
      if (bytes > MAX_OAUTH_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new OAuthTokenRequestError(response.status, undefined, undefined)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
  } catch {
    throw new OAuthTokenRequestError(response.status, undefined, undefined)
  }
}

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
  if (isHeaderSafeOpaqueValue(exact, MAX_ACCOUNT_ID_LENGTH)) {
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
  return isHeaderSafeOpaqueValue(current, MAX_ACCOUNT_ID_LENGTH) ? current : undefined
}

async function postTokenRequest(
  config: ChatGptOAuthConfig,
  body: Record<string, string>,
  now: () => number,
): Promise<TokenExchangeResult> {
  const tokenUrl = parseSafeOAuthUrl(config.tokenUrl, 'OAuth token URL').toString()
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), OAUTH_TOKEN_REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
      // OAuth grant bodies contain an authorization code + PKCE verifier or a
      // renewable refresh token. Never let fetch replay that POST to a Location
      // supplied by the token endpoint (including same-origin redirects).
      redirect: 'error',
      signal: abortController.signal,
    })

    if (!response.ok) {
      // Read only the bounded OAuth error code used for classification. Ignore
      // descriptions and every other body field because providers sometimes echo
      // codes/tokens there.
      let oauthCode: string | undefined
      try {
        const errorBody = (await readBoundedJson(response)) as { error?: unknown } | undefined
        oauthCode = safeOAuthErrorCode(errorBody?.error)
      } catch (error) {
        if (!(error instanceof OAuthTokenRequestError)) {
          throw error
        }
        // Invalid/oversized error bodies remain a generic status-classified error.
      }
      throw new OAuthTokenRequestError(response.status, oauthCode, parseRetryAfter(response, now))
    }

    const json = (await readBoundedJson(response)) as RawTokenResponse | undefined
    const accessToken = json?.access_token
    if (!isHeaderSafeOpaqueValue(accessToken, MAX_OAUTH_TOKEN_LENGTH)) {
      throw new OAuthTokenRequestError(response.status, undefined, undefined)
    }
    if (
      (json?.refresh_token !== undefined && !isHeaderSafeOpaqueValue(json.refresh_token, MAX_OAUTH_TOKEN_LENGTH)) ||
      (json?.id_token !== undefined && !isHeaderSafeOpaqueValue(json.id_token, MAX_OAUTH_TOKEN_LENGTH))
    ) {
      throw new OAuthTokenRequestError(response.status, undefined, undefined)
    }

    const expiresInSeconds = json?.expires_in === undefined ? DEFAULT_EXPIRES_IN_SECONDS : json.expires_in
    if (
      typeof expiresInSeconds !== 'number' ||
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_EXPIRES_IN_SECONDS
    ) {
      throw new OAuthTokenRequestError(response.status, undefined, undefined)
    }
    const expiresAt = now() + expiresInSeconds * 1000

    return {
      accessToken,
      refreshToken: json?.refresh_token || undefined,
      idToken: json?.id_token || undefined,
      expiresAt,
      accountId: parseAccountIdFromIdToken(json?.id_token, config.accountIdClaimPath),
    }
  } catch (error) {
    if (error instanceof OAuthTokenRequestError) {
      throw error
    }
    // Never propagate fetch/parser implementation messages: they can include the
    // request URL/body and therefore an authorization code or refresh token.
    throw new OAuthTokenRequestError(0, undefined, undefined)
  } finally {
    clearTimeout(timeout)
  }
}

/** Exchanges an authorization `code` (+ PKCE `verifier`) for tokens. */
export function exchangeCodeForToken(
  config: ChatGptOAuthConfig,
  code: string,
  verifier: string,
  now: () => number = () => Date.now(),
): Promise<TokenExchangeResult> {
  return postTokenRequest(
    config,
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: verifier,
    },
    now,
  )
}

/** Rotates an access token using a stored refresh token. */
export function refreshAccessToken(
  config: ChatGptOAuthConfig,
  refreshToken: string,
  now: () => number = () => Date.now(),
): Promise<TokenExchangeResult> {
  return postTokenRequest(
    config,
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    },
    now,
  )
}
