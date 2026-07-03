import { ProofOfWorkConfig } from './ProofOfWorkConfig'

/**
 * Resolves the effective proof-of-work configuration for the current request.
 * Implementations MUST apply persisted (admin) overrides on top of the env
 * baseline (persisted -> env -> default) and MUST never throw.
 */
export interface ProofOfWorkConfigResolverInterface {
  resolve(): Promise<ProofOfWorkConfig>
}
