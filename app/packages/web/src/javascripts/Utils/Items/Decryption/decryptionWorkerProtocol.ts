// Message protocol shared between the main thread and the decryption Web Worker
// (decryption.worker.ts). Kept dependency-free (only serializable types) so both
// sides import the exact same shapes without pulling the worker runtime into the
// main bundle.
//
// Everything here is structured-clone-safe: EncryptedInputParameters are plain
// JSON, the key is a single hex string, and DecryptedParameters/Error markers are
// plain objects. No @standardnotes model instances cross the boundary.

import {
  DecryptedParameters,
  EncryptedInputParameters,
  ErrorDecryptingParameters,
} from '@standardnotes/snjs'

/** One payload to decrypt: encrypted params + the hex itemsKey the V004 use-case reads. */
export type DecryptionWorkerJob = {
  encrypted: EncryptedInputParameters
  itemsKey: string
}

/** Main thread -> worker. A batch amortizes postMessage overhead. */
export type DecryptionWorkerRequest = {
  type: 'decryptBatch'
  requestId: number
  jobs: DecryptionWorkerJob[]
}

/** Worker -> main thread. `results` aligns 1:1 (and in order) with the request jobs. */
export type DecryptionWorkerResponse =
  | { type: 'decrypted'; requestId: number; results: (DecryptedParameters | ErrorDecryptingParameters)[] }
  | { type: 'error'; requestId: number; message: string }
