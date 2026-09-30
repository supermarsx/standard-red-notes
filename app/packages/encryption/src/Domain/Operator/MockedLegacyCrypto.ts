import { PureCryptoInterface } from '@standardnotes/sncrypto-common'

/**
 * Deterministic stand-in for the primitives the legacy 001/002/003 operators use,
 * the counterpart of `004/MockedCrypto.ts` for the pre-xchacha protocols.
 *
 * Two constraints shape it, and both come from the protocols themselves:
 *
 * - The 002 protocol string is `[version, authHash, uuid, iv, ciphertext].join(':')`
 *   and is split back apart on ':' when decrypting, so no primitive may emit a colon
 *   or every component after it shifts by one field.
 * - Derived keys are fed straight back in as AES keys, so `pbkdf2`, `sha256` and
 *   `unsafeSha1` emit only `[A-Za-z0-9_]` — a '.' in a key would collide with the
 *   ciphertext framing below.
 *
 * `aes256CbcDecrypt` returns null when handed the wrong key or iv rather than
 * returning the wrong plaintext, because that is what a real AES-CBC decrypt does
 * and the operators' `errorDecrypting` branches depend on it.
 */

const escapeColons = (text: string): string => text.replace(/:/g, '|')
const unescapeColons = (text: string): string => text.replace(/\|/g, ':')
const opaque = (text: string): string => text.replace(/[^a-zA-Z0-9_]/g, '_')

/** Pads to a length divisible by 6 so `splitString(_, 2)` and `splitString(_, 3)` partition exactly. */
const padToSixths = (text: string): string => text.padEnd(text.length + ((6 - (text.length % 6)) % 6), 'z')

export function legacyPbkdf2Output(password: string, salt: string, iterations: number, length: number): string {
  return padToSixths(opaque(`pbkdf2_${password}_${salt}_${iterations}_${length}`))
}

export function legacySha1Output(text: string): string {
  return `sha1_${opaque(text)}`
}

export function legacySha256Output(text: string): string {
  return `sha256_${opaque(text)}`
}

export function getMockedLegacyCrypto(): jest.Mocked<PureCryptoInterface> {
  const crypto = {} as jest.Mocked<PureCryptoInterface>

  let randomKeyCalls = 0

  crypto.generateRandomKey = jest.fn().mockImplementation((bits: number) => {
    randomKeyCalls += 1
    const key = `rk${bits}i${randomKeyCalls}`
    /** Even length: the operators halve item keys into an encryption key and an auth key. */
    return key.length % 2 === 0 ? key : `${key}x`
  })

  crypto.aes256CbcEncrypt = jest
    .fn()
    .mockImplementation(
      async (plaintext: string, iv: string, key: string) =>
        `AES.${escapeColons(key)}.${escapeColons(iv)}.${escapeColons(plaintext)}`,
    )

  crypto.aes256CbcDecrypt = jest.fn().mockImplementation(async (ciphertext: string, iv: string, key: string) => {
    const parsed = /^AES\.([^.]*)\.([^.]*)\.([\s\S]*)$/.exec(ciphertext)
    if (!parsed) {
      return null
    }
    if (parsed[1] !== escapeColons(key) || parsed[2] !== escapeColons(iv)) {
      return null
    }
    return unescapeColons(parsed[3])
  })

  crypto.hmac256 = jest
    .fn()
    .mockImplementation(async (message: string, key: string) => `hmac.${escapeColons(key)}.${escapeColons(message)}`)

  crypto.timingSafeEqual = jest.fn().mockImplementation((a: string, b: string) => a === b)

  crypto.pbkdf2 = jest
    .fn()
    .mockImplementation(async (password: string, salt: string, iterations: number, length: number) =>
      legacyPbkdf2Output(password, salt, iterations, length),
    )

  crypto.unsafeSha1 = jest.fn().mockImplementation(async (text: string) => legacySha1Output(text))

  crypto.sha256 = jest.fn().mockImplementation(async (text: string) => legacySha256Output(text))

  crypto.base64Encode = jest.fn().mockImplementation((text: string) => `base64-${escapeColons(text)}`)

  crypto.base64Decode = jest.fn().mockImplementation((text: string) => unescapeColons(text.split('base64-')[1] ?? ''))

  return crypto
}
