import { PayloadInterface } from '../Interfaces/PayloadInterface'
import { isLitePayload } from './LitePayload'

/**
 * Error thrown whenever a content-stripped ("lite") payload is detected on a path that would
 * mutate it, mark it dirty, persist it, or push it to the sync server. Catching this in
 * production should be impossible — its existence is a tripwire that proves the invariant is
 * being enforced.
 */
export class LitePayloadSafetyError extends Error {
  constructor(seam: string, uuid?: string) {
    super(
      `Refusing operation: a content-stripped (lite) payload reached the "${seam}" seam` +
        (uuid ? ` (uuid: ${uuid})` : '') +
        '. Syncing a lite payload would overwrite the real encrypted body with nothing. ' +
        'Re-hydrate full content via getFullContent(uuid) before mutating.',
    )
    this.name = 'LitePayloadSafetyError'
  }
}

/**
 * Throws LitePayloadSafetyError if the given payload is lite. The single guard used by the
 * mutation, dirty-emit, and pre-sync-push seams. No-op for non-lite payloads, so it is free to
 * call unconditionally regardless of the feature flag.
 *
 * @param payload The payload about to enter a dirty/mutation/sync seam.
 * @param seam A short label identifying the call site, used in the thrown message.
 */
export function assertNotLitePayload(payload: PayloadInterface | undefined | null, seam: string): void {
  if (isLitePayload(payload)) {
    throw new LitePayloadSafetyError(seam, payload?.uuid)
  }
}

/**
 * Throws if ANY payload in the array is lite. Used at batch seams such as the pre-sync-push
 * encryption step and the dirty-payload collection.
 */
export function assertNoLitePayloads(payloads: (PayloadInterface | undefined | null)[], seam: string): void {
  for (const payload of payloads) {
    assertNotLitePayload(payload, seam)
  }
}
