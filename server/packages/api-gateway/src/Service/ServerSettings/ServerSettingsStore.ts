import { promises as fs } from 'fs'
import * as path from 'path'

import { AssistantProfileAssignments, PersistedAiProfile, PersistedBackendProfile } from '../Assistant/profiles'

/**
 * Standard Red Notes: runtime-configurable SERVER settings (admin pane).
 *
 * A gateway-local persisted OVERLAY over env configuration. PRECEDENCE:
 * persisted (admin-set) WINS over env; env is the fallback; hardcoded defaults
 * apply last. Only the keys an admin has explicitly set are stored — anything
 * absent here falls through to env/default, so a fresh install behaves exactly
 * like an env-only deployment.
 *
 * STORAGE: a single JSON file (SERVER_SETTINGS_PATH, default
 * `<cwd>/data/server-settings.json`), mirroring the WorkflowsPairingStore /
 * CalDAV store pattern — the api-gateway has no database, and a JSON file keeps
 * the feature self-contained. Writes are chained + atomic (tmp file + rename).
 *
 * SECRETS: provider API keys are persisted here in plaintext (same trust level
 * as the env file they replace) but are NEVER returned by any endpoint — the
 * admin API only ever reports `configured` booleans for them.
 */

export interface PersistedAiSettings {
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  ollamaUrl?: string
  dailyRequestLimit?: number
  /**
   * Standard Red Notes: per-user AI TOKEN limits over rolling windows. 0/unset =
   * unlimited. Enforced alongside (not instead of) dailyRequestLimit.
   */
  fiveHourTokenLimit?: number
  weeklyTokenLimit?: number
  /**
   * Standard Red Notes: MULTIPLE named assistant profiles. When present and
   * non-empty these take precedence; when absent the legacy single-provider
   * fields above are mapped into synthesized default profiles (back-compat).
   * Each profile's apiKey is a secret persisted in plaintext but never returned.
   */
  profiles?: PersistedAiProfile[]
  /** Id of the profile used when the client does not select one. */
  defaultProfileId?: string
  /**
   * Standard Red Notes: DECOUPLED backend (provider/connection) profiles that
   * assistant profiles reference by id. When absent the effective set is
   * synthesized from the assistant/legacy profiles (back-compat). Each api-key
   * backend's apiKey is a secret persisted in plaintext but never returned.
   */
  backendProfiles?: PersistedBackendProfile[]
  /**
   * Standard Red Notes: assistant-profile assignments (user/role -> profile id).
   * Resolved at request time with precedence USER > ROLE > default.
   */
  assignments?: AssistantProfileAssignments
}

/**
 * Standard Red Notes: PROOF-OF-WORK anti-bot knobs for register/sign-in. The
 * api-gateway PERSISTS these (admin pane) but does NOT enforce them — the AUTH
 * server reads the SAME overlay file (SERVER_SETTINGS_PATH) and does the actual
 * PoW gating. This shape is therefore a CONTRACT shared with auth: keep the key
 * names/nesting exactly as the auth side expects. Every field is optional;
 * absence means "fall back to auth's env/default".
 */
export interface PersistedProofOfWorkSettings {
  registerEnabled?: boolean
  /** Integer 0..32. */
  registerDifficulty?: number
  signInEnabled?: boolean
  signInMode?: 'always' | 'adaptive'
  /** Integer 0..32. */
  signInDifficulty?: number
  /** Integer 0..100. */
  signInAdaptiveThreshold?: number
}

export interface PersistedSecuritySettings {
  proofOfWork?: PersistedProofOfWorkSettings
}

/**
 * Standard Red Notes: REGISTRATION policy (default role + email-domain policy).
 * The api-gateway PERSISTS + VIEWS these (admin pane); the AUTH server reads the
 * SAME overlay file (SERVER_SETTINGS_PATH) and ENFORCES them in its Register use
 * case. This shape is therefore a CONTRACT shared with auth — keep the key
 * names/nesting exactly as the auth side (RegistrationConfigOverlay) expects.
 * Every field is optional; absence means "fall back to auth's env/default".
 */
export interface PersistedRegistrationSettings {
  /** A canonical, NON-admin role name (CORE_USER / PRO_USER / VAULTS_USER). */
  defaultRole?: string
  domainMode?: 'off' | 'allowlist' | 'blocklist'
  domainList?: string[]
}

export interface PersistedServerSettings {
  ai?: PersistedAiSettings
  updateCheck?: { url?: string }
  nextcloudBackups?: { enabled?: boolean }
  security?: PersistedSecuritySettings
  registration?: PersistedRegistrationSettings
}

/**
 * A validated PUT payload: `undefined` = leave untouched, `null` = CLEAR the
 * persisted value (fall back to env), anything else = persist the new value.
 */
export interface ServerSettingsPatch {
  ai?: {
    anthropicApiKey?: string | null
    openaiApiKey?: string | null
    openaiBaseUrl?: string | null
    ollamaUrl?: string | null
    dailyRequestLimit?: number | null
    fiveHourTokenLimit?: number | null
    weeklyTokenLimit?: number | null
    profiles?: PersistedAiProfile[] | null
    defaultProfileId?: string | null
    backendProfiles?: PersistedBackendProfile[] | null
    assignments?: AssistantProfileAssignments | null
  }
  updateCheck?: { url?: string | null }
  nextcloudBackups?: { enabled?: boolean | null }
  security?: {
    proofOfWork?: {
      registerEnabled?: boolean | null
      registerDifficulty?: number | null
      signInEnabled?: boolean | null
      signInMode?: 'always' | 'adaptive' | null
      signInDifficulty?: number | null
      signInAdaptiveThreshold?: number | null
    }
  }
  registration?: {
    defaultRole?: string | null
    domainMode?: 'off' | 'allowlist' | 'blocklist' | null
    domainList?: string[] | null
  }
}

export class ServerSettingsStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async read(): Promise<PersistedServerSettings> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedServerSettings

      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  /**
   * Applies a validated patch: null clears a persisted key, undefined leaves it
   * untouched, a concrete value persists it. Empty sections are pruned so the
   * stored document only ever contains admin-set values.
   */
  async update(patch: ServerSettingsPatch): Promise<PersistedServerSettings> {
    let result: PersistedServerSettings = {}
    await this.mutate((data) => {
      if (patch.ai) {
        data.ai = data.ai ?? {}
        this.applyKey(data.ai, 'anthropicApiKey', patch.ai.anthropicApiKey)
        this.applyKey(data.ai, 'openaiApiKey', patch.ai.openaiApiKey)
        this.applyKey(data.ai, 'openaiBaseUrl', patch.ai.openaiBaseUrl)
        this.applyKey(data.ai, 'ollamaUrl', patch.ai.ollamaUrl)
        this.applyKey(data.ai, 'dailyRequestLimit', patch.ai.dailyRequestLimit)
        this.applyKey(data.ai, 'fiveHourTokenLimit', patch.ai.fiveHourTokenLimit)
        this.applyKey(data.ai, 'weeklyTokenLimit', patch.ai.weeklyTokenLimit)
        this.applyKey(data.ai, 'profiles', patch.ai.profiles)
        this.applyKey(data.ai, 'defaultProfileId', patch.ai.defaultProfileId)
        this.applyKey(data.ai, 'backendProfiles', patch.ai.backendProfiles)
        this.applyKey(data.ai, 'assignments', patch.ai.assignments)
        if (Object.keys(data.ai).length === 0) {
          delete data.ai
        }
      }
      if (patch.updateCheck) {
        data.updateCheck = data.updateCheck ?? {}
        this.applyKey(data.updateCheck, 'url', patch.updateCheck.url)
        if (Object.keys(data.updateCheck).length === 0) {
          delete data.updateCheck
        }
      }
      if (patch.nextcloudBackups) {
        data.nextcloudBackups = data.nextcloudBackups ?? {}
        this.applyKey(data.nextcloudBackups, 'enabled', patch.nextcloudBackups.enabled)
        if (Object.keys(data.nextcloudBackups).length === 0) {
          delete data.nextcloudBackups
        }
      }
      if (patch.security?.proofOfWork) {
        data.security = data.security ?? {}
        data.security.proofOfWork = data.security.proofOfWork ?? {}
        const pow = patch.security.proofOfWork
        this.applyKey(data.security.proofOfWork, 'registerEnabled', pow.registerEnabled)
        this.applyKey(data.security.proofOfWork, 'registerDifficulty', pow.registerDifficulty)
        this.applyKey(data.security.proofOfWork, 'signInEnabled', pow.signInEnabled)
        this.applyKey(data.security.proofOfWork, 'signInMode', pow.signInMode)
        this.applyKey(data.security.proofOfWork, 'signInDifficulty', pow.signInDifficulty)
        this.applyKey(data.security.proofOfWork, 'signInAdaptiveThreshold', pow.signInAdaptiveThreshold)
        if (Object.keys(data.security.proofOfWork).length === 0) {
          delete data.security.proofOfWork
        }
        if (Object.keys(data.security).length === 0) {
          delete data.security
        }
      }
      if (patch.registration) {
        data.registration = data.registration ?? {}
        this.applyKey(data.registration, 'defaultRole', patch.registration.defaultRole)
        this.applyKey(data.registration, 'domainMode', patch.registration.domainMode)
        this.applyKey(data.registration, 'domainList', patch.registration.domainList)
        if (Object.keys(data.registration).length === 0) {
          delete data.registration
        }
      }
      result = data
    })

    return result
  }

  private applyKey<T extends object, K extends keyof T>(section: T, key: K, value: T[K] | null | undefined): void {
    if (value === undefined) {
      return
    }
    if (value === null) {
      delete section[key]

      return
    }
    section[key] = value
  }

  private async mutate(mutator: (data: PersistedServerSettings) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const data = await this.read()
      mutator(data)
      await this.atomicWrite(data)
    })
    this.writeChain = run.catch(() => undefined)

    return run
  }

  private async atomicWrite(data: PersistedServerSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
