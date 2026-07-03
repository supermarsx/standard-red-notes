/**
 * Standard Red Notes: platform solver for the privacy-preserving proof-of-work
 * anti-bot challenge.
 *
 * The auth server issues a challenge inside the error response of a
 * register / sign-in-params request (error tag `proof-of-work-required`, with a
 * `{ seed, difficulty, algorithm }` payload). The client must find a `nonce`
 * such that SHA-256(`${seed}:${nonce}`) has at least `difficulty` leading zero
 * bits, then resubmit the original request with the seed + nonce attached.
 *
 * The actual solve is CPU-bound and platform-specific (the web/desktop build
 * runs it in a Web Worker so the UI never blocks), so SessionManager depends on
 * this interface rather than a concrete solver. When no solver is registered
 * (e.g. a platform that has not wired one up), the proof-of-work error is simply
 * surfaced to the caller unchanged — which is safe because a stock server never
 * requires a proof (the feature is opt-in, disabled by default).
 */
export interface ProofOfWorkSolverInterface {
  /**
   * Resolve a `nonce` that solves the given challenge. Rejects if the algorithm
   * is unsupported or a solution cannot be found (e.g. difficulty over the
   * client's safety cap); the caller treats a rejection as "could not solve" and
   * surfaces a clear error rather than retrying forever.
   */
  solve(seed: string, difficulty: number, algorithm: string): Promise<string>
}
