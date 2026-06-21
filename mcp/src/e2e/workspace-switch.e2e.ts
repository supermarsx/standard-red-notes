import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Standard Red Notes — "switch workspace" (WORKSPACES_PER_EMAIL_ENABLED).
//
// Companion to workspaces.e2e.ts. That spec proves the RAW register/sign-in HTTP
// surface resolves accounts by (email, workspace_identifier) and that the uuids
// differ. THIS spec proves the higher-level "switch workspace" guarantee through
// the real snjs bridge end to end: signing the SAME email into workspace A vs B
// lands on two INDEPENDENT data stores — a note created in A is invisible in B and
// vice-versa — which is exactly what switching workspaces must mean for a user.
//
// ## Bridge note
// bootstrapHeadlessApp().signIn() doesn't forward the workspace identifier, but the
// underlying snjs Application.signIn() takes it as a trailing optional argument, so
// we call app.app.signIn(...) directly with the workspace. Registration of the
// extra workspace is done via the raw /v1/users endpoint (the bridge's register()
// also doesn't forward the workspace), deriving faithful key params with snjs's own
// encryption service — identical to the approach in workspaces.e2e.ts.
//
// ## Gating
// No public endpoint reports the flag, so it's detected BEHAVIOURALLY: registering
// the same email under a SECOND workspace succeeds only when the flag is ON. When
// OFF the server rejects it as a duplicate email and the suite SKIPS with a clear
// message instead of failing.

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

async function rawRegister(body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base()}/v1/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-snjs-version': '2.211.6' },
    // The register endpoint reads request.body.api (NOT api_version); send both
    // for safety. `version` (protocol version) is carried in the portable params.
    body: JSON.stringify({ api: '20240226', api_version: '20240226', ephemeral: false, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

/** Unauthenticated key-params probe for (email, workspace). Returns parsed body + status. */
async function keyParams(
  email: string,
  workspaceIdentifier?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base()}/v2/login-params`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_version: '20240226',
      email,
      code_challenge: 'srn-e2e-ws-probe-challenge',
      ...(workspaceIdentifier ? { workspace_identifier: workspaceIdentifier } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

/**
 * Sign the SAME email into a SPECIFIC workspace through the real snjs bridge.
 * Calls Application.signIn() directly so we can pass the workspace identifier
 * (the bridge wrapper omits it). Returns the live bridge so the caller can read
 * and write items in that workspace's store.
 */
async function bridgeSignIn(
  email: string,
  password: string,
  workspaceIdentifier?: string,
): Promise<{ ok: boolean; app: HeadlessApp; dataDir: string; userUuid?: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-wsswitch-'))
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, syncIntervalMs: 0 })
  let ok = false
  let userUuid: string | undefined
  try {
    // Application.signIn(email, password, strict, ephemeral, mergeLocal, awaitSync, hvmToken, workspaceIdentifier)
    const response = await app.app.signIn(email, password, false, false, true, true, undefined, workspaceIdentifier)
    const error = response?.data?.error ?? response?.error
    ok = !error && app.isSignedIn()
    userUuid = app.app.getUser?.()?.uuid
  } catch {
    /* ok stays false */
  }
  return { ok, app, dataDir, userUuid }
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Account in the DEFAULT workspace (= "workspace A") via the real bridge. Its
  // encryption service derives faithful key params to register a second workspace.
  const a = await freshAccount()
  const email = a.email
  const password = a.password
  const wsB = 'switch-b-' + Date.now()
  const reg = await deriveRegistration(a.app.app, email, password)

  // Flag probe: register the SAME email under a SECOND workspace. Only the flag
  // being ON lets this succeed; OFF => duplicate-email rejection => SKIP.
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
  check('the SAME email registered under two different workspaces (A=default, B) — both succeed', flagOn)

  // Sign the same email into workspace A (default) and workspace B via the bridge.
  // Account A's note is created on its own bridge (already signed in from register).
  const clientA = new SnjsBackedClient(a.app, { allowWrites: true, baseUrl: SERVER })
  const noteA = await clientA.createNote({ title: 'A-only', body: 'lives in workspace A', tags: ['wsA'] })
  await a.app.sync().catch(() => {})

  const devB = await bridgeSignIn(email, password, wsB)
  check('sign-in to workspace B with the same email succeeds (switch workspace)', devB.ok)

  if (devB.ok) {
    // Each workspace resolves to its OWN account (distinct user uuid).
    const uuidA = a.app.app.getUser?.()?.uuid
    check(
      'workspace A and workspace B resolve to distinct user accounts (different uuids)',
      Boolean(uuidA) && Boolean(devB.userUuid) && uuidA !== devB.userUuid,
    )

    await devB.app.sync().catch(() => {})
    const clientB = new SnjsBackedClient(devB.app, { allowWrites: true, baseUrl: SERVER })

    // Switch proof #1: A's note must NOT appear in workspace B.
    const listInB = await clientB.listNotes(50)
    check(
      "workspace A's note is invisible in workspace B (independent data store)",
      !listInB.notes.some((n) => n.uuid === noteA.uuid),
    )

    // Create a note in B; it must NOT bleed back into workspace A.
    const noteB = await clientB.createNote({ title: 'B-only', body: 'lives in workspace B', tags: ['wsB'] })
    await devB.app.sync().catch(() => {})
    await a.app.sync().catch(() => {})
    const listInA = await clientA.listNotes(50)
    check(
      "workspace B's note is invisible in workspace A (independent data store)",
      !listInA.notes.some((n) => n.uuid === noteB.uuid),
    )
    check("workspace A still sees its own note after the switch", listInA.notes.some((n) => n.uuid === noteA.uuid))

    await cleanup(devB.app, devB.dataDir)
  }

  // Enumeration parity: a NON-EXISTENT (email, workspace) pair must look exactly
  // like a registered one to an unauthenticated probe — same status, pseudo params,
  // no 404 — so workspaces can't be enumerated.
  const knownKp = await keyParams(email, wsB)
  const ghostKp = await keyParams(email, 'never-registered-' + Date.now())
  check('key-params for a KNOWN (email, workspace) returns 200', knownKp.status === 200)
  check('key-params for an UNKNOWN (email, workspace) ALSO returns 200 (pseudo params, no 404)', ghostKp.status === 200)
  check(
    'a non-existent (email, workspace) is indistinguishable by status (enumeration parity)',
    knownKp.status === ghostKp.status,
  )

  await cleanup(a.app, a.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
