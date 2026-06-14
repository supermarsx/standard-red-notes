import snjs from '@standardnotes/snjs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { bootstrapHeadlessApp } from '../snjs/bootstrap.js'

const { UuidGenerator } = snjs as unknown as { UuidGenerator: { GenerateUuid(): string } }

// Integration e2e for FILE ATTACHMENTS: the end-to-end-encrypted file pipeline
// (valet token -> files-server -> chunked encrypted upload), and download +
// decryption on a SECOND device. Proves the bridge can round-trip binary
// attachments, not just text notes.
async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const filesA = A.app.app.files

  // A small text payload, but treated as opaque encrypted bytes end to end.
  const original = new TextEncoder().encode('encrypted attachment payload — ' + 'lorem ipsum '.repeat(40))
  const uuid = UuidGenerator.GenerateUuid()

  const operation = await filesA.beginNewFileUpload(original.length)
  check('beginNewFileUpload returned an upload operation', operation && typeof operation.getProgress === 'function')
  if (!operation || typeof operation.getProgress !== 'function') {
    console.log('  upload begin error:', JSON.stringify(operation))
    finish()
    return
  }

  // Push the bytes in chunks (only the final chunk may be smaller than the min).
  const chunkSize = filesA.minimumChunkSize()
  let index = 1 // chunk ids are 1-based
  for (let offset = 0; offset < original.length; offset += chunkSize) {
    const chunk = original.subarray(offset, Math.min(offset + chunkSize, original.length))
    const isLast = offset + chunkSize >= original.length
    const err = await filesA.pushBytesForUpload(operation, chunk, index++, isLast)
    if (err) {
      console.log('  pushBytes error:', JSON.stringify(err))
      break
    }
  }

  const fileItem = await filesA.finishUpload(operation, { name: 'attachment.txt', mimeType: 'text/plain' }, uuid)
  const uploadOk = fileItem && typeof fileItem === 'object' && 'uuid' in fileItem
  check('finishUpload returned a FileItem', uploadOk)
  if (!uploadOk) {
    console.log('  finishUpload error:', JSON.stringify(fileItem))
    finish()
    return
  }
  await A.app.sync()

  // Second device: sign in, sync, locate the file item, download + decrypt it.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-files-2-'))
  const app2 = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir: dir2, password: A.password, syncIntervalMs: 0 })
  await app2.signIn(A.email, A.password)
  await app2.sync()

  const file2 = app2.app.items.findItem((fileItem as { uuid: string }).uuid)
  check('the file item synced to the second device', !!file2)

  const received: number[] = []
  if (file2) {
    const dlErr = await app2.app.files.downloadFile(file2, async (bytes: Uint8Array) => {
      received.push(...bytes)
    })
    check('downloadFile completed without error', !dlErr)
  }
  const got = new TextDecoder().decode(new Uint8Array(received))
  check('the downloaded+decrypted bytes match the original exactly', received.length === original.length && got === new TextDecoder().decode(original))

  await cleanup(app2, dir2)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
