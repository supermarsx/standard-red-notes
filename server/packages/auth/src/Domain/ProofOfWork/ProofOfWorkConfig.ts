/**
 * Standard Red Notes: proof-of-work configuration, resolved per request so that
 * an admin toggle (persisted overlay) takes effect without a restart, falling
 * back to env then to a sane default (persisted -> env -> default), mirroring
 * the existing ServerSettings precedence.
 */

export type ProofOfWorkSignInMode = 'always' | 'adaptive'

export interface ProofOfWorkScopeConfig {
  enabled: boolean
  /** Required leading zero BITS of SHA-256(seed:nonce). */
  difficulty: number
  /** How long an issued challenge remains solvable/consumable, in seconds. */
  ttlSeconds: number
}

export interface ProofOfWorkSignInConfig extends ProofOfWorkScopeConfig {
  /**
   * 'always' requires a solved challenge on every sign-in params request.
   * 'adaptive' only requires one once the account has accumulated
   * `adaptiveThreshold` failed login attempts (reusing the existing lock
   * counter that already drives the CAPTCHA escalation).
   */
  mode: ProofOfWorkSignInMode
  adaptiveThreshold: number
}

export interface ProofOfWorkConfig {
  register: ProofOfWorkScopeConfig
  signIn: ProofOfWorkSignInConfig
}

export type ProofOfWorkScope = 'register' | 'signIn'

/**
 * Partial admin overrides read from the persisted ServerSettings overlay
 * (`security.proofOfWork.*`). Any field left undefined falls back to the env
 * baseline / default. Field names mirror the persisted JSON contract shared
 * with the api-gateway admin surface.
 */
export interface ProofOfWorkOverlay {
  registerEnabled?: boolean
  registerDifficulty?: number
  signInEnabled?: boolean
  signInMode?: ProofOfWorkSignInMode
  signInDifficulty?: number
  signInAdaptiveThreshold?: number
}
