/* eslint-disable @typescript-eslint/no-explicit-any */
import { isString, AlertService, uniqueArray } from '@standardnotes/snjs'

const STORE_NAME = 'items'
const READ_WRITE = 'readwrite'

const OUT_OF_SPACE =
  'Unable to save changes locally because your device is out of space. ' +
  'Please free up some disk space and try again, otherwise, your data may end ' +
  'up in an inconsistent state.'

const DB_DELETION_BLOCKED =
  'Your browser is blocking Standard Red Notes from deleting the local database. ' +
  'Make sure there are no other open windows of this app and try again. ' +
  'If the issue persists, please manually delete app data to sign out.'

const QUOTE_EXCEEDED_ERROR = 'QuotaExceededError'

/**
 * Standard Red Notes: cross-tab hooks injected into the Database so the low-level store
 * participates in coordination WITHOUT depending on snjs services. `emitSaved` broadcasts
 * the uuids just written (so peers invalidate+reload them), and `isWriteBlocked` lets the
 * keychain-lock veto writes — once another tab rotated/cleared the keychain, persisting
 * ciphertext encrypted under our stale in-memory key would be permanently undecryptable,
 * so we refuse the write entirely.
 */
export interface DatabaseCrossTabHooks {
  emitSaved?: (uuids: string[]) => void
  isWriteBlocked?: () => boolean
}

export class Database {
  private locked = true
  private db?: IDBDatabase
  private crossTabHooks?: DatabaseCrossTabHooks

  constructor(
    public databaseName: string,
    private alertService?: AlertService,
  ) {}

  /**
   * Standard Red Notes: wire cross-tab coordination. Called from
   * WebOrDesktopDevice.setApplication so each per-identifier Database can broadcast its
   * saves and consult the keychain lock.
   */
  public setCrossTabHooks(hooks: DatabaseCrossTabHooks): void {
    this.crossTabHooks = hooks
  }

  public deinit(): void {
    ;(this.alertService as unknown) = undefined
    this.db = undefined
    this.crossTabHooks = undefined
  }

  /**
   * Relinquishes the lock and allows db operations to proceed
   */
  public unlock(): void {
    this.locked = false
  }

  static async getAllDatabaseNames(): Promise<string[] | undefined> {
    if (!window.indexedDB.databases) {
      return undefined
    }

    const rawDatabases = await window.indexedDB.databases()
    return rawDatabases.map((db) => db.name).filter((name) => name && name.length > 0) as string[]
  }

  static async deleteAll(databaseNames: string[]): Promise<void> {
    if (window.indexedDB.databases != undefined) {
      const idbNames = await this.getAllDatabaseNames()

      if (idbNames) {
        databaseNames = uniqueArray([...idbNames, ...databaseNames])
      }
    }

    for (const name of databaseNames) {
      const db = new Database(name)

      await db.clearAllPayloads()

      db.deinit()
    }
  }

  /**
   * Opens the database natively, or returns the existing database object if already opened.
   * @param onNewDatabase - Callback to invoke when a database has been created
   * as part of the open process. This can happen on new application sessions, or if the
   * browser deleted the database without the user being aware.
   */
  public async openDatabase(onNewDatabase?: () => void): Promise<IDBDatabase | undefined> {
    if (this.locked) {
      throw Error('Attempting to open locked database')
    }
    if (this.db) {
      return this.db
    }
    const request = window.indexedDB.open(this.databaseName, 1)
    return new Promise((resolve, reject) => {
      request.onerror = (event) => {
        const target = event.target as any
        if (target.errorCode) {
          this.showAlert('Offline database issue: ' + target.errorCode)
        } else {
          this.displayOfflineAlert()
        }
        reject(new Error('Unable to open db'))
      }
      request.onblocked = (_event) => {
        reject(Error('IndexedDB open request blocked'))
      }
      request.onsuccess = (event) => {
        const target = event.target as IDBOpenDBRequest
        const db = target.result
        db.onversionchange = () => {
          db.close()
        }
        db.onerror = (errorEvent) => {
          const target = errorEvent?.target as any
          throw Error('Database error: ' + target.errorCode)
        }
        this.db = db
        resolve(db)
      }
      request.onupgradeneeded = (event) => {
        const target = event.target as IDBOpenDBRequest
        const db = target.result
        db.onversionchange = () => {
          db.close()
        }
        /* Create an objectStore for this database */
        const objectStore = db.createObjectStore(STORE_NAME, {
          keyPath: 'uuid',
        })
        objectStore.createIndex('uuid', 'uuid', { unique: true })
        objectStore.transaction.oncomplete = () => {
          /* Ready to store values in the newly created objectStore. */
          if (db.version === 1 && onNewDatabase) {
            onNewDatabase && onNewDatabase()
          }
        }
      }
    })
  }

  public async getAllPayloads(): Promise<any[]> {
    const db = (await this.openDatabase()) as IDBDatabase
    return new Promise((resolve) => {
      const objectStore = db.transaction(STORE_NAME).objectStore(STORE_NAME)
      const payloads: any = []
      const cursorRequest = objectStore.openCursor()
      cursorRequest.onsuccess = (event) => {
        const target = event.target as any
        const cursor = target.result
        if (cursor) {
          payloads.push(cursor.value)
          cursor.continue()
        } else {
          resolve(payloads)
        }
      }
    })
  }

  /**
   * Streams the database via a cursor but retains ONLY lightweight per-item
   * metadata (uuid/content_type/updated_at), never the full ciphertext body.
   * This lets cold-load sort+chunk by priority without ever holding the entire
   * corpus resident — the per-chunk bodies are then fetched on demand via
   * getPayloadsForKeys. At 50GB the full-entry getAllPayloads() OOMs the tab
   * before decryption; this keeps peak metadata memory tiny (a few fields/item).
   */
  public async getAllMetadata(): Promise<{ uuid: string; content_type: string; updated_at: Date }[]> {
    const db = (await this.openDatabase()) as IDBDatabase
    return new Promise((resolve) => {
      const objectStore = db.transaction(STORE_NAME).objectStore(STORE_NAME)
      const metadata: { uuid: string; content_type: string; updated_at: Date }[] = []
      const skippedUuids: string[] = []
      const cursorRequest = objectStore.openCursor()
      cursorRequest.onsuccess = (event) => {
        const target = event.target as any
        const cursor = target.result
        if (cursor) {
          const value = cursor.value
          /**
           * An item with a missing/empty content_type would flow as an undefined type
           * into downstream priority-sort/chunk logic. Guard it here: skip the item and
           * record it rather than propagating an untyped entry into the typed map.
           */
          if (!isString(value.content_type) || value.content_type.length === 0) {
            skippedUuids.push(value.uuid)
          } else {
            metadata.push({
              uuid: value.uuid,
              content_type: value.content_type,
              updated_at: value.updated_at,
            })
          }
          cursor.continue()
        } else {
          if (skippedUuids.length > 0) {
            console.warn(
              `[Database] getAllMetadata: ${skippedUuids.length} item(s) skipped due to missing/empty content_type: ${skippedUuids.join(', ')}`,
            )
          }
          resolve(metadata)
        }
      }
    })
  }

  public async getPayloadsForKeys(keys: string[]): Promise<any[]> {
    if (keys.length === 0) {
      return []
    }
    const db = (await this.openDatabase()) as IDBDatabase
    return new Promise((resolve) => {
      const objectStore = db.transaction(STORE_NAME).objectStore(STORE_NAME)
      const payloads: any = []
      /**
       * We intentionally skip-and-continue on unreadable (corrupt/partial) rows so a
       * single bad record can't abort the whole cold-load. But a skipped row must not
       * vanish silently — collect the affected uuids and warn so a caller/UI can see
       * that N items could not be read. Return shape is unchanged (Promise<any[]>) to
       * avoid breaking callers (getDatabaseEntries in WebOrDesktopDevice).
       */
      const skippedUuids: string[] = []
      let numComplete = 0
      const finishIfDone = () => {
        if (numComplete === keys.length) {
          if (skippedUuids.length > 0) {
            console.warn(
              `[Database] getPayloadsForKeys: ${skippedUuids.length} item(s) could not be read and were skipped: ${skippedUuids.join(', ')}`,
            )
          }
          resolve(payloads)
        }
      }
      for (const key of keys) {
        const getRequest = objectStore.get(key)
        getRequest.onsuccess = (event) => {
          const target = event.target as any
          const result = target.result
          if (result) {
            payloads.push(result)
          } else {
            /**
             * A get that succeeds but returns no result means the row is absent. This
             * is also a (quieter) form of silent loss for a requested key, so record it.
             */
            skippedUuids.push(key)
          }
          numComplete++
          finishIfDone()
        }
        getRequest.onerror = () => {
          skippedUuids.push(key)
          numComplete++
          finishIfDone()
        }
      }
    })
  }

  public async getAllKeys(): Promise<string[]> {
    const db = (await this.openDatabase()) as IDBDatabase

    return new Promise((resolve) => {
      const objectStore = db.transaction(STORE_NAME).objectStore(STORE_NAME)
      const getAllKeysRequest = objectStore.getAllKeys()
      getAllKeysRequest.onsuccess = function () {
        const result = getAllKeysRequest.result

        const strings = result.map((key) => {
          if (isString(key)) {
            return key
          } else {
            return JSON.stringify(key)
          }
        })

        resolve(strings)
      }
    })
  }

  public async savePayload(payload: any): Promise<void> {
    return this.savePayloads([payload])
  }

  public async savePayloads(payloads: any[]): Promise<void> {
    if (payloads.length === 0) {
      return
    }

    /**
     * KEYCHAIN SAFETY GATE: if another tab cleared/rotated the keychain, our in-memory
     * root key is stale. Anything in this batch was (or is about to be) encrypted under
     * that stale key, so writing it to the shared IndexedDB would produce permanently
     * undecryptable ciphertext and/or clobber the foreign rotation. Refuse the write; the
     * keychain-lock also triggers a reload, after which writes resume under a fresh key.
     */
    if (this.crossTabHooks?.isWriteBlocked?.()) {
      throw new Error(
        'Refusing to save: the keychain changed in another tab, so this data may be encrypted under a stale key.',
      )
    }

    const db = (await this.openDatabase()) as IDBDatabase
    const transaction = db.transaction(STORE_NAME, READ_WRITE)
    return new Promise((resolve, reject) => {
      /**
       * The transaction may signal failure via onabort (the normal path: a failed
       * put bubbles up and aborts the txn) AND putItems may reject from an individual
       * put's onerror. Both lead here, so guard against double-settling the promise.
       */
      let settled = false
      const settleResolve = () => {
        if (settled) {
          return
        }
        settled = true
        /**
         * SAVE INVALIDATION: broadcast the uuids we just durably wrote so peer tabs can
         * invalidate their in-memory copies and reload our newer disk version (instead of
         * later overwriting it with their stale copy — the silent lost-write case).
         */
        try {
          const uuids = payloads.map((p) => p?.uuid).filter((uuid): uuid is string => typeof uuid === 'string')
          this.crossTabHooks?.emitSaved?.(uuids)
        } catch (error) {
          // Broadcasting is best-effort; never fail a successful save because of it.
          console.error('[Database] cross-tab save emit failed', error)
        }
        resolve()
      }
      const settleReject = (error: any) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }

      // eslint-disable-next-line @typescript-eslint/no-empty-function
      transaction.oncomplete = () => {}
      transaction.onerror = (event) => {
        const target = event.target as any
        this.showGenericError(target.error)
      }
      transaction.onabort = (event) => {
        const target = event.target as any
        const error = target.error
        if (error && error.name === QUOTE_EXCEEDED_ERROR) {
          this.showAlert(OUT_OF_SPACE)
        } else {
          this.showGenericError(error)
        }
        settleReject(error)
      }
      const objectStore = transaction.objectStore(STORE_NAME)
      this.putItems(objectStore, payloads)
        .then(settleResolve)
        /**
         * A per-item put error rejects putItems. Surface it (instead of the previous
         * .catch(console.error) which silently swallowed it). If the same failure also
         * aborted the transaction, onabort will have already settled the promise and
         * settleReject is a no-op, so there is no double-reject.
         */
        .catch(settleReject)
    })
  }

  private async putItems(objectStore: IDBObjectStore, items: any[]): Promise<void> {
    await Promise.all(
      items.map((item) => {
        return new Promise<void>((resolve, reject) => {
          const request = objectStore.put(item)
          request.onsuccess = () => resolve()
          request.onerror = () => {
            /**
             * A failed put() must fail the operation rather than resolve silently,
             * otherwise an item that errored WITHOUT aborting the transaction (e.g. a
             * per-item constraint/serialization failure) would vanish while the txn
             * still completes "ok" — the silent half-write case at scale.
             *
             * This per-request error event bubbles up to the transaction's onerror
             * and, unless preventDefault() is called, aborts the transaction — which
             * drives savePayloads' transaction.onabort handler (and its reject). So we
             * surface the error here and let savePayloads' own try/catch decide; we do
             * NOT also reject the outer savePayloads promise from here to avoid a
             * double-reject. The putItems promise rejection is caught in savePayloads
             * (see swallow note there).
             */
            reject(request.error)
          }
        })
      }),
    )
  }

  public async deletePayload(uuid: string): Promise<void> {
    const db = (await this.openDatabase()) as IDBDatabase
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, READ_WRITE).objectStore(STORE_NAME).delete(uuid)
      request.onsuccess = () => {
        resolve()
      }
      request.onerror = reject
    })
  }

  public async clearAllPayloads(): Promise<void> {
    const deleteRequest = window.indexedDB.deleteDatabase(this.databaseName)
    return new Promise((resolve, reject) => {
      deleteRequest.onerror = () => {
        reject(Error('Error deleting database.'))
      }
      deleteRequest.onsuccess = () => {
        this.db = undefined
        resolve()
      }
      deleteRequest.onblocked = (_event) => {
        this.showAlert(DB_DELETION_BLOCKED)
        reject(Error('Delete request blocked'))
      }
    })
  }

  private showAlert(message: string) {
    if (this.alertService) {
      this.alertService.alert(message).catch(console.error)
    } else {
      window.alert(message)
    }
  }

  private showGenericError(error: { code: number; name: string }) {
    const message =
      'Unable to save changes locally due to an unknown system issue. ' +
      `Issue Code: ${error.code} Issue Name: ${error.name}.`

    this.showAlert(message)
  }

  private displayOfflineAlert() {
    const message =
      'There was an issue loading your offline database. This could happen for two reasons:' +
      "\n\n1. You're in a private window in your browser. We can't save your data without " +
      'access to the local database. Please use a non-private window.' +
      '\n\n2. You have two windows of the app open at the same time. ' +
      'Please close any other app instances and reload the page.'

    this.showAlert(message)
  }
}
