import { createHmac } from 'node:crypto'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'

// Standard Red Notes — App-specific passwords.
//
// An app password is a per-account secret that satisfies the interactive 2FA
// challenge for a single sign-in (the account password is still required), so a
// headless client never needs a live TOTP code. This e2e exercises the full
// server lifecycle over the real gateway HTTP surface:
//   1. create -> the plaintext secret is returned exactly once
//   2. list   -> metadata only, never the secret again
//   3. use    -> with TOTP 2FA enabled, presenting the app password as
//                `app_password` to /v2/login-params satisfies the 2FA gate and
//                returns the account's real key params (a 401 mfa-required
//                otherwise)
//   4. revoke -> the same app password no longer satisfies the gate (401)
//
// The MFA "use" path is driven via raw HTTP because the real client carries the
// app password in the dedicated `app_password` field of the login-params body
// (the MCP bridge's snjs only forwards a TOTP-style `mfa_code`). The server
// password is derived faithfully with snjs's own crypto so requests are
// byte-compatible with a genuine client.

const base = (): string => SERVER.replace(/\/$/, '')

function base32Decode(b32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of b32.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(c)
    if (idx === -1) continue
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s step). */
function totp(secret: string, atMs = Date.now()): string {
  const key = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  msg.writeUInt32BE(counter >>> 0, 4)
  const hmac = createHmac('sha1', key).update(msg).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (bin % 1_000_000).toString().padStart(6, '0')
}

function accessTokenOf(app: any): string | undefined {
  const session = app.sessions.getSession?.()
  return session?.accessToken?.value ?? session?.accessToken
}

/**
 * Fetch key params, optionally presenting an app password. With 2FA enabled, a
 * satisfied gate returns 200 with real key params (identifier/pw_nonce present);
 * an unsatisfied gate returns 401 with an mfa-required error.
 */
async function keyParamsWithAppPassword(
  email: string,
  appPassword: string | undefined,
): Promise<{ status: number; satisfied: boolean; data: any }> {
  const { SNWebCrypto } = (await import('@standardnotes/sncrypto-web')) as unknown as {
    SNWebCrypto: new () => any
  }
  const crypto = new SNWebCrypto()
  await crypto.initialize()
  try {
    const codeVerifier = crypto.generateRandomKey(256)
    const codeChallenge = crypto.base64URLEncode(await crypto.sha256(codeVerifier))
    const res = await fetch(`${base()}/v2/login-params`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_version: '20240226',
        email,
        code_challenge: codeChallenge,
        ...(appPassword ? { app_password: appPassword } : {}),
      }),
    })
    const data = await res.json().catch(() => ({}))
    const params = data?.data ?? data
    // A 200 with a real pw_nonce means the gate was satisfied and the account's
    // genuine key params were returned (a pseudo/MFA-blocked response is a 401).
    const satisfied = res.status === 200 && typeof params?.pw_nonce === 'string'
    return { status: res.status, satisfied, data }
  } finally {
    crypto.deinit()
  }
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, email, dataDir } = await freshAccount()
  const accessToken = accessTokenOf(app.app)
  check('account has a session access token', Boolean(accessToken))

  // 1. Create an app password — the plaintext secret is returned exactly once.
  const createRes = await fetch(`${base()}/v1/app-passwords/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ label: 'e2e-headless' }),
  })
  const createBody = (await createRes.json().catch(() => ({}))) as any
  const created = createBody?.data ?? createBody
  const appPasswordSecret: string | undefined = created?.password
  const appPasswordUuid: string | undefined = created?.appPassword?.uuid
  check(
    'POST /v1/app-passwords returns the plaintext secret once',
    createRes.status === 200 && Boolean(appPasswordSecret),
  )
  check('POST /v1/app-passwords returns the app password uuid', Boolean(appPasswordUuid))

  // 2. List — metadata only; the secret is never returned again.
  const listRes = await fetch(`${base()}/v1/app-passwords/`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const listBody = (await listRes.json().catch(() => ({}))) as any
  const list = (listBody?.data ?? listBody)?.appPasswords ?? []
  const listedEntry = Array.isArray(list) ? list.find((e: any) => e.uuid === appPasswordUuid) : undefined
  check('GET /v1/app-passwords lists the created app password', Boolean(listedEntry))
  check(
    'listed app password never re-exposes the plaintext secret',
    Boolean(listedEntry) && listedEntry.password === undefined,
  )

  if (!appPasswordSecret || !appPasswordUuid) {
    await cleanup(app, dataDir)
    finish()
    return
  }

  // Enable TOTP 2FA so the app password actually has a 2FA gate to satisfy.
  const secret: string = await app.app.mfa.generateMfaSecret()
  await app.app.mfa.enableMfa(secret, totp(secret))
  const mfaActive = await app.app.mfa.isMfaActivated()
  check('TOTP 2FA enabled on the account (gate for the app password)', mfaActive === true)

  // Sanity: with 2FA on, key params WITHOUT any second factor are gated (not the
  // real params). (A pseudo/blocked response never carries the real pw_nonce.)
  const noFactor = await keyParamsWithAppPassword(email, undefined)
  check('with 2FA on, key params without a second factor are gated', noFactor.satisfied === false)

  // 3. Present the app password — the 2FA gate is satisfied and the account's
  //    REAL key params come back.
  const withAppPw = await keyParamsWithAppPassword(email, appPasswordSecret)
  check('a valid app password satisfies the 2FA gate (real key params returned)', withAppPw.satisfied === true)

  // A wrong app password does NOT satisfy the gate (fail-closed).
  const wrongAppPw = await keyParamsWithAppPassword(email, appPasswordSecret + 'x')
  check('a wrong app password does not satisfy the 2FA gate', wrongAppPw.satisfied === false)

  // 4. Revoke the app password; it must stop satisfying the gate.
  const delRes = await fetch(`${base()}/v1/app-passwords/${appPasswordUuid}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  check('DELETE /v1/app-passwords revokes the app password', delRes.status === 200)

  const afterRevoke = await keyParamsWithAppPassword(email, appPasswordSecret)
  check('a revoked app password no longer satisfies the 2FA gate', afterRevoke.satisfied === false)

  // The revoked app password is gone from the list.
  const listAfter = await fetch(`${base()}/v1/app-passwords/`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const listAfterBody = (await listAfter.json().catch(() => ({}))) as any
  const remaining = (listAfterBody?.data ?? listAfterBody)?.appPasswords ?? []
  check(
    'the revoked app password no longer appears in the list',
    Array.isArray(remaining) && !remaining.some((e: any) => e.uuid === appPasswordUuid),
  )

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
