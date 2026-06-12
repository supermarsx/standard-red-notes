/* eslint-disable camelcase */
// libsodium-wrappers 0.8 stopped re-exporting named members via the package's
// `exports` map and stopped attaching them to the default export at module
// init time. They become available on the default export only after
// `await ready` resolves. To preserve the existing `import { fn } from
// './libsodium'` call sites without re-ordering every caller around an
// async boundary, every function below is exported as a thin lazy lookup —
// the actual runtime binding is fetched off the default export on each
// invocation, after callers have already awaited `ready` upstream.
import sodium from 'libsodium-wrappers-sumo'

type SodiumApi = typeof sodium

export const ready: Promise<void> = sodium.ready

function lazy<K extends keyof SodiumApi>(name: K): SodiumApi[K] {
  return ((...args: unknown[]) => {
    const fn = sodium[name] as unknown as (...a: unknown[]) => unknown
    if (typeof fn !== 'function') {
      throw new Error(`libsodium: ${String(name)} is not available; await ready before calling crypto.`)
    }
    return fn.apply(sodium, args)
  }) as unknown as SodiumApi[K]
}

// Constants are only attached to the default export after `await ready`, so they
// MUST be read lazily at call time — reading them at module-load time captures
// `undefined` and silently breaks every crypto operation that depends on them.
function lazyConst<K extends keyof SodiumApi>(name: K): () => SodiumApi[K] {
  return () => sodium[name]
}

export const base64_variants = new Proxy({} as SodiumApi['base64_variants'], {
  get(_target, prop) {
    return (sodium.base64_variants as unknown as Record<PropertyKey, unknown>)[prop]
  },
})

export const getCryptoPwhashAlgDefault = lazyConst('crypto_pwhash_ALG_DEFAULT')
export const getCryptoGenerichashBytes = lazyConst('crypto_generichash_BYTES')

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

export type { StateAddress } from 'libsodium-wrappers-sumo'
