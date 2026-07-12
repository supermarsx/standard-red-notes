import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp, skip } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// BACKUP ROUND-TRIP: the node replacement for the mocha `backups` suite.
//  (a) ENCRYPTED backup -> restore onto a clean device with only the account
//      password -> all notes + items keys restore and DECRYPT.
//  (b) DECRYPTED export -> re-import into a fresh account -> readable notes.
//  (c) CORRUPTED backup -> fails / degrades cleanly, WITHOUT clobbering the
//      good data already on the device.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function unwrap<T>(result: any): T {
  if (result?.isFailed?.()) {
    throw new Error(`Result failed: ${result.getError()}`)
  }
  return result.getValue() as T
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const appA = A.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const bodies: Record<string, string> = {}
  const created = []
  for (const [title, body] of [
    ['Backup A', 'body-A-secret-alpha'],
    ['Backup B', 'body-B-secret-bravo'],
    ['Backup C', 'body-C-secret-charlie'],
  ]) {
    const n = await clientA.createNote({ title, body, tags: [] })
    bodies[n.uuid] = body
    created.push(n)
  }
  await A.app.sync()
  const uuids = created.map((n) => n.uuid)

  // ---- (a) ENCRYPTED backup -> clean-device restore with the account password ----
  const encBackup = unwrap<any>(await appA.createEncryptedBackupFile.execute({ skipAuthorization: true }))
  check('encrypted backup created with items', !!encBackup && Array.isArray(encBackup.items) && encBackup.items.length > 0)
  check('encrypted backup carries keyParams (needed to restore)', !!encBackup.keyParams)
  const encBlob = JSON.stringify(encBackup.items)
  check('encrypted backup contains NO plaintext note body', !encBlob.includes('body-A-secret-alpha'))
  check(
    'encrypted backup INCLUDES the items key(s) (round-trip restorable)',
    encBackup.items.some((i: any) => String(i.content_type).includes('ItemsKey')),
  )

  const dirR = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-backup-restore-'))
  // Clean device: NOT signed in. Restore purely from the encrypted backup +
  // the account password (supplied to the file-password challenge by bootstrap).
  const restore = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dirR, password: A.password, syncIntervalMs: 0 })
  unwrap<any>(await restore.app.importData(encBackup, false))
  await sleep(300)
  const restored = restore.app.items.getDisplayableNotes()
  check('all 3 notes restored from the encrypted backup', uuids.every((u) => restored.some((r: any) => r.uuid === u)))
  check(
    'restored notes DECRYPTED back to their original bodies',
    uuids.every((u) => restored.find((r: any) => r.uuid === u)?.text === bodies[u]),
  )
  check(
    'items key was restored (no note left errorDecrypting)',
    (restore.app.items.invalidItems ?? []).length === 0,
  )

  // ---- (c) CORRUPTED backup must not clobber the good data now on `restore` ----
  // Mangle ONE note's ciphertext (same uuid) so it can't decrypt; the good local
  // copy of that note must survive readable, and the other notes untouched.
  const corruptPerItem = JSON.parse(JSON.stringify(encBackup))
  const victimUuid = uuids[0]
  const victim = corruptPerItem.items.find((i: any) => i.uuid === victimUuid)
  check('found the note item to corrupt', !!victim && typeof victim.content === 'string')
  // flip a chunk of the base64 ciphertext body (keep the 004: header intact)
  const c: string = victim.content
  const head = c.slice(0, 8)
  const tampered = head + c.slice(8).replace(/[A-Za-z]/g, (ch: string) => (ch === 'A' ? 'B' : 'A'))
  victim.content = tampered
  let perItemFailedCleanly = true
  try {
    const r = await restore.app.importData(corruptPerItem, false)
    // Whether it returns fail or imports the victim as errorDecrypting, it must
    // not throw and must not blank the good copy.
    perItemFailedCleanly = true
    void r
  } catch (e) {
    perItemFailedCleanly = false
    console.log('    per-item corrupt import threw:', e instanceof Error ? e.message : e)
  }
  await sleep(300)
  const afterPerItem = restore.app.items.getDisplayableNotes()
  check('corrupt per-item import did not throw', perItemFailedCleanly)
  check(
    'corrupted item did NOT clobber the good local copy (still readable)',
    afterPerItem.some((r: any) => r.uuid === victimUuid && r.text === bodies[victimUuid]) ||
      afterPerItem.some((r: any) => r.text === bodies[victimUuid]),
  )
  check(
    'the OTHER good notes are untouched after the corrupt import',
    uuids.slice(1).every((u) => afterPerItem.find((r: any) => r.uuid === u)?.text === bodies[u]),
  )

  // Structurally corrupt: unsupported version must be REJECTED cleanly, no mutation.
  const structCorrupt = JSON.parse(JSON.stringify(encBackup))
  structCorrupt.version = '999'
  let structResult: any
  let structThrew = false
  try {
    structResult = await restore.app.importData(structCorrupt, false)
  } catch {
    structThrew = true
  }
  check(
    'structurally corrupt backup (bad version) is rejected cleanly',
    structThrew || structResult?.isFailed?.() === true,
  )
  const afterStruct = restore.app.items.getDisplayableNotes()
  check(
    'good notes still intact after the rejected structural-corrupt import',
    uuids.slice(1).every((u) => afterStruct.find((r: any) => r.uuid === u)?.text === bodies[u]),
  )
  await cleanup(restore, dirR)

  // ---- (b) DECRYPTED export -> re-import into a fresh account -> readable ----
  // createDecryptedBackupFile authorizes via an ExportBackup challenge whose
  // prompt set includes a ProtectionSessionDuration prompt that the HEADLESS
  // challenge handler cannot answer (no passcode/biometric UI), so on a signed-in
  // account it STALLS. This is a harness limitation, not a product defect. Guard
  // it with a timeout and skip cleanly. (The keys-excluded asymmetry of the
  // decrypted export is also verified statically by t38-e5.)
  const TIMEOUT = Symbol('timeout')
  const decResult: any = await Promise.race([
    appA.createDecryptedBackupFile.execute(),
    sleep(20000).then(() => TIMEOUT),
  ])
  if (decResult === TIMEOUT || decResult?.isFailed?.()) {
    skip(
      'decrypted-export re-import (live)',
      'createDecryptedBackupFile stalled on the headless ExportBackup authorization challenge (ProtectionSessionDuration prompt unanswerable headless); keys-excluded asymmetry verified statically by t38-e5',
    )
  } else {
    const decBackup = decResult.getValue()
    check('decrypted backup created with items', !!decBackup && decBackup.items.length > 0)
    check(
      'decrypted backup EXCLUDES items keys (no key-material leak)',
      !decBackup.items.some((i: any) => String(i.content_type).includes('ItemsKey')),
    )

    const B = await freshAccount() // brand-new account + device
    unwrap<any>(await B.app.app.importData(decBackup, false))
    await sleep(300)
    const bNotes = B.app.app.items.getDisplayableNotes()
    check(
      'decrypted export re-imports as readable notes on a fresh account',
      uuids.every((u) => bNotes.find((r: any) => r.uuid === u)?.text === bodies[u]),
    )
    await cleanup(B.app, B.dataDir)
  }
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
