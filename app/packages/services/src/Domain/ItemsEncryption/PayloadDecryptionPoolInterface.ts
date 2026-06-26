import {
  DecryptedParameters,
  EncryptedInputParameters,
  ErrorDecryptingParameters,
} from '@standardnotes/encryption'
import { ItemContent } from '@standardnotes/models'

/**
 * A single unit of work for the off-main-thread decryption pool: the fully
 * serializable encrypted parameters plus ONLY the hex `itemsKey` string the
 * pure V004 decrypt use-case reads. No model objects cross the worker boundary.
 */
export type PooledDecryptionJob = {
  encrypted: EncryptedInputParameters
  itemsKey: string
}

/**
 * Pluggable parallel decryption pool. Implemented in the web package (where the
 * webpack worker-loader can bundle a Web Worker) and injected into
 * ItemsEncryptionService at app launch. When absent (Node/jest/SSR) the service
 * transparently falls back to its existing synchronous main-thread path, so
 * correctness and existing tests are unaffected.
 *
 * The pool runs the SAME pure use-case the sync path runs
 * (GenerateDecryptedParametersUseCase.execute), so results are identical — it
 * only moves the work off the main thread and across CPU cores. Per-item
 * failures are returned as ErrorDecryptingParameters ({ uuid, errorDecrypting }),
 * preserving the exact "failed item stays encrypted" semantics.
 */
export interface PayloadDecryptionPoolInterface {
  /** True only when real Workers exist and the pool is enabled. */
  readonly isAvailable: boolean

  /**
   * Decrypt a batch of jobs in parallel. Results are returned in the SAME order
   * as the input jobs. Implementations must never throw for a single bad item —
   * they return an ErrorDecryptingParameters marker for it instead.
   */
  decrypt<C extends ItemContent = ItemContent>(
    jobs: PooledDecryptionJob[],
  ): Promise<(DecryptedParameters<C> | ErrorDecryptingParameters)[]>

  /** Tear down all workers. Safe to call multiple times. */
  destroy(): void
}
