import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { check, cleanup, finish, SERVER, serverUp } from './helpers.js'
import { freshAccount } from './helpers.js'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Standard Red Notes — MCP scoped token end-to-end.
//
// Proves the hardest slice works against the LIVE stack: a token created by
// account A (wrapping A's items keys) lets a SECOND bridge B boot with ONLY the
// token (no email/password), obtain a session, unwrap + inject the items keys,
// and DECRYPT A's note. Also proves read-only scope rejects writes.

// Mirror of app/.../McpTokens/wrapKeys.ts — wrap A's items keys exactly as the
// web client would, so we exercise the real cross-implementation crypto.
const ITERATIONS = 5
const MEMORY_BYTES = 67108864
const KEY_LENGTH = 32

type WrappableItemsKey = { uuid: string; itemsKey: string; version: string }

async function wrapItemsKeys(
  itemsKeys: WrappableItemsKey[],
  crypto: any,
): Promise<{ wrappedKeys: string; kdfSalt: string; kdfParams: string; wrapSecret: string }> {
  const wrapSecret = crypto.generateRandomKey(256)
  const kdfSalt = crypto.generateRandomKey(128)
  const wrapKey = crypto.argon2(wrapSecret, kdfSalt, ITERATIONS, MEMORY_BYTES, KEY_LENGTH)

  const payload = JSON.stringify({ v: 1, itemsKeys })
  const nonce = crypto.generateRandomKey(192)
  const ciphertext = crypto.xchacha20Encrypt(payload, nonce, wrapKey)

  const wrappedKeys = JSON.stringify({ nonce, ciphertext })
  const kdfParams = JSON.stringify({
    alg: 'argon2id',
    iterations: ITERATIONS,
    bytes: MEMORY_BYTES,
    length: KEY_LENGTH,
  })
  return { wrappedKeys, kdfSalt, kdfParams, wrapSecret }
}

async function main(): Promise<void> {
  const up = await serverUp()
  check('server /healthcheck is 200', up)
  if (!up) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // 1. Fresh account A; create a note with known content; sync.
  const a = await freshAccount()
  const A = a.app
  A.startSyncLoop?.()
  const known = `mcp-token-secret-${Date.now()}`
  const ca = new SnjsBackedClient(A, { allowWrites: true, baseUrl: SERVER })
  const createdNote = await ca.createNote({ title: 'MCP token note', body: known, tags: [] })
  check('account A created a note', Boolean(createdNote.uuid))

  // 2. Read A's items keys.
  const itemsKeys: WrappableItemsKey[] = A.app.items
    .getDisplayableItemsKeys()
    .map((k: any) => ({ uuid: k.uuid, itemsKey: k.itemsKey, version: k.keyVersion }))
  check('account A has at least one items key', itemsKeys.length > 0)

  // 3. Wrap A's items keys with the web client's algorithm.
  const crypto = new SNWebCrypto()
  await crypto.initialize()
  let wrapped
  try {
    wrapped = await wrapItemsKeys(itemsKeys, crypto)
  } finally {
    crypto.deinit()
  }

  // Create the token as user A: authed POST /v1/mcp-tokens with A's session
  // bearer token (same as the web client's createMcpToken).
  const accessToken: string | undefined =
    A.app.sessions.getSession()?.accessToken?.value ?? A.app.sessions.getSession()?.accessToken
  check('account A has a session access token', Boolean(accessToken))

  const createRes = await fetch(`${SERVER.replace(/\/$/, '')}/v1/mcp-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      label: 'e2e-bridge',
      scope: 'read',
      wrappedKeys: wrapped.wrappedKeys,
      kdfSalt: wrapped.kdfSalt,
      kdfParams: wrapped.kdfParams,
    }),
  })
  const createBody = (await createRes.json().catch(() => ({}))) as {
    data?: { token?: string; error?: { message?: string } }
    error?: { message?: string }
  }
  const serverToken = createBody?.data?.token
  check(
    'POST /v1/mcp-tokens returned a server token',
    createRes.status === 200 && Boolean(serverToken),
  )
  if (!serverToken) {
    console.error('create-token response:', createRes.status, JSON.stringify(createBody))
    finish()
    return
  }
  const fullToken = `${serverToken}.${wrapped.wrapSecret}`
  check('full token has 3 dot-separated parts', fullToken.split('.').length === 3)

  // 4. Boot bridge B with ONLY the token. No email/password.
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-mcptok-B-'))
  let B: HeadlessApp | undefined
  let bDecrypted = false
  let bReadOnlyRejected = false
  try {
    B = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirB, syncIntervalMs: 0 })
    const result = await B.signInWithToken(fullToken)
    check('bridge B authenticated with token (session layer signed in)', B.app.sessions.isSignedIn() === true)
    check('bridge B scope is read-only', result.readOnly === true)
    check('bridge B injected at least one items key', B.app.items.getDisplayableItemsKeys().length > 0)

    // Sync once more and look for A's note, fully decrypted.
    await B.sync().catch(() => {})
    const note = B.app.items.getDisplayableNotes().find((n: any) => n.uuid === createdNote.uuid)
    check('bridge B can see A note in its store', Boolean(note))
    bDecrypted = Boolean(note) && note.text === known
    check('bridge B DECRYPTED A note content (cross-impl crypto + injection)', bDecrypted)
    if (note && note.text !== known) {
      console.error('  note.text =', JSON.stringify(note.text), 'expected', JSON.stringify(known))
    }

    // 5a. Read-only: the bridge client built with the enforced read-only flag
    //     refuses writes at the tool layer.
    const cb = new SnjsBackedClient(B, { allowWrites: false, baseUrl: SERVER })
    try {
      await cb.createNote({ title: 'should fail', body: 'nope', tags: [] })
      bReadOnlyRejected = false
    } catch {
      bReadOnlyRejected = true
    }
    check('bridge B read-only tool layer rejects a write', bReadOnlyRejected)

    // 5b. Defense in depth: the SERVER session is read-only too. Mutate an item
    //     directly (bypassing the tool layer) and sync; the read-only session
    //     must NOT persist it. Verify by re-reading the note from a separate
    //     password-backed sync as A and confirming the edit did not land.
    const editMarker = `readonly-violation-${Date.now()}`
    const targetNote = B.app.items.getDisplayableNotes().find((n: any) => n.uuid === createdNote.uuid)
    let serverRejectedWrite = false
    if (targetNote) {
      try {
        await B.app.mutator.changeItem(targetNote, (m: any) => {
          m.text = editMarker
        })
        await B.app.sync.sync({ sourceDescription: 'mcp-readonly-probe' })
      } catch {
        serverRejectedWrite = true
      }
      // Confirm via A (authoritative server copy) that the edit did not persist.
      await A.sync().catch(() => {})
      const aNote = A.app.items.getDisplayableNotes().find((n: any) => n.uuid === createdNote.uuid)
      const persisted = aNote?.text === editMarker
      check('read-only session did NOT persist a direct write to the server', persisted === false)
    } else {
      check('read-only session did NOT persist a direct write to the server', false)
    }
    void serverRejectedWrite
  } finally {
    if (B) {
      await B.deinit().catch(() => {})
    }
    await fs.rm(dirB, { recursive: true, force: true }).catch(() => {})
  }

  await cleanup(A, a.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
