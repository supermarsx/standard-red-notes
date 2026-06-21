import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'

// Standard Red Notes — MCP scoped-token credential lifecycle (create -> use ->
// revoke -> dead).
//
// Complements mcptoken.e2e.ts (which proves cross-impl crypto + decryption) by
// focusing on the credential LIFECYCLE over the real gateway HTTP API:
//   1. create an MCP token (authenticated, as the account owner)
//   2. authenticate with it (unauthenticated /authenticate) -> a real session
//   3. it appears in the owner's token list (metadata only)
//   4. revoke it
//   5. re-authenticating with the SAME token now fails (credential is dead)
//
// All reachable without SMTP/browser. The wrapped key material is generated with
// the same algorithm the web client uses (see app/.../McpTokens/wrapKeys.ts) so
// the create request is byte-compatible with a genuine client.

const base = (): string => SERVER.replace(/\/$/, '')

const ITERATIONS = 5
const MEMORY_BYTES = 67108864
const KEY_LENGTH = 32

function accessTokenOf(app: any): string | undefined {
  const session = app.sessions.getSession?.()
  return session?.accessToken?.value ?? session?.accessToken
}

async function wrapItemsKeys(
  itemsKeys: Array<{ uuid: string; itemsKey: string; version: string }>,
  crypto: any,
): Promise<{ wrappedKeys: string; kdfSalt: string; kdfParams: string; wrapSecret: string }> {
  const wrapSecret = crypto.generateRandomKey(256)
  const kdfSalt = crypto.generateRandomKey(128)
  const wrapKey = crypto.argon2(wrapSecret, kdfSalt, ITERATIONS, MEMORY_BYTES, KEY_LENGTH)
  const payload = JSON.stringify({ v: 1, itemsKeys })
  const nonce = crypto.generateRandomKey(192)
  const ciphertext = crypto.xchacha20Encrypt(payload, nonce, wrapKey)
  return {
    wrappedKeys: JSON.stringify({ nonce, ciphertext }),
    kdfSalt,
    kdfParams: JSON.stringify({ alg: 'argon2id', iterations: ITERATIONS, bytes: MEMORY_BYTES, length: KEY_LENGTH }),
    wrapSecret,
  }
}

async function authenticate(authToken: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base()}/v1/mcp-tokens/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: authToken }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function hasSession(r: { status: number; data: any }): boolean {
  const d = r.data?.data ?? r.data
  return r.status === 200 && Boolean(d?.session?.access_token)
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const a = await freshAccount()
  const A = a.app
  const accessToken = accessTokenOf(A.app)
  check('account has a session access token', Boolean(accessToken))

  // The account needs at least one items key to wrap; freshAccount registers and
  // snjs creates a default items key on registration.
  const itemsKeys = A.app.items
    .getDisplayableItemsKeys()
    .map((k: any) => ({ uuid: k.uuid, itemsKey: k.itemsKey, version: k.keyVersion }))
  check('account has at least one items key to wrap', itemsKeys.length > 0)
  if (!accessToken || itemsKeys.length === 0) {
    await cleanup(A, a.dataDir)
    finish()
    return
  }

  const crypto = new SNWebCrypto()
  await crypto.initialize()
  let wrapped
  try {
    wrapped = await wrapItemsKeys(itemsKeys, crypto)
  } finally {
    crypto.deinit()
  }

  // 1. Create the token (authenticated, as the owner).
  const createRes = await fetch(`${base()}/v1/mcp-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      label: 'e2e-revoke',
      scope: 'read',
      wrappedKeys: wrapped.wrappedKeys,
      kdfSalt: wrapped.kdfSalt,
      kdfParams: wrapped.kdfParams,
    }),
  })
  const createBody = (await createRes.json().catch(() => ({}))) as any
  const serverToken: string | undefined = createBody?.data?.token ?? createBody?.token
  check('POST /v1/mcp-tokens returns a server token', createRes.status === 200 && Boolean(serverToken))
  if (!serverToken) {
    console.error('create-token response:', createRes.status, JSON.stringify(createBody))
    await cleanup(A, a.dataDir)
    finish()
    return
  }
  // The auth half is `<tokenUuid>.<authSecret>` (the wrap secret is appended only
  // for the client; /authenticate takes the auth half).
  const authToken = serverToken
  const tokenUuid = serverToken.split('.')[0]

  // 2. Authenticate with the token -> a real session.
  const auth1 = await authenticate(authToken)
  check('authenticating with the fresh token yields a session', hasSession(auth1))

  // 3. The token appears in the owner's list (metadata only, no secret).
  const listRes = await fetch(`${base()}/v1/mcp-tokens/`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const listBody = (await listRes.json().catch(() => ({}))) as any
  const list = (listBody?.data ?? listBody)?.mcpTokens ?? (listBody?.data ?? listBody)?.tokens ?? []
  const listed = Array.isArray(list) ? list.find((t: any) => t.uuid === tokenUuid) : undefined
  check('GET /v1/mcp-tokens lists the created token', Boolean(listed))

  // 4. Revoke it.
  const delRes = await fetch(`${base()}/v1/mcp-tokens/${tokenUuid}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  check('DELETE /v1/mcp-tokens revokes the token (200)', delRes.status === 200)

  // 5. Re-authenticating with the same (now-revoked) token fails.
  const auth2 = await authenticate(authToken)
  check('authenticating with a revoked token fails (no session)', !hasSession(auth2))

  await cleanup(A, a.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
