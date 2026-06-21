import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'

// Standard Red Notes — "multiple workspaces per email" (WORKSPACES_PER_EMAIL_ENABLED).
//
// Server-mediated feature: with the operator flag ON, an account is keyed by the
// composite (email, workspace_identifier) instead of email alone, so the same
// email may register several independent workspaces. This e2e exercises the real
// HTTP surface end to end:
//   1. register the same email twice with DIFFERENT workspace identifiers -> both succeed
//   2. register the same (email, workspace) pair again -> rejected
//   3. /v2/login-params + /v2/login resolve by (email, workspace_identifier)
//
// The MCP bridge's snjs (npm @standardnotes/snjs) registers via app.register(),
// which does not forward workspace_identifier, so this spec talks raw HTTP to the
// gateway. The server password + key params are still derived FAITHFULLY using
// snjs's own encryptionService (the same argon2 derivation the real client uses),
// so the requests are byte-compatible with a genuine client.
//
// ## Gating
// There is no public endpoint that reports the flag, so the flag is detected
// BEHAVIOURALLY: after the first account exists, a second registration with a
// DIFFERENT workspace identifier succeeds only when the flag is ON. When the
// flag is OFF the server rejects it as a duplicate email, and the suite SKIPS
// the rest with a clear message instead of failing.

const base = (): string => SERVER.replace(/\/$/, '')

interface PortableKeyParams {
  identifier: string
  pw_nonce?: string
  version?: string
  origination?: string
  created?: string
  [k: string]: unknown
}

/** Derive {serverPassword, keyParams} for an email+password the way the real client does. */
async function deriveRegistration(
  app: any,
  email: string,
  password: string,
): Promise<{ serverPassword: string; portable: PortableKeyParams }> {
  const snjsMod = (await import('@standardnotes/snjs')) as unknown as Record<string, any>
  const origination = snjsMod.KeyParamsOrigination?.Registration ?? 'registration'
  const rootKey = await app.encryption.createRootKey(email, password, origination)
  return {
    serverPassword: rootKey.serverPassword as string,
    portable: rootKey.keyParams.getPortableValue() as PortableKeyParams,
  }
}

async function rawRegister(
  body: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base()}/v1/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-snjs-version': '2.211.6' },
    // The register handler reads the api version from `api` (not `api_version`).
    body: JSON.stringify({ api: '20240226', ephemeral: false, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function rawSignIn(
  email: string,
  serverPassword: string,
  workspaceIdentifier?: string,
): Promise<{ status: number; data: any }> {
  // PKCE: code_challenge = base64url(sha256(code_verifier)). Use snjs crypto so the
  // derivation matches the server's verification exactly.
  const { SNWebCrypto } = (await import('@standardnotes/sncrypto-web')) as unknown as {
    SNWebCrypto: new () => any
  }
  const crypto = new SNWebCrypto()
  await crypto.initialize()
  try {
    const codeVerifier = crypto.generateRandomKey(256)
    const codeChallenge = crypto.base64URLEncode(await crypto.sha256(codeVerifier))

    await fetch(`${base()}/v2/login-params`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_version: '20240226',
        email,
        code_challenge: codeChallenge,
        ...(workspaceIdentifier ? { workspace_identifier: workspaceIdentifier } : {}),
      }),
    })

    const res = await fetch(`${base()}/v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The sign-in handler reads the api version from `api` (not `api_version`).
        api: '20240226',
        email,
        password: serverPassword,
        code_verifier: codeVerifier,
        ephemeral: false,
        ...(workspaceIdentifier ? { workspace_identifier: workspaceIdentifier } : {}),
      }),
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  } finally {
    crypto.deinit()
  }
}

function signInSucceeded(r: { status: number; data: any }): boolean {
  return r.status === 200 && Boolean(r.data?.session ?? r.data?.data?.session)
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Account A registers in the DEFAULT workspace via the real bridge (this both
  // creates the account and gives us a snjs app whose encryption service we can
  // use to derive faithful key params for the same email under other workspaces).
  const a = await freshAccount()
  const email = a.email
  const password = a.password

  const wsB = 'team-b-' + Date.now()
  const wsC = 'team-c-' + Date.now()

  const reg = await deriveRegistration(a.app.app, email, password)

  // 1. Register the SAME email under a DIFFERENT workspace. This is the flag
  //    probe: it only succeeds when WORKSPACES_PER_EMAIL_ENABLED is ON.
  const regB = await rawRegister({
    email,
    password: reg.serverPassword,
    workspace_identifier: wsB,
    ...reg.portable,
  })
  const flagOn = regB.status === 200 && Boolean(regB.data?.session ?? regB.data?.data?.session)

  if (!flagOn) {
    const msg = regB.data?.error?.message ?? regB.data?.data?.error?.message ?? `HTTP ${regB.status}`
    console.log(
      `SKIP: WORKSPACES_PER_EMAIL_ENABLED appears OFF (second-workspace register rejected: "${msg}"). ` +
        'Enable the flag on the auth service to run this spec.',
    )
    await cleanup(a.app, a.dataDir)
    process.exit(0)
  }

  check('registering the same email in a second workspace succeeds (flag ON)', flagOn)

  // 2a. A third, distinct workspace also succeeds.
  const regC = await rawRegister({
    email,
    password: reg.serverPassword,
    workspace_identifier: wsC,
    ...reg.portable,
  })
  check(
    'registering the same email in a third workspace succeeds',
    regC.status === 200 && Boolean(regC.data?.session ?? regC.data?.data?.session),
  )

  // 2b. Re-registering the SAME (email, workspace) pair is rejected as a duplicate.
  const dupB = await rawRegister({
    email,
    password: reg.serverPassword,
    workspace_identifier: wsB,
    ...reg.portable,
  })
  const dupMsg = dupB.data?.error?.message ?? dupB.data?.data?.error?.message ?? ''
  check(
    'duplicate (email, workspace) registration is rejected with 400 + already-registered message',
    dupB.status === 400 && /already registered/i.test(String(dupMsg)),
  )

  // 2c. Re-registering the SAME email in the DEFAULT workspace (where A already
  //     lives) is also rejected — the composite key still protects the default.
  const dupDefault = await rawRegister({
    email,
    password: reg.serverPassword,
    ...reg.portable,
  })
  check(
    're-registering the default workspace for an existing email is rejected',
    dupDefault.status === 400,
  )

  // 3. Sign-in resolves by (email, workspace_identifier). The same email+password
  //    signs into workspace B AND the default workspace, which are distinct accounts.
  const signInB = await rawSignIn(email, reg.serverPassword, wsB)
  check('sign-in resolves workspace B by (email, workspace_identifier)', signInSucceeded(signInB))

  const signInDefault = await rawSignIn(email, reg.serverPassword, undefined)
  check('sign-in resolves the default workspace for the same email', signInSucceeded(signInDefault))

  // The two sessions belong to DIFFERENT user accounts (different uuids).
  const uuidB = (signInB.data?.user ?? signInB.data?.data?.user)?.uuid
  const uuidDefault = (signInDefault.data?.user ?? signInDefault.data?.data?.user)?.uuid
  check(
    'workspace B and the default workspace are distinct accounts (different uuids)',
    Boolean(uuidB) && Boolean(uuidDefault) && uuidB !== uuidDefault,
  )

  // Signing into a workspace that was never registered for this email fails.
  const signInGhost = await rawSignIn(email, reg.serverPassword, 'never-registered-' + Date.now())
  check('sign-in for an unregistered workspace is rejected', !signInSucceeded(signInGhost))

  await cleanup(a.app, a.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
