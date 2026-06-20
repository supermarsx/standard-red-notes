import { EncryptedBytes } from '../Types/EncryptedBytes'

/**
 * Persistence backend for "large local-only files" — files the user chose to keep on this
 * device only (never uploaded to the server). The web implementation stores the already
 * E2E-encrypted bytes in IndexedDB. Because the bytes are encrypted client-side before being
 * handed here, the backend never sees plaintext.
 *
 * This is intentionally a tiny, transport-agnostic seam so the platform layer (web) owns the
 * actual storage while the shared FileService owns the encrypt/decrypt + item wiring.
 */
export interface LocalFileBackendInterface {
  /** Persist the full encrypted byte payload for a file, keyed by the file's uuid. */
  persistEncryptedBytes(uuid: string, bytes: EncryptedBytes): Promise<void>

  /** Read back the encrypted bytes previously persisted for a file, or undefined if absent. */
  readEncryptedBytes(uuid: string): Promise<EncryptedBytes | undefined>

  /** Remove the persisted bytes for a file (e.g. on delete). */
  removeEncryptedBytes(uuid: string): Promise<void>
}
