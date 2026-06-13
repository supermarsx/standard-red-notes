/* eslint-disable camelcase */
// The published @standardnotes/sncrypto-web bundles do `export { crypto_pwhash, ... }
// from 'libsodium-wrappers'`, expecting (a) the SUMO build (standard libsodium
// lacks crypto_pwhash/argon2) and (b) the members to be live. In libsodium 0.8
// the members are attached to the default export only AFTER `await ready`.
// A static re-export therefore snapshots `undefined`. We alias 'libsodium-wrappers'
// to this shim (esbuild `alias`), which re-exports every name sncrypto-web needs
// as an ESM LIVE BINDING: functions are lazy closures (read off `sodium` at call
// time) and constants are `let` bindings assigned once `ready` resolves. Callers
// always `await ready` upstream, so the values are populated by use time.
import sodium from 'libsodium-wrappers-sumo'

export const ready = sodium.ready

const lazy =
  (name) =>
  (...args) => {
    const fn = sodium[name]
    if (typeof fn !== 'function') {
      throw new Error(`libsodium: ${name} unavailable; await ready before calling crypto.`)
    }
    return fn.apply(sodium, args)
  }

export const crypto_aead_xchacha20poly1305_ietf_decrypt = lazy('crypto_aead_xchacha20poly1305_ietf_decrypt')
export const crypto_aead_xchacha20poly1305_ietf_encrypt = lazy('crypto_aead_xchacha20poly1305_ietf_encrypt')
export const crypto_box_easy = lazy('crypto_box_easy')
export const crypto_box_keypair = lazy('crypto_box_keypair')
export const crypto_box_open_easy = lazy('crypto_box_open_easy')
export const crypto_box_seed_keypair = lazy('crypto_box_seed_keypair')
export const crypto_generichash = lazy('crypto_generichash')
export const crypto_kdf_derive_from_key = lazy('crypto_kdf_derive_from_key')
export const crypto_pwhash = lazy('crypto_pwhash')
export const crypto_secretstream_xchacha20poly1305_init_pull = lazy('crypto_secretstream_xchacha20poly1305_init_pull')
export const crypto_secretstream_xchacha20poly1305_init_push = lazy('crypto_secretstream_xchacha20poly1305_init_push')
export const crypto_secretstream_xchacha20poly1305_pull = lazy('crypto_secretstream_xchacha20poly1305_pull')
export const crypto_secretstream_xchacha20poly1305_push = lazy('crypto_secretstream_xchacha20poly1305_push')
export const crypto_sign_detached = lazy('crypto_sign_detached')
export const crypto_sign_keypair = lazy('crypto_sign_keypair')
export const crypto_sign_seed_keypair = lazy('crypto_sign_seed_keypair')
export const crypto_sign_verify_detached = lazy('crypto_sign_verify_detached')
export const from_base64 = lazy('from_base64')
export const from_hex = lazy('from_hex')
export const from_string = lazy('from_string')
export const to_base64 = lazy('to_base64')
export const to_hex = lazy('to_hex')
export const to_string = lazy('to_string')

// `base64_variants` is a static enum available pre-`ready`, and sncrypto-web
// reads `base64_variants.ORIGINAL` EAGERLY at module init. Expose it via a Proxy
// that defers each property read to `sodium` so it's never undefined.
export const base64_variants = new Proxy(
  {},
  {
    get(_t, prop) {
      const bv = sodium.base64_variants
      return bv ? bv[prop] : undefined
    },
  },
)

// These numeric constants attach only after `ready`, and are read at call time
// (inside argon2/hash), so ESM live bindings assigned post-`ready` suffice.
export let crypto_pwhash_ALG_DEFAULT
export let crypto_generichash_BYTES

void sodium.ready.then(() => {
  crypto_pwhash_ALG_DEFAULT = sodium.crypto_pwhash_ALG_DEFAULT
  crypto_generichash_BYTES = sodium.crypto_generichash_BYTES
})
