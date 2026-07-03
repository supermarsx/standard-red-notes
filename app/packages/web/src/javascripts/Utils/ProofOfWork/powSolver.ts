// Pure, dependency-free Proof-of-Work solver.
//
// Runs both inside powSolver.worker.ts (off the main thread) and as the inline
// fallback in ThreadedPowSolver when Workers are unavailable (jest/jsdom, SSR).
// It deliberately ships its own compact synchronous SHA-256 rather than using
// crypto.subtle: WebCrypto's digest is async (unusable in the tight nonce loop
// without awaiting per iteration) and is entirely absent from the jsdom test
// environment. It also carries its own UTF-8 encoder rather than relying on the
// global TextEncoder, which is missing from the jsdom test global — keeping the
// module dependency-free and testable everywhere.

/**
 * Encode a string to its UTF-8 bytes. Standalone so the module never depends on a
 * global TextEncoder (absent in the jsdom test env). Handles surrogate pairs.
 */
function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

// SHA-256 round constants (first 32 bits of the fractional parts of the cube
// roots of the first 64 primes).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * Compute the SHA-256 digest of the given bytes and return the 32-byte hash.
 * Standalone and synchronous — verified against the sha256("abc") test vector
 * in the spec.
 */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const length = input.length
  // Padded message length: original + 0x80 byte + zero pad to 56 mod 64 + 8-byte
  // big-endian bit length.
  const withOne = length + 1
  const totalLength = withOne + ((56 - (withOne % 64) + 64) % 64) + 8
  const message = new Uint8Array(totalLength)
  message.set(input)
  message[length] = 0x80

  // Append the message bit length as a 64-bit big-endian integer. Lengths here
  // are tiny (a seed:nonce string), so the high word is always zero.
  const bitLength = length * 8
  const view = new DataView(message.buffer)
  view.setUint32(totalLength - 4, bitLength >>> 0, false)
  view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false)

  // Initial hash values (first 32 bits of the fractional parts of the square
  // roots of the first 8 primes).
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)

  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0

      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0 >>> 0, false)
  outView.setUint32(4, h1 >>> 0, false)
  outView.setUint32(8, h2 >>> 0, false)
  outView.setUint32(12, h3 >>> 0, false)
  outView.setUint32(16, h4 >>> 0, false)
  outView.setUint32(20, h5 >>> 0, false)
  outView.setUint32(24, h6 >>> 0, false)
  outView.setUint32(28, h7 >>> 0, false)
  return out
}

/**
 * Count the leading zero BITS of a digest, most-significant bit first. A fully
 * zero leading byte contributes 8; the first non-zero byte contributes its own
 * leading zeros (Math.clz32 on a byte, minus the 24 high bits clz32 counts over
 * a 32-bit word) and stops the scan.
 */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0
  for (const b of bytes) {
    if (b === 0) {
      bits += 8
      continue
    }
    bits += Math.clz32(b) - 24
    break
  }
  return bits
}

/** Whether the digest of `${seed}:${nonce}` has at least `difficulty` leading zero bits. */
export function hashMeetsDifficulty(seed: string, nonce: string, difficulty: number): boolean {
  const digest = sha256Bytes(utf8Encode(`${seed}:${nonce}`))
  return leadingZeroBits(digest) >= difficulty
}

// Hostile-challenge safety caps: a difficulty above 32 bits (or a runaway nonce
// scan) could hang the client forever, so we refuse it outright and bail with a
// thrown error the caller treats as "solve failed".
const MAX_DIFFICULTY = 32
const MAX_ITERATIONS = 1 << 26

/**
 * Find the first decimal nonce ("0","1","2",...) whose SHA-256 of `${seed}:${nonce}`
 * has at least `difficulty` leading zero bits, and return it. Throws if the
 * difficulty exceeds the safety cap or no solution is found within MAX_ITERATIONS.
 */
export function solveProofOfWork(seed: string, difficulty: number): string {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) {
    throw new Error(`proof-of-work difficulty out of range: ${difficulty}`)
  }
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const nonce = i.toString()
    const digest = sha256Bytes(utf8Encode(`${seed}:${nonce}`))
    if (leadingZeroBits(digest) >= difficulty) {
      return nonce
    }
  }
  throw new Error(`proof-of-work not solved within ${MAX_ITERATIONS} iterations`)
}
