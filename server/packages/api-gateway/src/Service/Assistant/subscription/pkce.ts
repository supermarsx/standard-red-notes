import * as crypto from 'crypto'

/**
 * PKCE (RFC 7636) + OAuth state helpers for the "Pair ChatGPT / Codex
 * subscription" flow.
 *
 * All values are high-entropy random secrets produced with Node's crypto and
 * encoded base64url (URL-safe, no padding) so they can travel in query strings.
 * The verifier NEVER leaves the server; only the S256 challenge is sent to the
 * authorize endpoint. Nothing here is ever logged by callers.
 */

// RFC 7636 allows a verifier of 43..128 characters. 32 random bytes base64url
// encode to 43 characters, comfortably inside the range with 256 bits of entropy.
const VERIFIER_BYTES = 32
const STATE_BYTES = 32

/** A fresh PKCE code verifier (base64url, 43 chars, kept server-side only). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(VERIFIER_BYTES).toString('base64url')
}

/**
 * The S256 code challenge for a verifier: base64url(SHA-256(verifier)).
 * Deterministic — the same verifier always yields the same challenge.
 */
export function codeChallengeS256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

/** An unguessable single-use OAuth `state` value (CSRF proof, base64url). */
export function generateState(): string {
  return crypto.randomBytes(STATE_BYTES).toString('base64url')
}
