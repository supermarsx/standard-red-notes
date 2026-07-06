import {
  DEFAULT_REGISTRATION_CONFIG,
  isEmailConfirmationGatingMode,
  isRegistrationDomainMode,
  normalizeDomainList,
  RegistrationConfig,
  RegistrationConfigOverlay,
  sanitizeDefaultRole,
} from '../../Domain/Registration/RegistrationConfig'
import { RegistrationConfigResolverInterface } from '../../Domain/Registration/RegistrationConfigResolverInterface'

/**
 * Resolves the effective registration policy by layering the persisted admin
 * overlay (`registration.*`, read from the shared ServerSettings JSON file) on
 * top of the env-derived baseline: persisted -> env -> default.
 *
 * The overlay getter is a thunk so an admin change takes effect on the next
 * registration without a restart. It must never throw; any failure yields the
 * baseline. The resolved config is always VALID: the default role is coerced to
 * a canonical non-admin role (CORE_USER fallback), the mode to a known mode and
 * the domain list is normalized.
 */
export class EnvRegistrationConfigResolver implements RegistrationConfigResolverInterface {
  constructor(
    private baseline: RegistrationConfig,
    private overlayGetter: () => Promise<RegistrationConfigOverlay | undefined>,
  ) {}

  async resolve(): Promise<RegistrationConfig> {
    let overlay: RegistrationConfigOverlay | undefined
    try {
      overlay = await this.overlayGetter()
    } catch {
      overlay = undefined
    }

    const defaultRoleRaw = overlay?.defaultRole ?? this.baseline.defaultRole
    const domainModeRaw = overlay?.domainMode ?? this.baseline.domainMode
    const domainListRaw = overlay?.domainList ?? this.baseline.domainList

    const emailConfirmationEnabledRaw = overlay?.emailConfirmationEnabled ?? this.baseline.emailConfirmationEnabled
    const emailConfirmationGatingRaw = overlay?.emailConfirmationGating ?? this.baseline.emailConfirmationGating
    const emailConfirmationSubjectRaw = overlay?.emailConfirmationSubject ?? this.baseline.emailConfirmationSubject
    const emailConfirmationBodyRaw = overlay?.emailConfirmationBody ?? this.baseline.emailConfirmationBody
    const emailConfirmationBaseUrlRaw = overlay?.emailConfirmationBaseUrl ?? this.baseline.emailConfirmationBaseUrl

    return {
      defaultRole: sanitizeDefaultRole(defaultRoleRaw),
      domainMode: isRegistrationDomainMode(domainModeRaw) ? domainModeRaw : DEFAULT_REGISTRATION_CONFIG.domainMode,
      domainList: normalizeDomainList(domainListRaw),
      emailConfirmationEnabled:
        typeof emailConfirmationEnabledRaw === 'boolean'
          ? emailConfirmationEnabledRaw
          : DEFAULT_REGISTRATION_CONFIG.emailConfirmationEnabled,
      emailConfirmationGating: isEmailConfirmationGatingMode(emailConfirmationGatingRaw)
        ? emailConfirmationGatingRaw
        : DEFAULT_REGISTRATION_CONFIG.emailConfirmationGating,
      emailConfirmationSubject:
        typeof emailConfirmationSubjectRaw === 'string' && emailConfirmationSubjectRaw.trim().length > 0
          ? emailConfirmationSubjectRaw
          : DEFAULT_REGISTRATION_CONFIG.emailConfirmationSubject,
      emailConfirmationBody:
        typeof emailConfirmationBodyRaw === 'string' && emailConfirmationBodyRaw.trim().length > 0
          ? emailConfirmationBodyRaw
          : DEFAULT_REGISTRATION_CONFIG.emailConfirmationBody,
      emailConfirmationBaseUrl:
        typeof emailConfirmationBaseUrlRaw === 'string' ? emailConfirmationBaseUrlRaw.trim() : '',
    }
  }
}

/**
 * Builds the env baseline (REGISTRATION_DEFAULT_ROLE / REGISTRATION_DOMAIN_MODE /
 * REGISTRATION_DOMAINS) into a valid RegistrationConfig, applying the same
 * validation/normalization as the resolver so an invalid env never leaks
 * through. REGISTRATION_DOMAINS is a comma- (or whitespace-) separated list.
 */
export const registrationBaselineFromEnv = (raw: {
  defaultRole?: string
  domainMode?: string
  domains?: string
  emailConfirmationEnabled?: string
  emailConfirmationGating?: string
  emailConfirmationSubject?: string
  emailConfirmationBody?: string
  emailConfirmationBaseUrl?: string
}): RegistrationConfig => ({
  defaultRole: sanitizeDefaultRole(raw.defaultRole && raw.defaultRole.trim() !== '' ? raw.defaultRole.trim() : undefined),
  domainMode: isRegistrationDomainMode(raw.domainMode) ? raw.domainMode : DEFAULT_REGISTRATION_CONFIG.domainMode,
  domainList: normalizeDomainList((raw.domains ?? '').split(/[\s,]+/)),
  // REGISTRATION_EMAIL_CONFIRMATION is opt-in: only the exact string 'true'
  // enables it, so any other/absent value keeps the feature OFF (default).
  emailConfirmationEnabled: raw.emailConfirmationEnabled === 'true',
  emailConfirmationGating: isEmailConfirmationGatingMode(raw.emailConfirmationGating)
    ? raw.emailConfirmationGating
    : DEFAULT_REGISTRATION_CONFIG.emailConfirmationGating,
  emailConfirmationSubject:
    raw.emailConfirmationSubject && raw.emailConfirmationSubject.trim() !== ''
      ? raw.emailConfirmationSubject
      : DEFAULT_REGISTRATION_CONFIG.emailConfirmationSubject,
  emailConfirmationBody:
    raw.emailConfirmationBody && raw.emailConfirmationBody.trim() !== ''
      ? raw.emailConfirmationBody
      : DEFAULT_REGISTRATION_CONFIG.emailConfirmationBody,
  emailConfirmationBaseUrl: (raw.emailConfirmationBaseUrl ?? '').trim(),
})
