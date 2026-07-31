import { promises as fs } from 'fs'

import { ProofOfWorkOverlay } from '../../Domain/ProofOfWork/ProofOfWorkConfig'
import {
  isEmailConfirmationGatingMode,
  isRegistrationDomainMode,
  RegistrationConfigOverlay,
} from '../../Domain/Registration/RegistrationConfig'
import { SignupLimitsConfigOverlay } from '../../Domain/Registration/SignupLimitsConfig'

/**
 * Standard Red Notes: read-only view of the api-gateway's persisted runtime
 * server-settings overlay (the atomic JSON file the gateway's
 * PUT /v1/admin/server-settings writes — see the api-gateway package's
 * ServerSettingsStore).
 *
 * WHY IT LIVES HERE: the Nextcloud-backups master gate is ENFORCED auth-side
 * (TriggerNextcloudBackupForAllUsers), but the admin-set overlay is persisted
 * gateway-side. In the supplied images all services share a filesystem, so the
 * cleanest minimal bridge is reading the same file: the docker entrypoint points
 * every deployed process's SERVER_SETTINGS_PATH at one path. When the env var
 * is unset (multi-service topologies without a shared volume, older
 * containers), every read returns `undefined` and the caller falls back to the
 * NEXTCLOUD_BACKUPS_ENABLED env exactly as before.
 *
 * PRECEDENCE (same contract as the gateway resolver): a persisted admin value
 * WINS over env; absence falls through to env, then the default (off).
 * Reads are lazy (per call, never cached) so an admin toggle takes effect on
 * the next scheduled run without a restart. Never throws — a missing/corrupt
 * file degrades to `undefined`.
 */
export class ServerSettingsOverlayReader {
  constructor(private readonly filePath: string | undefined) {}

  async nextcloudBackupsEnabled(): Promise<boolean | undefined> {
    const overlay = await this.read()
    const enabled = (overlay?.nextcloudBackups as { enabled?: unknown } | undefined)?.enabled

    return typeof enabled === 'boolean' ? enabled : undefined
  }

  /**
   * Reads the admin-set proof-of-work overrides from `security.proofOfWork.*`.
   * Returns only the fields an admin has actually persisted (each is undefined
   * when unset, so the caller falls through to env then default). Never throws.
   */
  async proofOfWork(): Promise<ProofOfWorkOverlay | undefined> {
    const overlay = await this.read()
    const security = overlay?.security as { proofOfWork?: Record<string, unknown> } | undefined
    const pow = security?.proofOfWork
    if (!pow || typeof pow !== 'object') {
      return undefined
    }

    const result: ProofOfWorkOverlay = {}
    if (typeof pow.registerEnabled === 'boolean') {
      result.registerEnabled = pow.registerEnabled
    }
    if (typeof pow.registerDifficulty === 'number') {
      result.registerDifficulty = pow.registerDifficulty
    }
    if (typeof pow.signInEnabled === 'boolean') {
      result.signInEnabled = pow.signInEnabled
    }
    if (pow.signInMode === 'always' || pow.signInMode === 'adaptive') {
      result.signInMode = pow.signInMode
    }
    if (typeof pow.signInDifficulty === 'number') {
      result.signInDifficulty = pow.signInDifficulty
    }
    if (typeof pow.signInAdaptiveThreshold === 'number') {
      result.signInAdaptiveThreshold = pow.signInAdaptiveThreshold
    }

    return result
  }

  /**
   * Reads the admin-set `security.rateLimit.adaptiveEscalation` flag — the SAME
   * overlay key the api-gateway both persists AND reads to decide whether to
   * write the per-IP `rl:escalate:<ip>` signal. Returns `undefined` when unset
   * so the caller can fall through to its env baseline / default. Never throws.
   */
  async rateLimitAdaptiveEscalation(): Promise<boolean | undefined> {
    const overlay = await this.read()
    const security = overlay?.security as { rateLimit?: Record<string, unknown> } | undefined
    const enabled = security?.rateLimit?.adaptiveEscalation

    return typeof enabled === 'boolean' ? enabled : undefined
  }

  /**
   * Reads the admin-set REGISTRATION policy overrides from `registration.*`
   * (default role + email-domain policy). Returns only the fields an admin has
   * actually persisted (each undefined when unset, so the caller falls through
   * to env then default). Never throws.
   */
  async registration(): Promise<RegistrationConfigOverlay | undefined> {
    const overlay = await this.read()
    const registration = overlay?.registration as Record<string, unknown> | undefined
    if (!registration || typeof registration !== 'object') {
      return undefined
    }

    const result: RegistrationConfigOverlay = {}
    if (typeof registration.defaultRole === 'string') {
      result.defaultRole = registration.defaultRole
    }
    if (isRegistrationDomainMode(registration.domainMode)) {
      result.domainMode = registration.domainMode
    }
    if (Array.isArray(registration.domainList)) {
      result.domainList = registration.domainList.filter((entry): entry is string => typeof entry === 'string')
    }
    if (typeof registration.emailConfirmationEnabled === 'boolean') {
      result.emailConfirmationEnabled = registration.emailConfirmationEnabled
    }
    if (isEmailConfirmationGatingMode(registration.emailConfirmationGating)) {
      result.emailConfirmationGating = registration.emailConfirmationGating
    }
    if (typeof registration.emailConfirmationSubject === 'string') {
      result.emailConfirmationSubject = registration.emailConfirmationSubject
    }
    if (typeof registration.emailConfirmationBody === 'string') {
      result.emailConfirmationBody = registration.emailConfirmationBody
    }
    if (typeof registration.emailConfirmationBaseUrl === 'string') {
      result.emailConfirmationBaseUrl = registration.emailConfirmationBaseUrl
    }
    if (typeof registration.inviteOnly === 'boolean') {
      result.inviteOnly = registration.inviteOnly
    }
    if (typeof registration.maxTotalAccounts === 'number') {
      result.maxTotalAccounts = registration.maxTotalAccounts
    }
    // Nullable ISO instants: a null clears the bound; a string is validated by the
    // resolver (bad value → null). Only pass through the two admissible shapes.
    if (registration.signupsOpenAt === null || typeof registration.signupsOpenAt === 'string') {
      result.signupsOpenAt = registration.signupsOpenAt
    }
    if (registration.signupsCloseAt === null || typeof registration.signupsCloseAt === 'string') {
      result.signupsCloseAt = registration.signupsCloseAt
    }
    if (typeof registration.approvalRequired === 'boolean') {
      result.approvalRequired = registration.approvalRequired
    }
    if (typeof registration.invitesPerUser === 'number') {
      result.invitesPerUser = registration.invitesPerUser
    }

    return result
  }

  /**
   * Reads the admin-set SIGNUP CAP overrides from `registration.signupsPer*`
   * (per-IP / per-week / per-device caps + their windows). Returns only the
   * NUMERIC fields an admin has actually persisted (each undefined when unset, so
   * the caller falls through to env then default). Never throws.
   */
  async signupLimits(): Promise<SignupLimitsConfigOverlay | undefined> {
    const overlay = await this.read()
    const registration = overlay?.registration as Record<string, unknown> | undefined
    if (!registration || typeof registration !== 'object') {
      return undefined
    }

    const result: SignupLimitsConfigOverlay = {}
    if (typeof registration.signupsPerIpMax === 'number') {
      result.perIpMax = registration.signupsPerIpMax
    }
    if (typeof registration.signupsPerIpWindowHours === 'number') {
      result.perIpWindowHours = registration.signupsPerIpWindowHours
    }
    if (typeof registration.signupsPerWeekMax === 'number') {
      result.perWeekMax = registration.signupsPerWeekMax
    }
    if (typeof registration.signupsPerDeviceMax === 'number') {
      result.perDeviceMax = registration.signupsPerDeviceMax
    }
    if (typeof registration.signupsPerDeviceWindowHours === 'number') {
      result.perDeviceWindowHours = registration.signupsPerDeviceWindowHours
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  private async read(): Promise<Record<string, unknown> | undefined> {
    if (!this.filePath) {
      return undefined
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown

      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
}
