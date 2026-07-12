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

/**
 * Standard Red Notes: RATE-LIMIT tier knobs for the gateway's anti-abuse layer.
 * Unlike proofOfWork/registration these are ENFORCED by the api-gateway itself
 * (RateLimitMiddleware reads the resolved config per request), so this shape is
 * NOT a cross-service contract. Every field is optional; absence falls through
 * to env then the hardcoded safe defaults that reproduce the historical
 * hardcoded behavior (window 60s, login 10, registration 5, per-user off).
 */
export interface PersistedRateLimitSettings {
  enabled?: boolean
  /** Fixed-window length in seconds shared by the IP tiers. Integer 1..3600. */
  windowSeconds?: number
  /** login / recovery-login tier max per window per IP. Integer 0..100000. */
  loginMax?: number
  /** registration / mcp-authenticate / magic-link tier max. Integer 0..100000. */
  registrationMax?: number
  /** Per-USER tier window (authenticated expensive endpoints). Integer 1..3600. */
  userWindowSeconds?: number
  /** Per-USER tier max per window per user; 0 = disabled. Integer 0..100000. */
  userMax?: number
  /**
   * Item 5: when true, an IP that trips a tier is flagged in Redis so the auth
   * server's ADAPTIVE proof-of-work path can escalate to a challenge on that
   * IP's next attempts instead of only hard-blocking. Default false.
   */
  adaptiveEscalation?: boolean
}

export interface PersistedSecuritySettings {
  proofOfWork?: PersistedProofOfWorkSettings
  rateLimit?: PersistedRateLimitSettings
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
  /**
   * Standard Red Notes: EMAIL CONFIRMATION (part 2). OFF by default. The auth
   * server reads these same keys and enforces them. Key names/nesting are a
   * CONTRACT shared with auth (RegistrationConfigOverlay) — keep them in sync.
   */
  emailConfirmationEnabled?: boolean
  emailConfirmationGating?: 'block_signin' | 'warn'
  emailConfirmationSubject?: string
  emailConfirmationBody?: string
  emailConfirmationBaseUrl?: string
  /**
   * Standard Red Notes: SIGNUP CAPS (part of the anti-abuse posture). The
   * api-gateway PERSISTS + VIEWS these; the AUTH server reads the SAME overlay
   * file and ENFORCES them in its Register use case (per-IP + global per-week
   * durable caps, plus a SOFT per-device best-effort cap). Key names/nesting are
   * a CONTRACT shared with auth (RegistrationConfigOverlay / SignupLimitsConfig)
   * — keep them in sync. Every field optional; absence = fall back to auth's
   * env/default. Caps: 0 = unlimited. Windows are in hours.
   */
  /** Per-IP signup cap over the window; 0 = unlimited. Integer 0..100000. */
  signupsPerIpMax?: number
  /** Per-IP window length in hours. Integer 1..168 (1h..7d). */
  signupsPerIpWindowHours?: number
  /** Global rolling-7-day signup cap; 0 = unlimited. Integer 0..1000000. */
  signupsPerWeekMax?: number
  /** Per-device SOFT signup cap; 0 = unlimited. Integer 0..100000. */
  signupsPerDeviceMax?: number
  /** Per-device window length in hours. Integer 1..168 (1h..7d). */
  signupsPerDeviceWindowHours?: number
}

/**
 * Standard Red Notes: RUNTIME LOG VERBOSITY. The api-gateway PERSISTS + VIEWS
 * `logging.level`; a small in-process poller (RuntimeLogLevelApplier) re-reads it
 * on an interval and mutates the live winston logger + transport levels, so the
 * server's log verbosity changes WITHOUT a restart. The auth server reads the
 * SAME overlay key and runs its own poller. Key name/nesting is a CONTRACT shared
 * with auth — keep it in sync. Absent = fall back to env LOG_LEVEL then 'info'.
 */
export interface PersistedLoggingSettings {
  /** One of error|warn|info|http|verbose|debug|silly. */
  level?: string
}

/**
 * Standard Red Notes: OCR knobs. Two distinct paths, both persisted here:
 *   - SERVER-side OCR (the E2E-downgrade /v1/ocr/recognize endpoint): serverEnabled
 *     (master switch), defaultLanguage, and the per-request bounds maxPages /
 *     maxImageBytes. Enforced ENTIRELY by the api-gateway (OcrController +
 *     OcrService read the resolver per request), so these are fully runtime.
 *   - BROWSER OCR (the client-side, on-device tesseract path): clientEnabled /
 *     clientDefaultLanguage. These historically bake into the SPA at web-container
 *     start (OCR_ENABLED / OCR_DEFAULT_LANGUAGE → window.ocrEnabled /
 *     window.ocrDefaultLanguage). Persisted here as the admin INTENT and surfaced
 *     at runtime through GET /v1/ocr/config so a fresh page picks them up without
 *     a web-container rebuild; the baked window.* path still works as a fallback.
 * Every field is optional; absence falls through to env then the safe defaults
 * (all OFF / eng / current bounds), so a stock deploy is unchanged until edited.
 */
export interface PersistedOcrSettings {
  serverEnabled?: boolean
  defaultLanguage?: string
  /** Integer 1..1000. */
  maxPages?: number
  /** Integer 1024..(200 MiB). */
  maxImageBytes?: number
  clientEnabled?: boolean
  clientDefaultLanguage?: string
}

/**
 * Standard Red Notes: WORKFLOWS (n8n) knobs. Enforced ENTIRELY by the api-gateway
 * (WorkflowsController + the /workflows-ui proxy). `enabled` and `n8nUrl` are read
 * through the resolver per request so they are fully runtime; `uiTokenTtlSeconds`
 * applies to newly-minted editor cookies. `uiBasePath` is the Express mount path
 * of the editor proxy — it is bound ONCE at boot, so a persisted value here is the
 * admin INTENT and only takes effect after the gateway restarts (documented). No
 * secret lives here: the editor proxy authenticates with the gateway's own
 * short-lived UI cookie, and n8n community edition needs no API key for the editor.
 * Every field is optional; absence falls through to env then the safe defaults.
 */
export interface PersistedWorkflowsSettings {
  enabled?: boolean
  n8nUrl?: string
  /** Restart-bound (Express mount path). */
  uiBasePath?: string
  /** Integer 60..(7 days). */
  uiTokenTtlSeconds?: number
}

/**
 * Standard Red Notes: PLUGINS (extensions gallery) repo knob. The gateway
 * enforces this ENTIRELY (PluginsController + PluginsProxyService fetch the repo
 * server-side and hand it to the client SAME-ORIGIN so the strict CSP
 * `connect-src 'self'` is satisfied with no CSP change). `repoUrl` is the BASE
 * directory URL of the plugins repo — the index is fetched at
 * `<repoUrl>/packages.json` and any per-file proxy request is resolved (and
 * SSRF-guarded) against this base. Read through the resolver per request so an
 * admin change takes effect WITHOUT a restart. Absent = fall through to env
 * (PLUGINS_REPO_URL) then the hardcoded Standard Notes default, so a stock
 * deploy is unchanged until edited.
 *
 * `sameOriginRendering` is an OPT-IN admin trust decision (default OFF): when on,
 * the gateway ALSO serves a trusted-repo plugin component's files SAME-ORIGIN
 * (GET /v1/plugins/component/<relPath>) so its iframe can load under the strict
 * CSP `frame-src 'self'` and actually RENDER. Serving third-party code from the
 * SN origin is why this is opt-in; the component stays SANDBOXED (opaque origin,
 * no parent DOM/storage access) so same-origin serving grants it no extra trust.
 * Absent = fall through to env (PLUGINS_SAME_ORIGIN_RENDERING) then the hardcoded
 * default (OFF), so a stock deploy behaves exactly as before (external hosted_url,
 * blocked by CSP).
 */
export interface PersistedPluginsSettings {
  repoUrl?: string
  sameOriginRendering?: boolean
}

export interface PersistedServerSettings {
  ai?: PersistedAiSettings
  updateCheck?: { url?: string }
  nextcloudBackups?: { enabled?: boolean }
  security?: PersistedSecuritySettings
  registration?: PersistedRegistrationSettings
  logging?: PersistedLoggingSettings
  ocr?: PersistedOcrSettings
  workflows?: PersistedWorkflowsSettings
  plugins?: PersistedPluginsSettings
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
    rateLimit?: {
      enabled?: boolean | null
      windowSeconds?: number | null
      loginMax?: number | null
      registrationMax?: number | null
      userWindowSeconds?: number | null
      userMax?: number | null
      adaptiveEscalation?: boolean | null
    }
  }
  registration?: {
    defaultRole?: string | null
    domainMode?: 'off' | 'allowlist' | 'blocklist' | null
    domainList?: string[] | null
    emailConfirmationEnabled?: boolean | null
    emailConfirmationGating?: 'block_signin' | 'warn' | null
    emailConfirmationSubject?: string | null
    emailConfirmationBody?: string | null
    emailConfirmationBaseUrl?: string | null
    signupsPerIpMax?: number | null
    signupsPerIpWindowHours?: number | null
    signupsPerWeekMax?: number | null
    signupsPerDeviceMax?: number | null
    signupsPerDeviceWindowHours?: number | null
  }
  logging?: {
    level?: string | null
  }
  ocr?: {
    serverEnabled?: boolean | null
    defaultLanguage?: string | null
    maxPages?: number | null
    maxImageBytes?: number | null
    clientEnabled?: boolean | null
    clientDefaultLanguage?: string | null
  }
  workflows?: {
    enabled?: boolean | null
    n8nUrl?: string | null
    uiBasePath?: string | null
    uiTokenTtlSeconds?: number | null
  }
  plugins?: {
    repoUrl?: string | null
    sameOriginRendering?: boolean | null
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
      if (patch.security?.rateLimit) {
        data.security = data.security ?? {}
        data.security.rateLimit = data.security.rateLimit ?? {}
        const rl = patch.security.rateLimit
        this.applyKey(data.security.rateLimit, 'enabled', rl.enabled)
        this.applyKey(data.security.rateLimit, 'windowSeconds', rl.windowSeconds)
        this.applyKey(data.security.rateLimit, 'loginMax', rl.loginMax)
        this.applyKey(data.security.rateLimit, 'registrationMax', rl.registrationMax)
        this.applyKey(data.security.rateLimit, 'userWindowSeconds', rl.userWindowSeconds)
        this.applyKey(data.security.rateLimit, 'userMax', rl.userMax)
        this.applyKey(data.security.rateLimit, 'adaptiveEscalation', rl.adaptiveEscalation)
        if (Object.keys(data.security.rateLimit).length === 0) {
          delete data.security.rateLimit
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
        this.applyKey(data.registration, 'emailConfirmationEnabled', patch.registration.emailConfirmationEnabled)
        this.applyKey(data.registration, 'emailConfirmationGating', patch.registration.emailConfirmationGating)
        this.applyKey(data.registration, 'emailConfirmationSubject', patch.registration.emailConfirmationSubject)
        this.applyKey(data.registration, 'emailConfirmationBody', patch.registration.emailConfirmationBody)
        this.applyKey(data.registration, 'emailConfirmationBaseUrl', patch.registration.emailConfirmationBaseUrl)
        this.applyKey(data.registration, 'signupsPerIpMax', patch.registration.signupsPerIpMax)
        this.applyKey(data.registration, 'signupsPerIpWindowHours', patch.registration.signupsPerIpWindowHours)
        this.applyKey(data.registration, 'signupsPerWeekMax', patch.registration.signupsPerWeekMax)
        this.applyKey(data.registration, 'signupsPerDeviceMax', patch.registration.signupsPerDeviceMax)
        this.applyKey(data.registration, 'signupsPerDeviceWindowHours', patch.registration.signupsPerDeviceWindowHours)
        if (Object.keys(data.registration).length === 0) {
          delete data.registration
        }
      }
      if (patch.logging) {
        data.logging = data.logging ?? {}
        this.applyKey(data.logging, 'level', patch.logging.level)
        if (Object.keys(data.logging).length === 0) {
          delete data.logging
        }
      }
      if (patch.ocr) {
        data.ocr = data.ocr ?? {}
        this.applyKey(data.ocr, 'serverEnabled', patch.ocr.serverEnabled)
        this.applyKey(data.ocr, 'defaultLanguage', patch.ocr.defaultLanguage)
        this.applyKey(data.ocr, 'maxPages', patch.ocr.maxPages)
        this.applyKey(data.ocr, 'maxImageBytes', patch.ocr.maxImageBytes)
        this.applyKey(data.ocr, 'clientEnabled', patch.ocr.clientEnabled)
        this.applyKey(data.ocr, 'clientDefaultLanguage', patch.ocr.clientDefaultLanguage)
        if (Object.keys(data.ocr).length === 0) {
          delete data.ocr
        }
      }
      if (patch.workflows) {
        data.workflows = data.workflows ?? {}
        this.applyKey(data.workflows, 'enabled', patch.workflows.enabled)
        this.applyKey(data.workflows, 'n8nUrl', patch.workflows.n8nUrl)
        this.applyKey(data.workflows, 'uiBasePath', patch.workflows.uiBasePath)
        this.applyKey(data.workflows, 'uiTokenTtlSeconds', patch.workflows.uiTokenTtlSeconds)
        if (Object.keys(data.workflows).length === 0) {
          delete data.workflows
        }
      }
      if (patch.plugins) {
        data.plugins = data.plugins ?? {}
        this.applyKey(data.plugins, 'repoUrl', patch.plugins.repoUrl)
        this.applyKey(data.plugins, 'sameOriginRendering', patch.plugins.sameOriginRendering)
        if (Object.keys(data.plugins).length === 0) {
          delete data.plugins
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
