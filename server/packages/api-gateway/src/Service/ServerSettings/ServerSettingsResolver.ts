import { AssistantProviderConfig } from '../Assistant/providers/factory'
import { openAiCompatibleConfigured } from '../Assistant/providers/openaiAuth'
import {
  effectiveProfiles,
  MaskedAiProfile,
  maskProfiles,
  PersistedAiProfile,
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
    }
    updateCheck: { url: string | null }
    nextcloudBackups: { enabled: boolean }
    security: { proofOfWork: ResolvedProofOfWorkConfig }
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

  /** Selects the active profile for a request (requested id, else default). */
  async resolveActiveProfile(requestedId?: string): Promise<PersistedAiProfile | undefined> {
    const { profiles, defaultProfileId } = await this.resolveAssistantProfiles()

    return selectActiveProfile(profiles, defaultProfileId, requestedId)
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
    const tokenLimits = await this.resolveAssistantTokenLimits()

    const ai = persisted.ai ?? {}
    const pow = persisted.security?.proofOfWork ?? {}
    const proofOfWork = await this.resolveProofOfWorkConfig()
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
        },
        updateCheck: { url: (await this.resolveUpdateCheckUrl()) ?? null },
        nextcloudBackups: { enabled: await this.resolveNextcloudBackupsEnabled() },
        security: { proofOfWork },
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
