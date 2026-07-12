import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp, skip } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// 004-ON-THE-WIRE: the node replacement for the mocha `004`/`keys` suites that
// need a live server. Proves that a note created + synced is stored as 004
// ciphertext (never plaintext) both at rest on disk AND on the server, that a
// fresh client with the RIGHT password decrypts it back to the original, and
// that a WRONG-password sign-in fails cleanly without leaking the body or
// touching the ciphertext.

const PLAINTEXT_TITLE = 'WireTitle-UNIQ-marker-9f3a'
const PLAINTEXT_BODY = 'PLAINTEXT-SECRET-BODY-must-never-appear-on-the-wire-4242'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readDbPayloads(dataDir: string): Promise<any[]> {
  const raw = await fs.readFile(path.join(dataDir, 'db.json'), 'utf8')
  return Object.values(JSON.parse(raw) as Record<string, any>)
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const appA = A.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const created = await clientA.createNote({ title: PLAINTEXT_TITLE, body: PLAINTEXT_BODY, tags: [] })
  await A.app.sync()

  // ---- 1. AT REST: the persisted note payload is 004 ciphertext, never plaintext ----
  const payloads = await readDbPayloads(A.dataDir)
  const notePayload = payloads.find((p) => p.uuid === created.uuid)
  check('note payload is persisted locally', !!notePayload)
  check(
    'persisted note content is 004 ciphertext (004: prefix)',
    typeof notePayload?.content === 'string' && notePayload.content.startsWith('004:'),
  )
  check(
    'persisted enc_item_key is 004 ciphertext (004: prefix)',
    typeof notePayload?.enc_item_key === 'string' && notePayload.enc_item_key.startsWith('004:'),
  )
  const localBlob = JSON.stringify(payloads)
  check('plaintext BODY does not appear anywhere in the local db', !localBlob.includes(PLAINTEXT_BODY))
  check('plaintext TITLE does not appear anywhere in the local db', !localBlob.includes(PLAINTEXT_TITLE))
  const itemsKeyPayload = payloads.find((p) => String(p.content_type).includes('ItemsKey'))
  check('an items key is persisted locally', !!itemsKeyPayload)
  check(
    'the items key itself is root-key-encrypted (004: enc_item_key)',
    typeof itemsKeyPayload?.enc_item_key === 'string' && itemsKeyPayload.enc_item_key.startsWith('004:'),
  )

  // ---- 2. ON THE WIRE: read the raw server copy straight off /v1/items ----
  const session = appA.sessions.getSession?.()
  const token = session?.accessToken?.value
  if (!token) {
    skip('on-the-wire server fetch', 'no session access token available')
  } else {
    const res = await fetch(`${SERVER}/v1/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [], limit: 150 }),
    })
    const body: any = await res.json().catch(() => ({}))
    const retrieved: any[] = body?.retrieved_items ?? body?.data?.retrieved_items ?? []
    const serverNote = retrieved.find((i) => i.uuid === created.uuid)
    check('server returned the note in a raw sync download', !!serverNote)
    check(
      'server-stored note content is 004 ciphertext (not plaintext)',
      typeof serverNote?.content === 'string' && serverNote.content.startsWith('004:'),
    )
    const wireBlob = JSON.stringify(retrieved)
    check('plaintext BODY does not appear in any server payload', !wireBlob.includes(PLAINTEXT_BODY))
    check('plaintext TITLE does not appear in any server payload', !wireBlob.includes(PLAINTEXT_TITLE))
  }

  // ---- 3. RIGHT password on a fresh device DECRYPTS back to the original ----
  const dirGood = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-wire-good-'))
  const good = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirGood, password: A.password, syncIntervalMs: 0 })
  await good.signIn(A.email, A.password)
  await good.sync()
  await sleep(200)
  await good.sync()
  const goodNote = good.app.items.getDisplayableNotes().find((n: any) => n.uuid === created.uuid)
  check('fresh device with the correct password sees the note', !!goodNote)
  check('decrypted title matches the original', goodNote?.title === PLAINTEXT_TITLE)
  check('decrypted body matches the original', goodNote?.text === PLAINTEXT_BODY)
  check('no item is left errorDecrypting on the good device', (good.app.items.invalidItems ?? []).length === 0)

  // ---- 4. WRONG password sign-in fails cleanly (no session, no leak) ----
  const dirBad = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-wire-bad-'))
  const bad = await bootstrapHeadlessApp({
    serverUrl: SERVER,
    dataDir: dirBad,
    password: 'the-wrong-password-zzz',
    syncIntervalMs: 0,
  })
  let threw = false
  let errMsg = ''
  try {
    await bad.signIn(A.email, 'the-wrong-password-zzz')
  } catch (e) {
    threw = true
    errMsg = e instanceof Error ? e.message : String(e)
  }
  check('wrong-password sign-in fails (throws a clear error)', threw)
  check('wrong-password device is NOT signed in', !bad.isSignedIn())
  check('no notes are present on the failed-auth device (no partial leak)', bad.app.items.getDisplayableNotes().length === 0)
  console.log('    wrong-password error:', errMsg.slice(0, 140))

  // ---- 5. The ciphertext is untouched: the good device still decrypts it ----
  await good.sync()
  const goodNote2 = good.app.items.getDisplayableNotes().find((n: any) => n.uuid === created.uuid)
  check('note still intact + decryptable after the failed-auth attempt', goodNote2?.text === PLAINTEXT_BODY)

  await cleanup(bad, dirBad)
  await cleanup(good, dirGood)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
