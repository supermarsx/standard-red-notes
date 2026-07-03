import { DecryptedPayloadInterface, FullyFormedPayloadInterface, isLitePayload } from '@standardnotes/models'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'

/**
 * DATA-LOSS GUARD (lazy-decrypt): when `lazyDecryptEnabled` is on, cold-loaded note payloads held
 * in memory are content-stripped ("lite") — their body (`text`) was discarded. A backup is
 * assembled from these in-memory payloads, so without re-hydration an encrypted OR decrypted
 * backup would silently contain body-less notes (irreversible loss when restored — and desktop
 * writes these backups automatically on a timer).
 *
 * For every lite payload we re-read the FULL body from the local database via
 * `sync.getFullContentPayload(uuid)` and substitute it. If a lite payload cannot be re-hydrated
 * (item unreadable / awaiting key — in which case its body was already inaccessible), it is
 * EXCLUDED from the backup rather than written body-less: a missing item is recoverable from the
 * server/on-disk ciphertext, a truncated one masquerading as complete is not.
 *
 * With the flag off, no payload is lite and this is a pass-through (returns the same array).
 */
export async function rehydrateLiteBackupPayloads<T extends FullyFormedPayloadInterface>(
  payloads: T[],
  sync: Pick<SyncServiceInterface, 'getFullContentPayload'>,
): Promise<(T | DecryptedPayloadInterface)[]> {
  if (!payloads.some((payload) => isLitePayload(payload))) {
    return payloads
  }

  const result: (T | DecryptedPayloadInterface)[] = []

  for (const payload of payloads) {
    if (!isLitePayload(payload)) {
      result.push(payload)
      continue
    }

    const full = await sync.getFullContentPayload(payload.uuid)
    if (!full || isLitePayload(full)) {
      console.error(
        `rehydrateLiteBackupPayloads: excluding note ${payload.uuid} from backup — could not re-hydrate full ` +
          'content; refusing to write a body-less payload into a backup',
      )
      continue
    }

    result.push(full)
  }

  return result
}
