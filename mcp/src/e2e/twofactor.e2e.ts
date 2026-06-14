import { createHmac } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'

// Security integration e2e: enabling TOTP 2FA on an account and proving the
// sign-in gate works end to end — sign-in without a code is rejected, a wrong
// code is rejected, and the correct time-based code succeeds.

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

// The headless bridge answers the server's MFA challenge with the `mfaCode` set
// at bootstrap time (see bootstrap.ts receiveChallenge). So a sign-in attempt is
// a fresh app bootstrapped with the candidate code; undefined => no code given.
async function signInAttempt(
  email: string,
  password: string,
  mfaCode: string | undefined,
): Promise<{ ok: boolean; err?: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-2fa-'))
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, mfaCode, syncIntervalMs: 0 })
  try {
    await app.signIn(email, password)
    return { ok: app.isSignedIn() }
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) }
  } finally {
    await app.deinit().catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, email, password, dataDir } = await freshAccount()

  // Enable TOTP 2FA with a freshly generated secret + current code, and confirm
  // the server records it as active.
  const secret: string = await app.app.mfa.generateMfaSecret()
  check('account generated a TOTP secret', typeof secret === 'string' && secret.length > 0)
  await app.app.mfa.enableMfa(secret, totp(secret))
  const active = await app.app.mfa.isMfaActivated()
  check('2FA is activated on the account', active === true)
  await cleanup(app, dataDir)

  // Fresh device, no code -> rejected (password alone is not enough).
  const noCode = await signInAttempt(email, password, undefined)
  check('sign-in without a 2FA code is rejected', noCode.ok === false)

  // Fresh device, wrong code -> rejected.
  const wrong = await signInAttempt(email, password, '000000')
  check('sign-in with a wrong 2FA code is rejected', wrong.ok === false)

  // Fresh device, correct current TOTP -> succeeds.
  const good = await signInAttempt(email, password, totp(secret))
  if (!good.ok) console.log('  (correct-code sign-in error:', good.err, ')')
  check('sign-in with the correct TOTP code succeeds', good.ok === true)

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
