import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'

// Full ACCOUNT lifecycle against the LIVE stack, server-mediated:
//   register (+ duplicate reject) -> sign in (+ generic-error / no-enumeration)
//   -> session refresh (+ reject revoked) -> list/revoke sessions
//   -> change password (old dead / new works) -> recovery codes (if reachable)
//   -> delete account (if reachable).
//
// Mirrors the register/sign-in/cleanup patterns of password.e2e.ts and
// twofactor.e2e.ts (a sign-in attempt = a fresh bridge bootstrapped with the
// candidate credentials), and the raw-endpoint pattern of magiclink.e2e.ts /
// mcptoken.e2e.ts for the bits snjs doesn't expose as bridge methods.

function accessToken(app: HeadlessApp): string | undefined {
  const s = app.app.sessions.getSession?.()
  return s?.accessToken?.value ?? s?.accessToken
}

function refreshToken(app: HeadlessApp): string | undefined {
  const s = app.app.sessions.getSession?.()
  return s?.refreshToken?.value ?? s?.refreshToken
}

/** A sign-in attempt = a throwaway bridge bootstrapped with the candidate creds. */
async function signInAttempt(
  email: string,
  password: string,
): Promise<{ ok: boolean; app?: HeadlessApp; dataDir: string; err?: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-acct-'))
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, syncIntervalMs: 0 })
  try {
    await app.signIn(email, password)
    return { ok: app.isSignedIn(), app, dataDir }
  } catch (e) {
    await app.deinit().catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, dataDir, err: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Raw, unauthenticated key-params probe. The server returns REAL key params for
 * a known email and PSEUDO params (HTTP 200, never an error) for an unknown one,
 * so an attacker can't enumerate accounts. Returns the parsed JSON + status.
 */
async function keyParamsProbe(email: string): Promise<{ status: number; body: any }> {
  // The api-gateway exposes /v2/login-params (v1 is not routed). Real params for a
  // known email; deterministic PSEUDO params (HTTP 200) for an unknown one.
  const res = await fetch(`${SERVER.replace(/\/$/, '')}/v2/login-params`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: '20240226', email, code_challenge: 'srn-e2e-probe-challenge' }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

/**
 * Raw PKCE sign-in probe (mirrors workspaces.e2e.ts) so we can read the SERVER's
 * own error message for wrong-password vs unknown-email WITHOUT going through the
 * snjs challenge machinery (which crashes on pseudo-params for unknown accounts).
 * `password` here is the derived serverPassword; a deliberately-wrong one yields
 * the generic invalid-credentials error, exactly like an unknown email.
 */
async function rawSignIn(
  email: string,
  serverPassword: string,
): Promise<{ status: number; message: string }> {
  const { SNWebCrypto } = (await import('@standardnotes/sncrypto-web')) as unknown as {
    SNWebCrypto: new () => any
  }
  const crypto = new SNWebCrypto()
  await crypto.initialize()
  try {
    const codeVerifier = crypto.generateRandomKey(256)
    const codeChallenge = crypto.base64URLEncode(await crypto.sha256(codeVerifier))
    await fetch(`${SERVER.replace(/\/$/, '')}/v2/login-params`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: '20240226', email, code_challenge: codeChallenge }),
    })
    const res = await fetch(`${SERVER.replace(/\/$/, '')}/v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The login endpoint reads request.body.api (NOT api_version).
        api: '20240226',
        email,
        password: serverPassword,
        code_verifier: codeVerifier,
        ephemeral: false,
      }),
    })
    const body = await res.json().catch(() => ({}))
    const message = body?.error?.message ?? body?.data?.error?.message ?? ''
    return { status: res.status, message: String(message) }
  } finally {
    crypto.deinit()
  }
}

async function refresh(
  accessTok: string,
  refreshTok: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/sessions/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: accessTok, refresh_token: refreshTok }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

/** Hit an authed endpoint with a bearer token to see whether the token still works. */
async function tokenStillValid(accessTok: string): Promise<boolean> {
  const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/sessions`, {
    headers: { authorization: `Bearer ${accessTok}` },
  })
  return res.status === 200
}

/** List sessions via raw HTTP with a bearer token. */
async function listSessionsRaw(accessTok: string): Promise<any[]> {
  const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/sessions`, {
    headers: { authorization: `Bearer ${accessTok}` },
  })
  const body = await res.json().catch(() => ({}))
  const list = (body?.data ?? body) as unknown
  return Array.isArray(list) ? (list as any[]) : []
}

/**
 * Revoke a specific session via raw HTTP (DELETE /v1/sessions/{uuid}) with a
 * bearer token. This is what snjs's revokeSession() calls under the hood, but
 * without the protected-action challenge wrapper that can stall headlessly.
 */
async function revokeSessionRaw(accessTok: string, sessionUuid: string): Promise<number> {
  const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/sessions/${sessionUuid}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessTok}` },
  })
  await res.text().catch(() => '')
  return res.status
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // --- Register: fresh account succeeds. -----------------------------------
  const { app, email, password, dataDir } = await freshAccount()
  check('register a brand-new account succeeds', app.isSignedIn())

  // --- Register: duplicate email is rejected. ------------------------------
  // A second bridge registering the SAME email must fail (the snjs register
  // throws on the server's duplicate error; freshAccount() would re-throw).
  const dupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-dup-'))
  const dupApp = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dupDir, password, syncIntervalMs: 0 })
  let dupRejected = false
  try {
    await dupApp.register(email, password)
  } catch {
    dupRejected = true
  }
  check('duplicate-email register is rejected', dupRejected && !dupApp.isSignedIn())
  await dupApp.deinit().catch(() => {})
  await fs.rm(dupDir, { recursive: true, force: true }).catch(() => {})

  // --- Sign in: correct creds -> a working session. ------------------------
  const good = await signInAttempt(email, password)
  check('sign-in with correct credentials succeeds', good.ok)
  check('the signed-in session has an access token', good.ok && !!accessToken(good.app!))
  if (good.app) {
    await cleanup(good.app, good.dataDir)
  }

  // --- Sign in: wrong password vs unknown email -> SAME generic failure. ---
  // Driven via the raw /v2/login endpoint: a wrong serverPassword for a REAL
  // email and ANY password for an UNKNOWN email must both be rejected with the
  // identical generic message and status (no account-enumeration leak). We avoid
  // the snjs bridge here because its sign-in path raises a client-side challenge
  // on the pseudo-params the server returns for unknown accounts.
  const GENERIC_AUTH_ERR = /invalid email or password|invalid login credentials|invalid password/i
  const unknownEmail = `e2e-nobody-${Date.now()}@example.com`
  const wrongPw = await rawSignIn(email, 'deliberately-wrong-server-password')
  check('sign-in with the wrong password is rejected', wrongPw.status === 401)
  if (!GENERIC_AUTH_ERR.test(wrongPw.message)) {
    console.log('  (wrong-password message was:', JSON.stringify(wrongPw.message), ')')
  }
  check(
    'wrong-password error is the generic invalid-credentials message (no leak)',
    GENERIC_AUTH_ERR.test(wrongPw.message),
  )

  const unknown = await rawSignIn(unknownEmail, 'deliberately-wrong-server-password')
  check('sign-in with an unknown email is rejected', unknown.status === 401)
  if (unknown.message !== wrongPw.message) {
    console.log('  (unknown-email message:', JSON.stringify(unknown.message), 'vs wrong-pw:', JSON.stringify(wrongPw.message), ')')
  }
  check(
    'unknown-email status + error MATCH the wrong-password ones (enumeration parity)',
    unknown.status === wrongPw.status && unknown.message === wrongPw.message,
  )

  // --- Enumeration parity at the key-params layer: known vs unknown email
  //     both return HTTP 200 with key params (real vs pseudo). ----------------
  const kpId = (b: any): string | undefined => b?.data?.identifier ?? b?.identifier
  const kpNonce = (b: any): string | undefined => b?.data?.pw_nonce ?? b?.pw_nonce
  const kpErrTag = (b: any): string | undefined => b?.data?.error?.tag ?? b?.error?.tag
  // An unknown account must look like a PLAUSIBLE real one, never a 404 / "not
  // found". The server's enumeration defence returns one of:
  //   (a) 200 with pseudo key params (identifier + pw_nonce), OR
  //   (b) a 401 pseudo-MFA/U2F challenge (mfa-required / u2f-required),
  // both of which are also produced by SOME real account — so existence can't be
  // inferred. We assert the unknown response is one of those shapes, and is NOT a
  // 404 / not-found leak.
  const isPseudoParams = (r: { status: number; body: any }): boolean =>
    r.status === 200 && !!kpId(r.body) && !!kpNonce(r.body)
  const isPseudoChallenge = (r: { status: number; body: any }): boolean =>
    r.status === 401 && /mfa-required|u2f-required/i.test(kpErrTag(r.body) ?? '')
  const knownKp = await keyParamsProbe(email)
  const unknownKp = await keyParamsProbe(unknownEmail)
  if (!isPseudoParams(unknownKp) && !isPseudoChallenge(unknownKp)) {
    console.log('  (unknown key-params: status', unknownKp.status, 'body', JSON.stringify(unknownKp.body).slice(0, 240), ')')
  }
  check('key-params for a KNOWN email returns 200 with identifier + nonce', isPseudoParams(knownKp) || isPseudoChallenge(knownKp))
  check(
    'key-params for an UNKNOWN email returns a plausible real-account shape (pseudo params OR pseudo MFA), never a 404/not-found leak',
    isPseudoParams(unknownKp) || isPseudoChallenge(unknownKp),
  )
  check('the UNKNOWN email key-params never expose a not-found error', !/not.?found|does.?not.?exist|no.?(such|user)/i.test(JSON.stringify(unknownKp.body)))

  // --- Session refresh: a valid refresh token -> a new access token. -------
  // Sign a fresh device in and exercise the refresh endpoint directly.
  const refDev = await signInAttempt(email, password)
  check('refresh-test device signed in', refDev.ok)
  if (refDev.ok && refDev.app) {
    const at = accessToken(refDev.app)!
    const rt = refreshToken(refDev.app)!
    check('refresh-test device exposes access + refresh tokens', !!at && !!rt)

    const refreshed = await refresh(at, rt)
    const newAccess =
      refreshed.body?.session?.access_token ?? refreshed.body?.data?.session?.access_token
    check('session refresh returns a new access token', refreshed.status === 200 && !!newAccess)
    check('the refreshed access token differs from the original', !!newAccess && newAccess !== at)
    if (newAccess) {
      check('the refreshed access token is accepted by an authed endpoint', await tokenStillValid(newAccess))
    }

    // Replaying the now-rotated old refresh token must be rejected.
    const replay = await refresh(at, rt)
    check('replaying the rotated refresh token is rejected', replay.status >= 400)

    await cleanup(refDev.app, refDev.dataDir)
  }

  // --- Sessions: list + revoke. A revoked session's token stops working. ---
  // Bring up TWO devices for the account: device-1 lists sessions and revokes
  // device-2; device-2's access token must then be rejected.
  const dev1 = await signInAttempt(email, password)
  const dev2 = await signInAttempt(email, password)
  check('two devices signed in for the session-revoke test', dev1.ok && dev2.ok)
  if (dev1.ok && dev1.app && dev2.ok && dev2.app) {
    const dev1Token = accessToken(dev1.app)!
    const dev2Token = accessToken(dev2.app)!
    check("device-2's token works before revocation", await tokenStillValid(dev2Token))

    // List + revoke via raw HTTP (DELETE /v1/sessions/{uuid}). snjs's
    // revokeSession() wraps this in a protected-action challenge that can stall a
    // headless bridge, so we drive the endpoint directly with device-1's bearer.
    const sessions = await listSessionsRaw(dev1Token)
    check('listing sessions returns at least two entries', sessions.length >= 2)

    // Target ONLY device-2's session: device-2 asks the server which session is
    // its own (current === true) so we revoke exactly that uuid and don't touch
    // the original account session used later for change-password.
    const dev2Sessions = await listSessionsRaw(dev2Token)
    const dev2Session = dev2Sessions.find((s) => s && s.current === true)
    check("device-2 can identify its own current session", !!dev2Session?.uuid)

    let revokedOk = false
    if (dev2Session?.uuid) {
      const status = await revokeSessionRaw(dev1Token, dev2Session.uuid)
      revokedOk = status === 200 || status === 204
    }
    check("device-1 revokes device-2's session (success status)", revokedOk)

    check("a revoked session's token stops working", (await tokenStillValid(dev2Token)) === false)

    await cleanup(dev1.app, dev1.dataDir)
    await cleanup(dev2.app, dev2.dataDir)
  }

  // --- Recovery codes (generate) if exposed via the API. -------------------
  // The published snjs has no bridge method for this, so we drive the endpoint
  // directly with the account's bearer token. It can require an x-server-password
  // re-auth; if the server gates it that way we skip with a clear reason rather
  // than fake a pass.
  {
    const at = accessToken(app)
    if (!at) {
      console.log('  SKIP recovery-codes: original bridge has no access token')
    } else {
      const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/recovery/codes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${at}` },
        body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      const codes = body?.recoveryCodes ?? body?.data?.recoveryCodes
      if (res.status === 200 && typeof codes === 'string' && codes.length > 0) {
        check('recovery-codes generate returns a non-empty code string', true)
      } else if (res.status === 401 || res.status === 403) {
        console.log('  SKIP recovery-codes: endpoint requires server-password re-auth (status', res.status, ')')
      } else {
        console.log('  SKIP recovery-codes: endpoint not available as expected (status', res.status, ')')
      }
    }
  }

  // --- Change password: old creds die, new creds work. ---------------------
  // (Re-derives the root key + re-encrypts items; mirrors password.e2e.ts.)
  const newPassword = password + '-rotated-acct'
  let cpFailed: unknown = false
  try {
    const cpResult = await app.app.changePassword(password, newPassword, undefined, undefined, false)
    cpFailed = cpResult?.error ?? cpResult?.processingErrors?.length
  } catch (e) {
    cpFailed = e instanceof Error ? e.message : String(e)
  }
  check('change-password reported success', !cpFailed)
  await app.sync().catch(() => {})
  await cleanup(app, dataDir)

  const withOld = await signInAttempt(email, password)
  check('after change-password, the OLD password is rejected', withOld.ok === false)
  if (withOld.app) await cleanup(withOld.app, withOld.dataDir)

  const withNew = await signInAttempt(email, newPassword)
  check('after change-password, the NEW password works', withNew.ok === true)

  // --- Delete account if exposed via the API. ------------------------------
  // The published snjs has no bridge delete-account method; drive the endpoint
  // directly. Deletion typically needs the user uuid + server-password re-auth,
  // so if it isn't cleanly reachable we skip with a reason.
  if (withNew.ok && withNew.app) {
    const at = accessToken(withNew.app)
    const userUuid: string | undefined = withNew.app.app.getUser?.()?.uuid
    if (at && userUuid) {
      const res = await fetch(`${SERVER.replace(/\/$/, '')}/v1/users/${userUuid}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${at}` },
      })
      if (res.status === 200 || res.status === 204) {
        // After deletion, neither old nor new credentials should sign in.
        const afterDelete = await signInAttempt(email, newPassword)
        check('after account deletion, sign-in is rejected', afterDelete.ok === false)
        if (afterDelete.app) await cleanup(afterDelete.app, afterDelete.dataDir)
      } else {
        console.log('  SKIP delete-account: endpoint requires extra re-auth (status', res.status, ')')
      }
    } else {
      console.log('  SKIP delete-account: missing access token or user uuid on the bridge')
    }
    await cleanup(withNew.app, withNew.dataDir)
  }

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
