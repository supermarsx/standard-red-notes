import { AssistantProviderConfig } from '../Assistant/providers/factory'
import { openAiCompatibleConfigured } from '../Assistant/providers/openaiAuth'
import {
  AssistantProfileAssignments,
  effectiveBackendProfiles,
  effectiveProfiles,
  MaskedAiProfile,
  MaskedBackendProfile,
  maskBackendProfiles,
  maskProfiles,
  PersistedAiProfile,
  PersistedBackendProfile,
  resolveAssignedProfileId,
  resolveEffectiveAssistantProfile,
  selectActiveProfile,
} from '../Assistant/profiles'
import { PersistedServerSettings, ServerSettingsPatch, ServerSettingsStore } from './ServerSettingsStore'

/**
 * Standard Red Notes: the single read path for runtime-configurable server
 * settings. PRECEDENCE (documented contract): persisted (admin-set via
 * PUT /v1/admin/server-settings) WINS over env; env is the fallback; hardcoded
 * defaults apply last.
 *
 * Every `resolve*` method re-reads the persisted store, so consumers that call
 * through here per request/use pick up admin changes WITHOUT a restart. The
 * env baseline is captured once at boot (env vars cannot change mid-process
 * anyway).
 */

export type ServerSettingSource = 'persisted' | 'env' | 'default'

export interface EnvSettingsBaseline {
  /** The env-derived assistant provider config (ASSISTANT_* vars). */
  assistant: AssistantProviderConfig
  /** ASSISTANT_DAILY_REQUEST_LIMIT; undefined when the env var is unset. */
  assistantDailyRequestLimit?: number
  /** ASSISTANT_5H_TOKEN_LIMIT; undefined when unset. 0 = unlimited. */
  assistantFiveHourTokenLimit?: number
  /** ASSISTANT_WEEKLY_TOKEN_LIMIT; undefined when unset. 0 = unlimited. */
  assistantWeeklyTokenLimit?: number
  /** UPDATE_CHECK_URL; undefined when unset. */
  updateCheckUrl?: string
  /**
   * NEXTCLOUD_BACKUPS_ENABLED as visible to the gateway process; undefined when
   * unset. In the single-container image every service shares the container
   * environment, so the gateway sees the same operator env the auth service
   * reads. Enforcement of the gate stays auth-side (see the auth package's
   * TriggerNextcloudBackupForAllUsers, which reads the SAME persisted overlay
   * file via SERVER_SETTINGS_PATH); this value only feeds the admin view.
   */
  nextcloudBackupsEnabled?: boolean
  /**
   * Standard Red Notes: PROOF-OF-WORK anti-bot env baseline (PROOF_OF_WORK_*).
   * The gateway PERSISTS + VIEWS these; the auth server ENFORCES them by reading
   * the same overlay file. undefined = env var unset (falls through to default).
   */
  proofOfWorkRegisterEnabled?: boolean
  proofOfWorkRegisterDifficulty?: number
  proofOfWorkSignInEnabled?: boolean
  proofOfWorkSignInMode?: 'always' | 'adaptive'
  proofOfWorkSignInDifficulty?: number
  proofOfWorkSignInAdaptiveThreshold?: number
  /**
   * Standard Red Notes: RATE-LIMIT env baseline (RATE_LIMIT_*). Unlike PoW/
   * registration these are enforced BY the gateway (RateLimitMiddleware). The
   * resolver merges persisted admin values over these, over the hardcoded safe
   * defaults. undefined = env var unset (falls through to default).
   */
  rateLimitEnabled?: boolean
  rateLimitWindowSeconds?: number
  rateLimitLoginMax?: number
  rateLimitRegistrationMax?: number
  rateLimitUserWindowSeconds?: number
  rateLimitUserMax?: number
  rateLimitAdaptiveEscalation?: boolean
  /**
   * Standard Red Notes: REGISTRATION policy env baseline (REGISTRATION_DEFAULT_ROLE
   * / REGISTRATION_DOMAIN_MODE / REGISTRATION_DOMAINS). The gateway PERSISTS +
   * VIEWS these; the auth server ENFORCES them by reading the same overlay file.
   * undefined = env var unset (falls through to default).
   */
  registrationDefaultRole?: string
  registrationDomainMode?: RegistrationDomainMode
  registrationDomains?: string[]
  /**
   * Standard Red Notes: EMAIL CONFIRMATION env baseline. The gateway persists +
   * views these; the auth server reads the SAME overlay and enforces them.
   * undefined = env var unset (falls through to default).
   */
  registrationEmailConfirmationEnabled?: boolean
  registrationEmailConfirmationGating?: EmailConfirmationGatingMode
  registrationEmailConfirmationSubject?: string
  registrationEmailConfirmationBody?: string
  registrationEmailConfirmationBaseUrl?: string
  /**
   * Standard Red Notes: OCR env baseline. serverEnabled/defaultLanguage/maxPages/
   * maxImageBytes drive the SERVER-side /v1/ocr endpoint (gateway-enforced,
   * runtime). clientEnabled/clientDefaultLanguage mirror the BROWSER-OCR
   * OCR_ENABLED / OCR_DEFAULT_LANGUAGE (in the single-container image the gateway
   * shares the operator env, so it reads them as the baseline). undefined = unset.
   */
  ocrServerEnabled?: boolean
  ocrDefaultLanguage?: string
  ocrMaxPages?: number
  ocrMaxImageBytes?: number
  ocrClientEnabled?: boolean
  ocrClientDefaultLanguage?: string
  /**
   * Standard Red Notes: WORKFLOWS (n8n) env baseline. enabled/n8nUrl/uiTokenTtl
   * are read through the resolver per request (runtime); uiBasePath is the boot-
   * bound Express mount path (restart to change). undefined = env var unset.
   */
  workflowsEnabled?: boolean
  workflowsN8nUrl?: string
  workflowsUiBasePath?: string
  workflowsUiTokenTtlSeconds?: number
}

export type RegistrationDomainMode = 'off' | 'allowlist' | 'blocklist'

export type EmailConfirmationGatingMode = 'block_signin' | 'warn'

export const EMAIL_CONFIRMATION_GATING_MODES: EmailConfirmationGatingMode[] = ['block_signin', 'warn']

/**
 * Default confirmation-email templates. MUST match the auth server's
 * DEFAULT_EMAIL_CONFIRMATION_* (RegistrationConfig.ts) so the admin VIEW matches
 * what auth will actually send when no override is persisted.
 */
export const DEFAULT_EMAIL_CONFIRMATION_SUBJECT = 'Confirm your email address'
export const DEFAULT_EMAIL_CONFIRMATION_BODY =
  'Welcome! Please confirm your email address by opening the link below:\n\n' +
  '{{confirmation_url}}\n\n' +
  'This link expires in 24 hours. If you did not create this account you can ignore this email.'

/** Default-role choices a NEW signup may be given (never the admin role). */
export const REGISTRATION_ASSIGNABLE_ROLES = ['CORE_USER', 'PRO_USER', 'VAULTS_USER']

export interface ResolvedRegistrationConfig {
  defaultRole: string
  domainMode: RegistrationDomainMode
  domainList: string[]
  emailConfirmationEnabled: boolean
  emailConfirmationGating: EmailConfirmationGatingMode
  emailConfirmationSubject: string
  emailConfirmationBody: string
  emailConfirmationBaseUrl: string
}

/** Hardcoded registration defaults (apply last, after persisted then env). */
const REGISTRATION_DEFAULTS: ResolvedRegistrationConfig = {
  defaultRole: 'CORE_USER',
  domainMode: 'off',
  domainList: [],
  emailConfirmationEnabled: false,
  emailConfirmationGating: 'block_signin',
  emailConfirmationSubject: DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  emailConfirmationBody: DEFAULT_EMAIL_CONFIRMATION_BODY,
  emailConfirmationBaseUrl: '',
}

/**
 * The fully-resolved PoW config (persisted -> env -> default), every field
 * populated. Mirrors the persisted contract the auth server reads.
 */
export interface ResolvedProofOfWorkConfig {
  registerEnabled: boolean
  registerDifficulty: number
  signInEnabled: boolean
  signInMode: 'always' | 'adaptive'
  signInDifficulty: number
  signInAdaptiveThreshold: number
}

/**
 * Hardcoded PoW defaults (apply last, after persisted then env). Both scopes
 * default to DISABLED so this admin view matches the auth server's enforcement
 * default (see auth Container): a stock deploy requires no proof and can never
 * lock out a client that attaches none. An admin opts in per scope.
 */
const PROOF_OF_WORK_DEFAULTS: ResolvedProofOfWorkConfig = {
  registerEnabled: false,
  registerDifficulty: 12,
  signInEnabled: false,
  signInMode: 'adaptive',
  signInDifficulty: 16,
  signInAdaptiveThreshold: 3,
}

/**
 * The fully-resolved RATE-LIMIT config (persisted -> env -> default). Consumed by
 * the gateway RateLimitMiddleware per request.
 */
export interface ResolvedRateLimitConfig {
  enabled: boolean
  windowSeconds: number
  loginMax: number
  registrationMax: number
  userWindowSeconds: number
  userMax: number
  adaptiveEscalation: boolean
}

/**
 * Hardcoded RATE-LIMIT defaults (apply last). These EXACTLY reproduce the
 * historical hardcoded behavior (window 60s, login 10, registration 5) so a
 * stock deploy is unchanged until an admin edits. The per-user tier is OFF by
 * default (userMax 0), and adaptive escalation is off.
 */
const RATE_LIMIT_DEFAULTS: ResolvedRateLimitConfig = {
  enabled: true,
  windowSeconds: 60,
  loginMax: 10,
  registrationMax: 5,
  userWindowSeconds: 60,
  userMax: 0,
  adaptiveEscalation: false,
}

/**
 * The fully-resolved OCR config (persisted → env → default). serverEnabled +
 * defaultLanguage + bounds drive the gateway's server-side OCR endpoint;
 * clientEnabled + clientDefaultLanguage are the browser-OCR intent surfaced via
 * GET /v1/ocr/config.
 */
export interface ResolvedOcrConfig {
  serverEnabled: boolean
  defaultLanguage: string
  maxPages: number
  maxImageBytes: number
  clientEnabled: boolean
  clientDefaultLanguage: string
}

/**
 * Hardcoded OCR defaults (apply last). These EXACTLY reproduce the historical
 * hardcoded behavior (server OCR + browser OCR both OFF, language 'eng', 50 pages,
 * 12 MiB per page image) so a stock deploy is unchanged until an admin edits.
 */
const OCR_DEFAULTS: ResolvedOcrConfig = {
  serverEnabled: false,
  defaultLanguage: 'eng',
  maxPages: 50,
  maxImageBytes: 12 * 1024 * 1024,
  clientEnabled: false,
  clientDefaultLanguage: 'eng',
}

/** The fully-resolved WORKFLOWS (n8n) config (persisted → env → default). */
export interface ResolvedWorkflowsConfig {
  enabled: boolean
  n8nUrl: string
  uiBasePath: string
  uiTokenTtlSeconds: number
}

/**
 * Hardcoded WORKFLOWS defaults (apply last). Reproduce the historical hardcoded
 * behavior: feature OFF, internal n8n at http://n8n:5678, editor proxy mounted at
 * /workflows-ui, 12-hour editor cookie.
 */
const WORKFLOWS_DEFAULTS: ResolvedWorkflowsConfig = {
  enabled: false,
  n8nUrl: 'http://n8n:5678',
  uiBasePath: '/workflows-ui',
  uiTokenTtlSeconds: 12 * 60 * 60,
}

/**
 * The tesseract language alphabet (e.g. 'eng', 'eng+deu', 'chi_sim'). A persisted/
 * env value that does not match is ignored so a bad code can never poison the OCR
 * worker or the browser-OCR download path — the caller falls through to default.
 */
const OCR_LANGUAGE_PATTERN = /^[a-zA-Z]{2,}([_+][a-zA-Z]{2,})*$/
const validOcrLanguage = (value: string | undefined): string | undefined =>
  typeof value === 'string' && OCR_LANGUAGE_PATTERN.test(value.trim()) ? value.trim() : undefined

/** Clamp an integer-ish overlay/env value into [min, max]; undefined passes through. */
const boundedInt = (value: number | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const int = Math.floor(value)
  if (int < min) {
    return min
  }
  if (int > max) {
    return max
  }

  return int
}

/**
 * Normalizes a registration domain list the same way the auth server does
 * (lowercase, trim, strip a leading '@'/'.', drop empties, de-dupe) so the admin
 * VIEW matches exactly what auth will enforce.
 */
export const normalizeRegistrationDomains = (list: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') {
      continue
    }
    const normalized = raw.trim().toLowerCase().replace(/^[@.]+/, '')
    if (normalized.length === 0 || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

/** The masked admin view returned by GET/PUT /v1/admin/server-settings. */
export interface ServerSettingsView {
  settings: {
    ai: {
      anthropicConfigured: boolean
      openaiConfigured: boolean
      openaiBaseUrl: string | null
      ollamaUrl: string | null
      dailyRequestLimit: number | null
      /** Per-user rolling-window TOKEN limits (0/unset = unlimited). */
      fiveHourTokenLimit: number | null
      weeklyTokenLimit: number | null
      subscriptionMode: string | null
      /** Masked named profiles (secrets replaced by keyConfigured booleans). */
      profiles: MaskedAiProfile[]
      /** Id of the active/default profile, or null when none is set. */
      defaultProfileId: string | null
      /** Masked backend (provider/connection) profiles the profiles reference. */
      backendProfiles: MaskedBackendProfile[]
      /** Assistant-profile assignments (user/role -> profile id). */
      assignments: AssistantProfileAssignments
    }
    updateCheck: { url: string | null }
    nextcloudBackups: { enabled: boolean }
    security: { proofOfWork: ResolvedProofOfWorkConfig; rateLimit: ResolvedRateLimitConfig }
    registration: ResolvedRegistrationConfig & {
      assignableRoles: string[]
      gatingModes: EmailConfirmationGatingMode[]
    }
    ocr: ResolvedOcrConfig
    workflows: ResolvedWorkflowsConfig
  }
  sources: Record<string, ServerSettingSource>
}

export class ServerSettingsResolver {
  constructor(
    private readonly store: ServerSettingsStore,
    private readonly envBaseline: EnvSettingsBaseline,
  ) {}

  /** Pass-through so route handlers only need the resolver injected. */
  async applyPatch(patch: ServerSettingsPatch): Promise<void> {
    await this.store.update(patch)
  }

  /**
   * The effective assistant provider config: env baseline with the persisted
   * overlay applied on top. Re-read per call so key/URL/limit changes take
   * effect on the next request without a restart.
   */
  async resolveAssistantConfig(): Promise<AssistantProviderConfig> {
    const persisted = await this.safeRead()
    const ai = persisted.ai ?? {}

    return {
      ...this.envBaseline.assistant,
      ...(ai.anthropicApiKey !== undefined ? { anthropicApiKey: ai.anthropicApiKey } : {}),
      ...(ai.openaiApiKey !== undefined ? { openaiApiKey: ai.openaiApiKey } : {}),
      ...(ai.openaiBaseUrl !== undefined ? { openaiBaseURL: ai.openaiBaseUrl } : {}),
      ...(ai.ollamaUrl !== undefined ? { ollamaUrl: ai.ollamaUrl } : {}),
    }
  }

  /**
   * The effective named-profile set + default id: explicit persisted profiles
   * win; otherwise the effective legacy single-provider config is mapped into
   * synthesized default profiles (back-compat). Re-read per call.
   */
  async resolveAssistantProfiles(): Promise<{ profiles: PersistedAiProfile[]; defaultProfileId: string | undefined }> {
    const persisted = await this.safeRead()
    const legacyConfig = await this.resolveAssistantConfig()

    return effectiveProfiles(persisted.ai?.profiles, persisted.ai?.defaultProfileId, legacyConfig)
  }

  /**
   * The RAW persisted profiles (not legacy-mapped). Used by the settings PUT
   * validator to preserve a profile's write-only key when the UI resubmits the
   * profile without resending its secret.
   */
  async getPersistedAiProfiles(): Promise<PersistedAiProfile[] | undefined> {
    return (await this.safeRead()).ai?.profiles
  }

  /**
   * The effective backend-profile set: explicit persisted backend profiles win;
   * otherwise they are synthesized from the effective assistant profiles so an
   * embedded-only (legacy) deployment resolves unchanged. Re-read per call.
   */
  async resolveBackendProfiles(): Promise<PersistedBackendProfile[]> {
    const persisted = await this.safeRead()
    const { profiles } = await this.resolveAssistantProfiles()

    return effectiveBackendProfiles(persisted.ai?.backendProfiles, profiles)
  }

  /**
   * The RAW persisted backend profiles (not synthesized). Used by the settings
   * PUT validator to preserve a backend's write-only key on resubmit.
   */
  async getPersistedBackendProfiles(): Promise<PersistedBackendProfile[] | undefined> {
    return (await this.safeRead()).ai?.backendProfiles
  }

  /** The persisted assistant-profile assignments (user/role -> profile id). */
  async resolveAssignments(): Promise<AssistantProfileAssignments | undefined> {
    return (await this.safeRead()).ai?.assignments
  }

  /**
   * Selects the active profile for a request and merges its referenced backend
   * profile (provider/connection/credential) on top. When `principal` is given,
   * the effective DEFAULT is resolved from the assignments with precedence
   * USER > ROLE > server default (an explicit `requestedId` from the client still
   * wins over that default, mirroring the pre-existing selection behavior).
   */
  async resolveActiveProfile(
    requestedId?: string,
    principal?: { userIdentifiers?: string[]; roleNames?: string[] },
  ): Promise<PersistedAiProfile | undefined> {
    const { profiles, defaultProfileId } = await this.resolveAssistantProfiles()
    const backendProfiles = effectiveBackendProfiles((await this.safeRead()).ai?.backendProfiles, profiles)

    const effectiveDefaultId = principal
      ? resolveAssignedProfileId(
          await this.resolveAssignments(),
          defaultProfileId,
          principal.userIdentifiers ?? [],
          principal.roleNames ?? [],
          profiles,
        )
      : defaultProfileId

    const selected = selectActiveProfile(profiles, effectiveDefaultId, requestedId)

    return selected ? resolveEffectiveAssistantProfile(selected, backendProfiles) : undefined
  }

  /** Effective global daily AI request ceiling. 0 = unlimited (the default). */
  async resolveAssistantDailyRequestLimit(): Promise<number> {
    const persisted = await this.safeRead()

    return persisted.ai?.dailyRequestLimit ?? this.envBaseline.assistantDailyRequestLimit ?? 0
  }

  /**
   * Effective per-user rolling-window TOKEN limits. Persisted admin values win
   * over the ASSISTANT_5H_TOKEN_LIMIT / ASSISTANT_WEEKLY_TOKEN_LIMIT env vars;
   * 0 (the default) means the window is unlimited. Re-read per request.
   */
  async resolveAssistantTokenLimits(): Promise<{ fiveHour: number; weekly: number }> {
    const persisted = (await this.safeRead()).ai ?? {}

    return {
      fiveHour: persisted.fiveHourTokenLimit ?? this.envBaseline.assistantFiveHourTokenLimit ?? 0,
      weekly: persisted.weeklyTokenLimit ?? this.envBaseline.assistantWeeklyTokenLimit ?? 0,
    }
  }

  /** Effective UPDATE_CHECK_URL; undefined = feature not configured. */
  async resolveUpdateCheckUrl(): Promise<string | undefined> {
    const persisted = await this.safeRead()

    return persisted.updateCheck?.url ?? this.envBaseline.updateCheckUrl
  }

  /** Effective Nextcloud-backups master gate (gateway-side VIEW; default OFF). */
  async resolveNextcloudBackupsEnabled(): Promise<boolean> {
    const persisted = await this.safeRead()

    return persisted.nextcloudBackups?.enabled ?? this.envBaseline.nextcloudBackupsEnabled ?? false
  }

  /**
   * The effective PROOF-OF-WORK anti-bot config: persisted admin values win over
   * the PROOF_OF_WORK_* env baseline, which falls back to hardcoded defaults.
   * Re-read per call so admin changes take effect without a restart. NOTE: the
   * gateway does not enforce PoW — the auth server reads the same persisted
   * overlay and gates register/sign-in; this method feeds the admin view.
   */
  async resolveProofOfWorkConfig(): Promise<ResolvedProofOfWorkConfig> {
    const pow = (await this.safeRead()).security?.proofOfWork ?? {}
    const env = this.envBaseline

    return {
      registerEnabled: pow.registerEnabled ?? env.proofOfWorkRegisterEnabled ?? PROOF_OF_WORK_DEFAULTS.registerEnabled,
      registerDifficulty:
        pow.registerDifficulty ?? env.proofOfWorkRegisterDifficulty ?? PROOF_OF_WORK_DEFAULTS.registerDifficulty,
      signInEnabled: pow.signInEnabled ?? env.proofOfWorkSignInEnabled ?? PROOF_OF_WORK_DEFAULTS.signInEnabled,
      signInMode: pow.signInMode ?? env.proofOfWorkSignInMode ?? PROOF_OF_WORK_DEFAULTS.signInMode,
      signInDifficulty:
        pow.signInDifficulty ?? env.proofOfWorkSignInDifficulty ?? PROOF_OF_WORK_DEFAULTS.signInDifficulty,
      signInAdaptiveThreshold:
        pow.signInAdaptiveThreshold ??
        env.proofOfWorkSignInAdaptiveThreshold ??
        PROOF_OF_WORK_DEFAULTS.signInAdaptiveThreshold,
    }
  }

  /**
   * The effective RATE-LIMIT config: persisted admin values win over the
   * RATE_LIMIT_* env baseline, which falls back to the hardcoded safe defaults
   * (which reproduce the historical hardcoded behavior). Re-read per request so
   * admin changes take effect without a restart. Integer knobs are clamped to
   * sane bounds so a bad value can never disable protection unexpectedly.
   */
  async resolveRateLimitConfig(): Promise<ResolvedRateLimitConfig> {
    const rl = (await this.safeRead()).security?.rateLimit ?? {}
    const env = this.envBaseline
    const d = RATE_LIMIT_DEFAULTS

    const pick = (
      persisted: number | undefined,
      envValue: number | undefined,
      fallback: number,
      min: number,
      max: number,
    ): number => boundedInt(persisted, min, max) ?? boundedInt(envValue, min, max) ?? fallback

    return {
      enabled:
        typeof rl.enabled === 'boolean' ? rl.enabled : env.rateLimitEnabled ?? d.enabled,
      windowSeconds: pick(rl.windowSeconds, env.rateLimitWindowSeconds, d.windowSeconds, 1, 3600),
      loginMax: pick(rl.loginMax, env.rateLimitLoginMax, d.loginMax, 0, 100000),
      registrationMax: pick(rl.registrationMax, env.rateLimitRegistrationMax, d.registrationMax, 0, 100000),
      userWindowSeconds: pick(rl.userWindowSeconds, env.rateLimitUserWindowSeconds, d.userWindowSeconds, 1, 3600),
      userMax: pick(rl.userMax, env.rateLimitUserMax, d.userMax, 0, 100000),
      adaptiveEscalation:
        typeof rl.adaptiveEscalation === 'boolean'
          ? rl.adaptiveEscalation
          : env.rateLimitAdaptiveEscalation ?? d.adaptiveEscalation,
    }
  }

  /**
   * The effective REGISTRATION policy: persisted admin values win over the
   * REGISTRATION_* env baseline, which falls back to hardcoded defaults. The
   * default role is coerced to an assignable (canonical non-admin) role; the mode
   * to a known mode; the list normalized (lowercased/trimmed/de-duped). Re-read
   * per call. NOTE: the gateway does not enforce this — the auth server reads the
   * same overlay and gates registration; this method feeds the admin view.
   */
  async resolveRegistrationConfig(): Promise<ResolvedRegistrationConfig> {
    const registration = (await this.safeRead()).registration ?? {}
    const env = this.envBaseline

    const rawRole = registration.defaultRole ?? env.registrationDefaultRole ?? REGISTRATION_DEFAULTS.defaultRole
    const rawMode = registration.domainMode ?? env.registrationDomainMode ?? REGISTRATION_DEFAULTS.domainMode
    const rawList = registration.domainList ?? env.registrationDomains ?? REGISTRATION_DEFAULTS.domainList

    const rawEnabled =
      registration.emailConfirmationEnabled ??
      env.registrationEmailConfirmationEnabled ??
      REGISTRATION_DEFAULTS.emailConfirmationEnabled
    const rawGating =
      registration.emailConfirmationGating ??
      env.registrationEmailConfirmationGating ??
      REGISTRATION_DEFAULTS.emailConfirmationGating
    const rawSubject =
      registration.emailConfirmationSubject ??
      env.registrationEmailConfirmationSubject ??
      REGISTRATION_DEFAULTS.emailConfirmationSubject
    const rawBody =
      registration.emailConfirmationBody ??
      env.registrationEmailConfirmationBody ??
      REGISTRATION_DEFAULTS.emailConfirmationBody
    const rawBaseUrl =
      registration.emailConfirmationBaseUrl ??
      env.registrationEmailConfirmationBaseUrl ??
      REGISTRATION_DEFAULTS.emailConfirmationBaseUrl

    return {
      defaultRole: REGISTRATION_ASSIGNABLE_ROLES.includes(rawRole) ? rawRole : REGISTRATION_DEFAULTS.defaultRole,
      domainMode: (['off', 'allowlist', 'blocklist'] as string[]).includes(rawMode)
        ? (rawMode as RegistrationDomainMode)
        : REGISTRATION_DEFAULTS.domainMode,
      domainList: normalizeRegistrationDomains(rawList),
      emailConfirmationEnabled: typeof rawEnabled === 'boolean' ? rawEnabled : REGISTRATION_DEFAULTS.emailConfirmationEnabled,
      emailConfirmationGating: EMAIL_CONFIRMATION_GATING_MODES.includes(rawGating as EmailConfirmationGatingMode)
        ? (rawGating as EmailConfirmationGatingMode)
        : REGISTRATION_DEFAULTS.emailConfirmationGating,
      emailConfirmationSubject:
        typeof rawSubject === 'string' && rawSubject.trim().length > 0
          ? rawSubject
          : REGISTRATION_DEFAULTS.emailConfirmationSubject,
      emailConfirmationBody:
        typeof rawBody === 'string' && rawBody.trim().length > 0 ? rawBody : REGISTRATION_DEFAULTS.emailConfirmationBody,
      emailConfirmationBaseUrl: typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : '',
    }
  }

  /**
   * The effective OCR config: persisted admin values win over the OCR_* env
   * baseline, which falls back to the hardcoded safe defaults. Re-read per call so
   * admin changes take effect without a restart. The language codes are validated
   * (a bad code falls through to the default) and the bounds are clamped so a bad
   * value can never disable the per-request page/size guard.
   */
  async resolveOcrConfig(): Promise<ResolvedOcrConfig> {
    const ocr = (await this.safeRead()).ocr ?? {}
    const env = this.envBaseline
    const d = OCR_DEFAULTS

    const language = (
      persisted: string | undefined,
      envValue: string | undefined,
      fallback: string,
    ): string => validOcrLanguage(persisted) ?? validOcrLanguage(envValue) ?? fallback

    return {
      serverEnabled:
        typeof ocr.serverEnabled === 'boolean' ? ocr.serverEnabled : env.ocrServerEnabled ?? d.serverEnabled,
      defaultLanguage: language(ocr.defaultLanguage, env.ocrDefaultLanguage, d.defaultLanguage),
      maxPages: boundedInt(ocr.maxPages, 1, 1000) ?? boundedInt(env.ocrMaxPages, 1, 1000) ?? d.maxPages,
      maxImageBytes:
        boundedInt(ocr.maxImageBytes, 1024, 200 * 1024 * 1024) ??
        boundedInt(env.ocrMaxImageBytes, 1024, 200 * 1024 * 1024) ??
        d.maxImageBytes,
      clientEnabled:
        typeof ocr.clientEnabled === 'boolean' ? ocr.clientEnabled : env.ocrClientEnabled ?? d.clientEnabled,
      clientDefaultLanguage: language(ocr.clientDefaultLanguage, env.ocrClientDefaultLanguage, d.clientDefaultLanguage),
    }
  }

  /**
   * The effective WORKFLOWS (n8n) config: persisted admin values win over the
   * WORKFLOWS_* env baseline, which falls back to the hardcoded safe defaults.
   * enabled/n8nUrl/uiTokenTtlSeconds are re-read per call (runtime); uiBasePath is
   * the boot-bound Express mount path, so a persisted value here is the admin
   * intent and only takes effect after a gateway restart.
   */
  async resolveWorkflowsConfig(): Promise<ResolvedWorkflowsConfig> {
    const wf = (await this.safeRead()).workflows ?? {}
    const env = this.envBaseline
    const d = WORKFLOWS_DEFAULTS

    const url = (persisted: string | undefined, envValue: string | undefined, fallback: string): string => {
      for (const candidate of [persisted, envValue]) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          try {
            const parsed = new URL(candidate.trim())
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              return candidate.trim()
            }
          } catch {
            // fall through
          }
        }
      }

      return fallback
    }

    const path = (persisted: string | undefined, envValue: string | undefined, fallback: string): string => {
      for (const candidate of [persisted, envValue]) {
        if (typeof candidate === 'string' && candidate.trim().startsWith('/')) {
          return candidate.trim()
        }
      }

      return fallback
    }

    return {
      enabled: typeof wf.enabled === 'boolean' ? wf.enabled : env.workflowsEnabled ?? d.enabled,
      n8nUrl: url(wf.n8nUrl, env.workflowsN8nUrl, d.n8nUrl),
      uiBasePath: path(wf.uiBasePath, env.workflowsUiBasePath, d.uiBasePath),
      uiTokenTtlSeconds:
        boundedInt(wf.uiTokenTtlSeconds, 60, 7 * 24 * 60 * 60) ??
        boundedInt(env.workflowsUiTokenTtlSeconds, 60, 7 * 24 * 60 * 60) ??
        d.uiTokenTtlSeconds,
    }
  }

  /**
   * The masked admin view: configured booleans for secrets (API keys are NEVER
   * returned), plain values for non-secrets, plus a per-setting source map
   * ('persisted' | 'env' | 'default') so the admin pane can show where each
   * effective value comes from.
   */
  async view(): Promise<ServerSettingsView> {
    const persisted = await this.safeRead()
    const config = await this.resolveAssistantConfig()
    const env = this.envBaseline
    const { profiles, defaultProfileId } = await this.resolveAssistantProfiles()
    const backendProfiles = effectiveBackendProfiles(persisted.ai?.backendProfiles, profiles)
    const assignments = persisted.ai?.assignments ?? { users: {}, roles: {} }
    const tokenLimits = await this.resolveAssistantTokenLimits()

    const ai = persisted.ai ?? {}
    const pow = persisted.security?.proofOfWork ?? {}
    const proofOfWork = await this.resolveProofOfWorkConfig()
    const rl = persisted.security?.rateLimit ?? {}
    const rateLimit = await this.resolveRateLimitConfig()
    const registration = persisted.registration ?? {}
    const registrationConfig = await this.resolveRegistrationConfig()
    const ocr = persisted.ocr ?? {}
    const ocrConfig = await this.resolveOcrConfig()
    const workflows = persisted.workflows ?? {}
    const workflowsConfig = await this.resolveWorkflowsConfig()
    const sources: Record<string, ServerSettingSource> = {
      'ai.anthropicApiKey': this.source(ai.anthropicApiKey, env.assistant.anthropicApiKey),
      'ai.openaiApiKey': this.source(ai.openaiApiKey, env.assistant.openaiApiKey),
      'ai.openaiBaseUrl': this.source(ai.openaiBaseUrl, env.assistant.openaiBaseURL),
      'ai.ollamaUrl': this.source(ai.ollamaUrl, env.assistant.ollamaUrl),
      'ai.dailyRequestLimit': this.source(ai.dailyRequestLimit, env.assistantDailyRequestLimit),
      'ai.fiveHourTokenLimit': this.source(ai.fiveHourTokenLimit, env.assistantFiveHourTokenLimit),
      'ai.weeklyTokenLimit': this.source(ai.weeklyTokenLimit, env.assistantWeeklyTokenLimit),
      // Profiles are gateway-persisted only (no env source); 'persisted' when the
      // admin has defined an explicit set, else 'default' (legacy-mapped).
      'ai.profiles': this.source(ai.profiles, undefined),
      'ai.defaultProfileId': this.source(ai.defaultProfileId, undefined),
      'ai.backendProfiles': this.source(ai.backendProfiles, undefined),
      'ai.assignments': this.source(ai.assignments, undefined),
      'updateCheck.url': this.source(persisted.updateCheck?.url, env.updateCheckUrl),
      'nextcloudBackups.enabled': this.source(persisted.nextcloudBackups?.enabled, env.nextcloudBackupsEnabled),
      'security.proofOfWork.registerEnabled': this.source(pow.registerEnabled, env.proofOfWorkRegisterEnabled),
      'security.proofOfWork.registerDifficulty': this.source(pow.registerDifficulty, env.proofOfWorkRegisterDifficulty),
      'security.proofOfWork.signInEnabled': this.source(pow.signInEnabled, env.proofOfWorkSignInEnabled),
      'security.proofOfWork.signInMode': this.source(pow.signInMode, env.proofOfWorkSignInMode),
      'security.proofOfWork.signInDifficulty': this.source(pow.signInDifficulty, env.proofOfWorkSignInDifficulty),
      'security.proofOfWork.signInAdaptiveThreshold': this.source(
        pow.signInAdaptiveThreshold,
        env.proofOfWorkSignInAdaptiveThreshold,
      ),
      'security.rateLimit.enabled': this.source(rl.enabled, env.rateLimitEnabled),
      'security.rateLimit.windowSeconds': this.source(rl.windowSeconds, env.rateLimitWindowSeconds),
      'security.rateLimit.loginMax': this.source(rl.loginMax, env.rateLimitLoginMax),
      'security.rateLimit.registrationMax': this.source(rl.registrationMax, env.rateLimitRegistrationMax),
      'security.rateLimit.userWindowSeconds': this.source(rl.userWindowSeconds, env.rateLimitUserWindowSeconds),
      'security.rateLimit.userMax': this.source(rl.userMax, env.rateLimitUserMax),
      'security.rateLimit.adaptiveEscalation': this.source(rl.adaptiveEscalation, env.rateLimitAdaptiveEscalation),
      'registration.defaultRole': this.source(registration.defaultRole, env.registrationDefaultRole),
      'registration.domainMode': this.source(registration.domainMode, env.registrationDomainMode),
      'registration.domainList': this.source(registration.domainList, env.registrationDomains),
      'registration.emailConfirmationEnabled': this.source(
        registration.emailConfirmationEnabled,
        env.registrationEmailConfirmationEnabled,
      ),
      'registration.emailConfirmationGating': this.source(
        registration.emailConfirmationGating,
        env.registrationEmailConfirmationGating,
      ),
      'registration.emailConfirmationSubject': this.source(
        registration.emailConfirmationSubject,
        env.registrationEmailConfirmationSubject,
      ),
      'registration.emailConfirmationBody': this.source(
        registration.emailConfirmationBody,
        env.registrationEmailConfirmationBody,
      ),
      'registration.emailConfirmationBaseUrl': this.source(
        registration.emailConfirmationBaseUrl,
        env.registrationEmailConfirmationBaseUrl,
      ),
      'ocr.serverEnabled': this.source(ocr.serverEnabled, env.ocrServerEnabled),
      'ocr.defaultLanguage': this.source(ocr.defaultLanguage, env.ocrDefaultLanguage),
      'ocr.maxPages': this.source(ocr.maxPages, env.ocrMaxPages),
      'ocr.maxImageBytes': this.source(ocr.maxImageBytes, env.ocrMaxImageBytes),
      'ocr.clientEnabled': this.source(ocr.clientEnabled, env.ocrClientEnabled),
      'ocr.clientDefaultLanguage': this.source(ocr.clientDefaultLanguage, env.ocrClientDefaultLanguage),
      'workflows.enabled': this.source(workflows.enabled, env.workflowsEnabled),
      'workflows.n8nUrl': this.source(workflows.n8nUrl, env.workflowsN8nUrl),
      'workflows.uiBasePath': this.source(workflows.uiBasePath, env.workflowsUiBasePath),
      'workflows.uiTokenTtlSeconds': this.source(workflows.uiTokenTtlSeconds, env.workflowsUiTokenTtlSeconds),
    }

    return {
      settings: {
        ai: {
          anthropicConfigured: Boolean(config.anthropicApiKey),
          openaiConfigured: openAiCompatibleConfigured(config),
          openaiBaseUrl: config.openaiBaseURL ?? null,
          ollamaUrl: config.ollamaUrl ?? null,
          dailyRequestLimit: await this.resolveAssistantDailyRequestLimit(),
          fiveHourTokenLimit: tokenLimits.fiveHour > 0 ? tokenLimits.fiveHour : 0,
          weeklyTokenLimit: tokenLimits.weekly > 0 ? tokenLimits.weekly : 0,
          // env-only for now (ASSISTANT_OPENAI_AUTH_MODE); reported so the admin
          // pane can render the subscription-mode state truthfully.
          subscriptionMode: config.openaiAuthMode ?? null,
          // Masked named profiles — secrets replaced by keyConfigured booleans.
          profiles: maskProfiles(profiles),
          defaultProfileId: defaultProfileId ?? null,
          // Masked backend (provider/connection) profiles — secrets masked too.
          backendProfiles: maskBackendProfiles(backendProfiles),
          assignments: { users: assignments.users ?? {}, roles: assignments.roles ?? {} },
        },
        updateCheck: { url: (await this.resolveUpdateCheckUrl()) ?? null },
        nextcloudBackups: { enabled: await this.resolveNextcloudBackupsEnabled() },
        security: { proofOfWork, rateLimit },
        registration: {
          ...registrationConfig,
          assignableRoles: REGISTRATION_ASSIGNABLE_ROLES,
          gatingModes: EMAIL_CONFIRMATION_GATING_MODES,
        },
        ocr: ocrConfig,
        workflows: workflowsConfig,
      },
      sources,
    }
  }

  private source(persistedValue: unknown, envValue: unknown): ServerSettingSource {
    if (persistedValue !== undefined) {
      return 'persisted'
    }
    if (envValue !== undefined) {
      return 'env'
    }

    return 'default'
  }

  /**
   * A corrupt/unreadable settings file must never take a consumer down: fall
   * back to the env baseline (as if nothing were persisted).
   */
  private async safeRead(): Promise<PersistedServerSettings> {
    try {
      return await this.store.read()
    } catch {
      return {}
    }
  }
}
