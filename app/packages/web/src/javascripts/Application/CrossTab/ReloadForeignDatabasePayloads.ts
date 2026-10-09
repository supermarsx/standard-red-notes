import {
  CreateDecryptionSplitWithKeyLookup,
  CreatePayload,
  EncryptionProviderInterface,
  FullyFormedPayloadInterface,
  isEncryptedPayload,
  isNotUndefined,
  PayloadEmitSource,
  PayloadManagerInterface,
  PayloadSource,
  SplitPayloadsByEncryptionType,
  StorageServiceInterface,
} from '@standardnotes/snjs'

/**
 * Refresh peer-tab writes from the shared database without starting a server
 * sync. LocalDatabaseLoaded emissions update the in-memory item graph but do
 * not persist the same rows again, so a foreign invalidation cannot echo back
 * through Database.emitSaved.
 *
 * DECRYPT BEFORE EMITTING (the "everything vanished after a while" fix). Every account
 * row on disk is CIPHERTEXT: DiskStorageService.savePayloads stores items through
 * CreateEncryptedLocalStorageContextPayload, so getRawPayloads returns payloads whose
 * `content` is a "004:..." string and CreatePayload builds an EncryptedPayload. Emitting
 * those as-is REPLACED each decrypted in-memory item with an encrypted one, and an item
 * that is no longer decrypted is reported to the UI as `removed`
 * (ItemManager.notifyObserversByUiAdjustingDelta -> itemsToRemoveFromUI) and dropped by
 * every display controller (ItemDisplayController: `isEncryptedItem(element) -> remove()`).
 * In a multi-tab session that silently erased from each tab's note list — and from its open
 * editor, via ItemListController.removeSelectedItem — every item the OTHER tab wrote,
 * accumulating until the list looked empty. Nothing on this path writes or deletes a row, so
 * the data was never lost; it was invisible until the next reload. We therefore decrypt
 * exactly as the cold-load path does (SyncService.processPayloadBatch).
 *
 * NEVER DOWNGRADE A VISIBLE ITEM. A cross-tab cache refresh is an optimisation, not an
 * authority. If a peer-saved row cannot be decrypted (a vault key we do not hold, a key that
 * has not arrived yet), emitting the undecryptable payload would take the item out of the UI
 * on the strength of a *local cache* event. Such a payload is skipped and logged instead: the
 * copy we already hold stays exactly as it is, and the next real sync or reload reconciles it.
 */
export async function reloadForeignDatabasePayloads(
  uuids: string[],
  storage: Pick<StorageServiceInterface, 'getRawPayloads'>,
  payloads: Pick<PayloadManagerInterface, 'emitPayloads'>,
  encryption: Pick<EncryptionProviderInterface, 'decryptSplit'>,
): Promise<void> {
  const uniqueUuids = [...new Set(uuids)]
  if (uniqueUuids.length === 0) {
    return
  }

  const rawPayloads = await storage.getRawPayloads(uniqueUuids)

  const databasePayloads = rawPayloads
    .map((payload) => {
      try {
        return CreatePayload(payload, PayloadSource.LocalDatabaseLoaded) as FullyFormedPayloadInterface
      } catch (error) {
        /** A row we cannot even construct must not abort the rest of the batch. */
        console.error('[CrossTab] Could not construct a peer-saved payload; skipping it.', error)
        return undefined
      }
    })
    .filter(isNotUndefined)

  const encrypted = databasePayloads.filter(isEncryptedPayload)
  const usable: FullyFormedPayloadInterface[] = databasePayloads.filter((payload) => !isEncryptedPayload(payload))

  if (encrypted.length > 0) {
    const decryptionSplit = CreateDecryptionSplitWithKeyLookup(SplitPayloadsByEncryptionType(encrypted))
    const results = await encryption.decryptSplit(decryptionSplit)

    const stillEncrypted = results.filter(isEncryptedPayload)
    for (const payload of results) {
      if (!isEncryptedPayload(payload)) {
        usable.push(payload)
      }
    }

    if (stillEncrypted.length > 0) {
      console.error(
        `[CrossTab] ${stillEncrypted.length} peer-saved row(s) could not be decrypted; leaving the copies already ` +
          `in memory untouched rather than removing them from the interface. First uuids: ${stillEncrypted
            .slice(0, 5)
            .map((payload) => payload.uuid)
            .join(', ')}`,
      )
    }
  }

  if (usable.length === 0) {
    return
  }

  await payloads.emitPayloads(usable, PayloadEmitSource.LocalDatabaseLoaded)
}
