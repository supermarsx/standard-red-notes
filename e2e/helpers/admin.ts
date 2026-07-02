import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { type Page } from '@playwright/test'

/**
 * Helpers for the ADMIN-story gate (tests/admin.spec.ts).
 *
 * Two surfaces are driven:
 *
 *   1. The PUBLIC HTTP API on the app front door (:3001, nginx → api-gateway):
 *      raw-fetch register / PKCE sign-in / session refresh / arbitrary calls.
 *      Registering over the raw API lets us CHOOSE the server password, so a
 *      later sign-in needs no client-side key derivation:
 *        - register: POST /v1/users        (the `password` field IS the server password)
 *        - sign-in:  POST /v2/login-params (registers the PKCE code challenge)
 *                    POST /v1/login        (email + server password + code_verifier)
 *      PKCE per the auth server's SignIn use case: the challenge is
 *      base64url(utf8(sha256hex(verifier))) — sha256 hex STRING, then base64url
 *      of that string (see server .../Domain/UseCase/SignIn.ts validateCodeVerifier
 *      + CryptoNode.sha256/base64URLEncode).
 *
 *   2. The srn-admin CLI inside the server container
 *      (`docker compose exec -T server srn-admin ...`), the operator-side grant
 *      path (grant-admin / groups / list-roles).
 *
 * All users created here are collision-resistant throwaways on @local.test,
 * mirroring the stress harness convention, so the spec is safe to re-run.
 */

export const APP_URL = process.env.APP_URL?.trim() || 'http://localhost:3001'
const API_VERSION = '20200115'

/** Repo root (docker-compose.yml lives here); the CLI must run from it. */
const REPO_ROOT = path.resolve(__dirname, '..', '..')

export type TestUser = { email: string; password: string }
export type Session = {
  access_token: string
  refresh_token: string
  access_expiration: number
  refresh_expiration: number
}

export function freshUser(tag: string): TestUser {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { email: `${tag}-${id}@local.test`, password: `Pw-${id}-Aa1!` }
}

/** Raw JSON call against the app front door. Returns status + unwrapped data. */
export async function apiCall(
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; data: any; rawText: string }> {
  const res = await fetch(`${APP_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const rawText = await res.text()
  let parsed: any = rawText
  try {
    parsed = JSON.parse(rawText)
  } catch {
    /* non-JSON (e.g. the SPA fallback) stays a string */
  }
  return { status: res.status, data: parsed?.data ?? parsed, rawText }
}

/** Register a throwaway account through the public API; returns uuid + session. */
export async function registerUser(user: TestUser): Promise<{ uuid: string; session: Session }> {
  const { status, data } = await apiCall('POST', '/v1/users', {
    body: {
      api: API_VERSION,
      email: user.email,
      password: user.password,
      version: '004',
      pw_nonce: crypto.randomBytes(16).toString('hex'),
      identifier: user.email,
      origination: 'registration',
      created: `${Date.now()}`,
    },
  })
  if (status !== 200 || !data?.session) {
    throw new Error(`register failed (${status}): ${JSON.stringify(data).slice(0, 300)}`)
  }
  return { uuid: data.user.uuid as string, session: data.session as Session }
}

/** PKCE sign-in through the public API — mints a FRESH session. */
export async function signInUser(user: TestUser): Promise<Session> {
  const verifier = crypto.randomBytes(32).toString('hex')
  const challenge = Buffer.from(crypto.createHash('sha256').update(verifier).digest('hex'), 'utf8').toString(
    'base64url',
  )
  const params = await apiCall('POST', '/v2/login-params', {
    body: { api: API_VERSION, email: user.email, code_challenge: challenge },
  })
  if (params.status !== 200) {
    throw new Error(`login-params failed (${params.status}): ${JSON.stringify(params.data).slice(0, 300)}`)
  }
  const login = await apiCall('POST', '/v1/login', {
    body: { api: API_VERSION, email: user.email, password: user.password, code_verifier: verifier },
  })
  if (login.status !== 200 || !login.data?.session) {
    throw new Error(`login failed (${login.status}): ${JSON.stringify(login.data).slice(0, 300)}`)
  }
  return login.data.session as Session
}

/** Refresh an existing session (POST /v1/sessions/refresh). */
export async function refreshSession(session: Session): Promise<Session> {
  const { status, data } = await apiCall('POST', '/v1/sessions/refresh', {
    body: { api: API_VERSION, access_token: session.access_token, refresh_token: session.refresh_token },
  })
  if (status !== 200 || !data?.session) {
    throw new Error(`refresh failed (${status}): ${JSON.stringify(data).slice(0, 300)}`)
  }
  return data.session as Session
}

/** Run the in-container operator CLI: srn-admin <args...>. Throws on non-zero exit. */
export function srnAdmin(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'server', 'srn-admin', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Best-effort cleanup — failures must never fail the spec. */
export function srnAdminQuiet(...args: string[]): void {
  try {
    srnAdmin(...args)
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* UI-side helpers (driving the real web app in a Playwright page).    */
/* ------------------------------------------------------------------ */

/** Wait until the in-page snjs application has launched. */
export async function waitForAppReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = (window as any).mainApplicationGroup?.primaryApplication
      return Boolean(app && typeof app.isLaunched === 'function' && app.isLaunched())
    },
    undefined,
    { timeout: timeoutMs },
  )
}

/**
 * Register a fresh account INSIDE the page via the real snjs application.
 * NOTE: accounts registered through the raw API (registerUser above) cannot be
 * signed into from the client — the client derives the server password from the
 * root password + key params, while registerUser sends the server password
 * directly. UI tests therefore create their user in-page.
 */
export async function registerInPage(page: Page, user: TestUser): Promise<void> {
  await page.evaluate(async ({ email, password }) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const res = await app.register(email, password, '')
    if (res && res.error) throw new Error(`register failed: ${res.error.message ?? JSON.stringify(res.error)}`)
    if (!app.user.isSignedIn()) throw new Error('register returned but user is not signed in')
  }, user)
}

/**
 * Force a round-trip whose response meta carries the CURRENT server-side roles
 * (every decorated gateway response embeds meta.auth.roles, which snjs feeds to
 * FeaturesService.updateOnlineRolesWithNewValues), then wait until the client's
 * stored role set reports the expected admin state.
 */
export async function syncAndWaitForAdminRole(page: Page, expectAdmin: boolean, timeoutMs = 30_000): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    await app.sync.sync({ sourceDescription: 'admin-spec-role-refresh' })
  })
  await page.waitForFunction(
    (want) => {
      const app = (window as any).mainApplicationGroup?.primaryApplication
      const has = Boolean(app?.featuresController?.isAdminUser?.())
      return has === want
    },
    expectAdmin,
    { timeout: timeoutMs },
  )
}

/** Open the in-app Preferences overlay (fresh menu build each open). */
export async function openPreferences(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    app.openPreferences()
  })
  await page.locator('.preferences-menu-item').first().waitFor({ state: 'visible', timeout: 15_000 })
}

export async function closePreferences(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    app.preferencesController.closePreferences()
  })
}
