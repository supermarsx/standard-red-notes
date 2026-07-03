import { ProofOfWorkConfig, ProofOfWorkOverlay } from '../../Domain/ProofOfWork/ProofOfWorkConfig'
import { ProofOfWorkConfigResolverInterface } from '../../Domain/ProofOfWork/ProofOfWorkConfigResolverInterface'

const MAX_DIFFICULTY = 32

const clampDifficulty = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0
  }

  return Math.min(MAX_DIFFICULTY, Math.max(0, Math.floor(value)))
}

/**
 * Resolves the effective proof-of-work configuration by layering the persisted
 * admin overlay (`security.proofOfWork.*`, read from the shared ServerSettings
 * JSON file) on top of the env-derived baseline: persisted -> env -> default.
 *
 * The overlay getter is a thunk so an admin change takes effect on the next
 * request without a restart. It must never throw; any failure yields the
 * baseline. This class also never throws.
 */
export class EnvProofOfWorkConfigResolver implements ProofOfWorkConfigResolverInterface {
  constructor(
    private baseline: ProofOfWorkConfig,
    private overlayGetter: () => Promise<ProofOfWorkOverlay | undefined>,
  ) {}

  async resolve(): Promise<ProofOfWorkConfig> {
    let overlay: ProofOfWorkOverlay | undefined
    try {
      overlay = await this.overlayGetter()
    } catch {
      overlay = undefined
    }

    const config: ProofOfWorkConfig = {
      register: {
        enabled: this.baseline.register.enabled,
        difficulty: this.baseline.register.difficulty,
        ttlSeconds: this.baseline.register.ttlSeconds,
      },
      signIn: {
        enabled: this.baseline.signIn.enabled,
        difficulty: this.baseline.signIn.difficulty,
        ttlSeconds: this.baseline.signIn.ttlSeconds,
        mode: this.baseline.signIn.mode,
        adaptiveThreshold: this.baseline.signIn.adaptiveThreshold,
      },
    }

    if (overlay) {
      if (typeof overlay.registerEnabled === 'boolean') {
        config.register.enabled = overlay.registerEnabled
      }
      if (typeof overlay.registerDifficulty === 'number') {
        config.register.difficulty = clampDifficulty(overlay.registerDifficulty)
      }
      if (typeof overlay.signInEnabled === 'boolean') {
        config.signIn.enabled = overlay.signInEnabled
      }
      if (overlay.signInMode === 'always' || overlay.signInMode === 'adaptive') {
        config.signIn.mode = overlay.signInMode
      }
      if (typeof overlay.signInDifficulty === 'number') {
        config.signIn.difficulty = clampDifficulty(overlay.signInDifficulty)
      }
      if (typeof overlay.signInAdaptiveThreshold === 'number' && !Number.isNaN(overlay.signInAdaptiveThreshold)) {
        config.signIn.adaptiveThreshold = Math.max(0, Math.floor(overlay.signInAdaptiveThreshold))
      }
    }

    return config
  }
}
