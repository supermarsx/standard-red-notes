import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import snjs from '@standardnotes/snjs'

const { UuidGenerator } = snjs as unknown as { UuidGenerator: { GenerateUuid(): string } }

// Standard Red Notes — server-side per-file upload cap (MAX_ATTACHMENT_BYTE_SIZE).
//
// The files service enforces an ABSOLUTE per-file byte cap at FinishUploadSession,
// applied even to "unlimited" accounts. An over-cap upload is rejected when the
// session is finished. This e2e drives the real end-to-end-encrypted file
// pipeline through the bridge (valet token -> files service -> chunked upload ->
// finish) and asserts the over-cap finish fails.
//
// ## Gating
// The default cap is 5 GiB, which is infeasible to upload in a test. So this spec
// runs ONLY when the operator has configured a SMALL cap that the test runner can
// exceed, surfaced to the test via the env var MAX_ATTACHMENT_BYTE_SIZE_E2E (set
// it to the same value the files service was started with, e.g. a few MB). When
// that var is absent or too large to exercise, the spec SKIPS with a clear
// message instead of attempting a multi-GB upload.

const MAX_TESTABLE_CAP = 8 * 1024 * 1024 // 8 MiB — keep the over-cap upload cheap.

function configuredCap(): number | undefined {
  const raw = process.env.MAX_ATTACHMENT_BYTE_SIZE_E2E ?? process.env.MAX_ATTACHMENT_BYTE_SIZE
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const cap = configuredCap()
  if (cap === undefined) {
    console.log(
      'SKIP: per-file upload cap unknown. Set MAX_ATTACHMENT_BYTE_SIZE_E2E to the files ' +
        "service's MAX_ATTACHMENT_BYTE_SIZE (a small value, <= 8 MiB) to run this spec.",
    )
    process.exit(0)
  }
  if (cap > MAX_TESTABLE_CAP) {
    console.log(
      `SKIP: configured per-file cap (${cap} bytes) is too large to exercise cheaply in e2e ` +
        `(> ${MAX_TESTABLE_CAP} bytes). Lower MAX_ATTACHMENT_BYTE_SIZE for the files service to test this.`,
    )
    process.exit(0)
  }

  const A = await freshAccount()
  const filesA = A.app.app.files

  // Build a payload comfortably OVER the cap (cap + 1 chunk worth of slack).
  const chunkSize = filesA.minimumChunkSize()
  const oversize = cap + chunkSize + 1024
  const original = new Uint8Array(oversize)
  // Fill with non-zero bytes so the encrypted size is representative.
  for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff

  const uuid = UuidGenerator.GenerateUuid()
  const operation = await filesA.beginNewFileUpload(original.length)
  const beganOk = operation && typeof operation.getProgress === 'function'
  check('beginNewFileUpload returned an upload operation', beganOk)
  if (!beganOk) {
    console.log('  upload begin error:', JSON.stringify(operation))
    await cleanup(A.app, A.dataDir)
    finish()
    return
  }

  // Push all the bytes in chunks (chunk transfer itself is allowed; the cap is
  // enforced when the session is FINISHED and total size is known).
  let pushError: unknown
  let index = 1
  for (let offset = 0; offset < original.length; offset += chunkSize) {
    const chunk = original.subarray(offset, Math.min(offset + chunkSize, original.length))
    const isLast = offset + chunkSize >= original.length
    const err = await filesA.pushBytesForUpload(operation, chunk, index++, isLast)
    if (err) {
      pushError = err
      break
    }
  }

  // Finishing the over-cap session must be rejected by the server. The bridge
  // surfaces this either as a falsy/error finishUpload result or a thrown error.
  let rejected = false
  if (pushError) {
    // Some deployments reject mid-stream once the running total crosses the cap.
    rejected = true
  } else {
    try {
      const fileItem = await filesA.finishUpload(operation, { name: 'too-big.bin', mimeType: 'application/octet-stream' }, uuid)
      const ok = fileItem && typeof fileItem === 'object' && 'uuid' in fileItem
      rejected = !ok
      if (ok) console.log('  unexpected: finishUpload SUCCEEDED for an over-cap file:', (fileItem as any).uuid)
    } catch {
      rejected = true
    }
  }

  check('an upload exceeding MAX_ATTACHMENT_BYTE_SIZE is rejected at session finish', rejected)

  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
