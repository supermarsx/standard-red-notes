import {
  CreatePayload,
  PayloadEmitSource,
  PayloadManagerInterface,
  PayloadSource,
  StorageServiceInterface,
} from '@standardnotes/snjs'

/**
 * Refresh peer-tab writes from the shared database without starting a server
 * sync. LocalDatabaseLoaded emissions update the in-memory item graph but do
 * not persist the same rows again, so a foreign invalidation cannot echo back
 * through Database.emitSaved.
 */
export async function reloadForeignDatabasePayloads(
  uuids: string[],
  storage: Pick<StorageServiceInterface, 'getRawPayloads'>,
  payloads: Pick<PayloadManagerInterface, 'emitPayloads'>,
): Promise<void> {
  const uniqueUuids = [...new Set(uuids)]
  if (uniqueUuids.length === 0) {
    return
  }

  const rawPayloads = await storage.getRawPayloads(uniqueUuids)
  const databasePayloads = rawPayloads.map((payload) => CreatePayload(payload, PayloadSource.LocalDatabaseLoaded))
  await payloads.emitPayloads(databasePayloads, PayloadEmitSource.LocalDatabaseLoaded)
}
