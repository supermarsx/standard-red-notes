import { EncryptedBytes, LocalFileBackendInterface } from '@standardnotes/snjs'

const STORE_NAME = 'localFiles'
const DB_VERSION = 1

/**
 * IndexedDB-backed storage for "large local-only files": files the user chose to keep on this
 * device only (never uploaded to the server). The bytes handed here are already E2E-encrypted by
 * the FileService, so this layer only ever stores ciphertext.
 *
 * Bytes are stored as a Blob keyed by the file's uuid. A separate database (suffixed
 * `-local-files`) is used so the large blobs never bloat / lock the main items store.
 *
 * CAVEATS (see stability report):
 * - Subject to the browser's per-origin storage quota; a 500 MB file may throw
 *   QuotaExceededError on `put`. The error is surfaced to the caller.
 * - Reading a file materializes its full encrypted bytes into a single ArrayBuffer in the tab.
 */
export class WebLocalFileStorage implements LocalFileBackendInterface {
  private db?: IDBDatabase
  private readonly databaseName: string

  constructor(identifier: string) {
    this.databaseName = `${identifier}-local-files`
  }

  deinit(): void {
    this.db?.close()
    this.db = undefined
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.db) {
      return Promise.resolve(this.db)
    }
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(this.databaseName, DB_VERSION)
      request.onerror = () => reject(request.error ?? new Error('Unable to open local file database'))
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'uuid' })
        }
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        this.db = db
        resolve(db)
      }
    })
  }

  async persistEncryptedBytes(uuid: string, bytes: EncryptedBytes): Promise<void> {
    const db = await this.openDatabase()
    // Store as a Blob: IndexedDB can persist blobs without holding the whole ArrayBuffer
    // serialized in the structured-clone, which is friendlier on memory for large files.
    const blob = new Blob([bytes.encryptedBytes as Uint8Array<ArrayBuffer>])
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Local file write aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Local file write failed'))
      transaction.objectStore(STORE_NAME).put({ uuid, blob, size: bytes.encryptedBytes.length })
    })
  }

  async readEncryptedBytes(uuid: string): Promise<EncryptedBytes | undefined> {
    const db = await this.openDatabase()
    const record = await new Promise<{ uuid: string; blob: Blob } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(uuid)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Local file read failed'))
    })

    if (!record) {
      return undefined
    }

    const arrayBuffer = await record.blob.arrayBuffer()
    return { encryptedBytes: new Uint8Array(arrayBuffer) }
  }

  async removeEncryptedBytes(uuid: string): Promise<void> {
    const db = await this.openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(uuid)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Local file delete failed'))
    })
  }
}
