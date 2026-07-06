import { RegistrationConfig } from './RegistrationConfig'

/**
 * Resolves the effective registration policy (default role + email-domain
 * policy) for the current registration. Implementations MUST apply persisted
 * (admin) overrides on top of the env baseline (persisted -> env -> default),
 * MUST return a validated config (canonical non-admin default role, a valid
 * domain mode and a normalized domain list) and MUST never throw.
 */
export interface RegistrationConfigResolverInterface {
  resolve(): Promise<RegistrationConfig>
}
