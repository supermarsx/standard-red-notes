import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Security integration e2e for MAGIC-LINK 2FA (distinct from TOTP). The bridge's
// published snjs has no magic-link client methods (it's a fork/web addition), but
// the feature is enforced SERVER-SIDE, so we drive the endpoints directly. The
// no-SMTP fallback surfaces a one-time code on screen (in the sign-in challenge
// heading); the bridge reads it there to complete 2FA headlessly.

function accessToken(app: HeadlessApp): string | undefined {
  const s = app.app.sessions.getSession?.()
  return s?.accessToken?.value ?? s?.accessToken
}

async function setMagicLink(token: string, enabled: boolean): Promise<number> {
  const res = await fetch(`${SERVER}/v1/mfa/magic-link/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
  })
  await res.text()
  return res.status
}

async function magicLinkEnabled(token: string): Promise<boolean> {
  const res = await fetch(`${SERVER}/v1/mfa/magic-link/status`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await res.json().catch(() => ({}))) as { enabled?: boolean; data?: { enabled?: boolean } }
  return body.enabled ?? body.data?.enabled ?? false
}

async function signInDevice(email: string, password: string): Promise<{ app: HeadlessApp; dataDir: string; ok: boolean; mfaChallenges: number }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-ml-'))
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, syncIntervalMs: 0 })
  let ok = false
  try {
    await app.signIn(email, password)
    ok = app.isSignedIn()
  } catch {
    /* ok stays false */
  }
  return { app, dataDir, ok, mfaChallenges: app.getMfaChallengeCount() }
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, email, password, dataDir } = await freshAccount()
  const client = new SnjsBackedClient(app, { allowWrites: true, baseUrl: SERVER })
  const note = await client.createNote({ title: 'ML note', body: 'guarded by magic-link', tags: [] })
  await app.sync()

  const tokenA = accessToken(app)
  check('bridge has an access token to manage settings', !!tokenA)
  const setStatus = await setMagicLink(tokenA!, true)
  check('enabling magic-link returns success', setStatus === 200)
  check('magic-link status endpoint reports enabled', await magicLinkEnabled(tokenA!))

  // The no-SMTP fallback returns the one-time code in the response body.
  const reqRes = await fetch(`${SERVER}/v1/mfa/magic-link/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const reqBody = (await reqRes.json().catch(() => ({}))) as { code?: string; data?: { code?: string } }
  const onScreen = reqBody.code ?? reqBody.data?.code
  check('magic-link request returns an on-screen code (SMTP fallback)', typeof onScreen === 'string' && /^\d{4,8}$/.test(onScreen ?? ''))
  await cleanup(app, dataDir)

  // Fresh device: the bridge reads the on-screen code from the sign-in challenge
  // heading and completes 2FA. Sign-in must succeed AND go through an MFA gate.
  const dev = await signInDevice(email, password)
  check('magic-link sign-in succeeds via the on-screen code', dev.ok)
  check('sign-in actually went through an MFA challenge (enforced)', dev.mfaChallenges >= 1)
  if (dev.ok) {
    await dev.app.sync()
    const c2 = new SnjsBackedClient(dev.app, { allowWrites: true, baseUrl: SERVER })
    const read = await c2.readNote(note.uuid).catch(() => undefined)
    check('the signed-in device can decrypt the guarded note', read?.body === 'guarded by magic-link')
    await setMagicLink(accessToken(dev.app)!, false)
    check('magic-link status endpoint reports disabled', (await magicLinkEnabled(accessToken(dev.app)!)) === false)
  }
  await cleanup(dev.app, dev.dataDir)

  // With magic-link off, a fresh sign-in is password-only (no MFA challenge).
  const plain = await signInDevice(email, password)
  check('sign-in after disabling needs no MFA challenge', plain.ok && plain.mfaChallenges === 0)
  await cleanup(plain.app, plain.dataDir)

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
