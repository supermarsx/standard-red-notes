// Web Worker that decrypts item payloads off the main thread.
//
// Cold-loading a large vault runs tens of thousands of synchronous WASM
// (libsodium) xchacha20 decrypts on the main thread, blocking the UI for tens of
// seconds. This worker runs the EXACT same pure per-payload decrypt
// (GenerateDecryptedParametersUseCase.execute) as the sync path, but off-thread —
// and the pool (DecryptionPool.ts) fans batches out across N worker instances so
// the work parallelizes across CPU cores.
//
// Correctness invariant: the use-case is pure over (EncryptedInputParameters,
// { itemsKey }) + a PureCryptoInterface. The main thread resolves each payload's
// key and ships only the hex `itemsKey` string; this worker reconstructs nothing
// model-shaped. A per-item failure is returned as { uuid, errorDecrypting } so a
// failed item stays encrypted exactly as on the sync path.
//
// libsodium init: SNWebCrypto.initialize() awaits sodium.ready. We MUST await it
// before the first decrypt or libsodium's lazy bindings throw. getGlobalScope()
// in sncrypto-web resolves `self` inside the worker (no `window`), so the whole
// PureCrypto + libsodium stack runs here unchanged.

import { SNWebCrypto } from '@standardnotes/sncrypto-web'
// Import the use-case from the lean @standardnotes/encryption package, NOT the
// @standardnotes/snjs mega-barrel: worker-loader sub-compiles this file as its
// own entry, and pulling the whole snjs (which transitively references
// window/document at module scope) broke that sub-compilation so the worker
// constructor never materialized — the pool silently fell back to sync for every
// item. encryption is pure crypto/models and bundles cleanly into the worker.
import { GenerateDecryptedParametersUseCase } from '@standardnotes/encryption'
import { DecryptionWorkerRequest, DecryptionWorkerResponse } from './decryptionWorkerProtocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const crypto = new SNWebCrypto()
let usecase: GenerateDecryptedParametersUseCase | null = null
let readyPromise: Promise<void> | null = null

/** Initialize libsodium exactly once; subsequent calls await the same promise. */
function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = crypto.initialize().then(() => {
      usecase = new GenerateDecryptedParametersUseCase(crypto)
    })
  }
  return readyPromise
}

const post = (message: DecryptionWorkerResponse): void => {
  ctx.postMessage(message)
}

ctx.onmessage = async (event: MessageEvent<DecryptionWorkerRequest>): Promise<void> => {
  const request = event.data
  if (request.type !== 'decryptBatch') {
    return
  }

  try {
    await ensureReady()
    const generate = usecase as GenerateDecryptedParametersUseCase

    const results = request.jobs.map((job) => {
      try {
        // Reads ONLY key.itemsKey — verified by the encryption-package round-trip test.
        return generate.execute(job.encrypted, { itemsKey: job.itemsKey } as never)
      } catch {
        // Never let one bad item poison the batch: keep it encrypted.
        return { uuid: job.encrypted.uuid, errorDecrypting: true as const }
      }
    })

    post({ type: 'decrypted', requestId: request.requestId, results })
  } catch (error) {
    // Whole-batch failure (e.g. libsodium failed to init): the pool falls back to
    // the synchronous main-thread path so no data is lost.
    post({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
