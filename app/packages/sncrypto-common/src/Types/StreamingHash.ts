import { SodiumStateAddress } from './SodiumStateAddress'

/**
 * An in-progress SHA-256 over a byte stream.
 *
 * Exists because the digest of a whole encrypted file has to be produced while
 * that file is streamed in chunks — it is never resident in memory, so the
 * one-shot `sha256` cannot be used for it. The state is an opaque libsodium
 * handle, held exactly like {@link StreamEncryptor}'s, and is consumed by
 * finalizing: a hash must not be finalized twice.
 */
export type StreamingHash = {
  state: SodiumStateAddress
}
