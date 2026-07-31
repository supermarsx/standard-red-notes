import { valid } from 'semver'

export const SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD = '0.0.0'

export type CrossServiceTokenVersionConfig = Readonly<{
  version2Threshold: string
  version3Threshold: string
  defaultedConfigurationKeys: string[]
}>

function resolveThreshold(value: string | undefined): { threshold: string; defaulted: boolean } {
  const normalized = value === undefined ? null : valid(value.trim())

  return normalized === null
    ? { threshold: SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD, defaulted: true }
    : { threshold: normalized, defaulted: false }
}

/**
 * High-risk account operations use the cross-service token version to decide
 * whether a client can provide password and TOTP step-up proof. Missing or
 * malformed thresholds must therefore never silently downgrade every session
 * to a legacy token.
 */
export function resolveCrossServiceTokenVersionConfig(
  version2Threshold: string | undefined,
  version3Threshold: string | undefined,
): CrossServiceTokenVersionConfig {
  const version2 = resolveThreshold(version2Threshold)
  const version3 = resolveThreshold(version3Threshold)
  const defaultedConfigurationKeys: string[] = []

  if (version2.defaulted) {
    defaultedConfigurationKeys.push('APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2')
  }
  if (version3.defaulted) {
    defaultedConfigurationKeys.push('APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3')
  }

  return {
    version2Threshold: version2.threshold,
    version3Threshold: version3.threshold,
    defaultedConfigurationKeys,
  }
}
