import * as crypto from 'crypto'

/**
 * Standard Red Notes: privacy-preserving proof-of-work (hashcash-style) helper.
 *
 * A challenge is a random `seed`. A client "solves" it by finding a `nonce`
 * such that SHA-256(`${seed}:${nonce}`) has at least `difficulty` leading zero
 * BITS. Verification is a single cheap hash, so the server does no meaningful
 * work while the client is forced to burn ~2^difficulty hashes on average. This
 * is a fully self-hosted, third-party-free alternative to a CAPTCHA.
 */

export const PROOF_OF_WORK_ALGORITHM = 'sha256-leading-zero-bits'

/**
 * Counts the number of leading zero bits in a hex-encoded digest.
 */
export function countLeadingZeroBits(hexDigest: string): number {
  let bits = 0
  for (const char of hexDigest) {
    const nibble = parseInt(char, 16)
    if (Number.isNaN(nibble)) {
      break
    }
    if (nibble === 0) {
      bits += 4
      continue
    }
    // Leading zeros within this non-zero nibble (0-3), then stop.
    if (nibble < 2) {
      bits += 3
    } else if (nibble < 4) {
      bits += 2
    } else if (nibble < 8) {
      bits += 1
    }
    break
  }

  return bits
}

/**
 * Returns true when `nonce` solves `seed` at the requested difficulty.
 * Any non-string input, or a difficulty <= 0, is treated conservatively:
 * difficulty <= 0 means "no work required" (returns true), so callers must gate
 * on whether proof-of-work is enabled BEFORE calling this.
 */
export function proofOfWorkSolutionMeetsDifficulty(seed: string, nonce: string, difficulty: number): boolean {
  if (typeof seed !== 'string' || typeof nonce !== 'string') {
    return false
  }
  if (difficulty <= 0) {
    return true
  }

  const digest = crypto.createHash('sha256').update(`${seed}:${nonce}`).digest('hex')

  return countLeadingZeroBits(digest) >= difficulty
}
