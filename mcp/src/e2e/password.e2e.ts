import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Security/data-integrity integration e2e for changing the account password:
// the root key is re-derived and every item is re-encrypted, so a fresh device
// must decrypt all notes with the NEW password while the OLD password is dead.

async function trySignIn(email: string, password: string): Promise<{ ok: boolean; app?: Awaited<ReturnType<typeof bootstrapHeadlessApp>>; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-pw-'))
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, syncIntervalMs: 0 })
  try {
    await app.signIn(email, password)
    return { ok: app.isSignedIn(), app, dataDir }
  } catch {
    await app.deinit().catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true })
    return { ok: false, dataDir }
  }
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, email, password, dataDir } = await freshAccount()
  const client = new SnjsBackedClient(app, { allowWrites: true, baseUrl: SERVER })
  const note = await client.createNote({ title: 'Pre-change note', body: 'encrypted under the old key', tags: ['secret'] })
  await app.sync()

  // Change the password (re-wraps the root key and re-encrypts all items).
  const newPassword = password + '-rotated-9000'
  const result = await app.app.changePassword(password, newPassword, undefined, undefined, false)
  const failed = result?.error ?? result?.processingErrors?.length
  check('password change reported success', !failed)
  await app.sync()
  await cleanup(app, dataDir)

  // Fresh device with the NEW password must sign in and decrypt the old note.
  const withNew = await trySignIn(email, newPassword)
  check('sign-in with the new password succeeds', withNew.ok)
  if (withNew.ok && withNew.app) {
    await withNew.app.sync()
    const c2 = new SnjsBackedClient(withNew.app, { allowWrites: true, baseUrl: SERVER })
    const list = await c2.listNotes(50)
    const found = list.notes.find((n) => n.uuid === note.uuid)
    check('the pre-change note is present after re-key', !!found)
    if (found) {
      const read = await c2.readNote(note.uuid)
      check('the pre-change note still decrypts to its original body', read.body === 'encrypted under the old key' && read.tags.includes('secret'))
    }
    await cleanup(withNew.app, withNew.dataDir)
  }

  // Fresh device with the OLD password must be rejected.
  const withOld = await trySignIn(email, password)
  check('sign-in with the old password is rejected', withOld.ok === false)
  if (withOld.ok && withOld.app) {
    await cleanup(withOld.app, withOld.dataDir)
  }

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
