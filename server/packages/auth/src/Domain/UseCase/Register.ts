import * as bcrypt from 'bcryptjs'
import { RoleName, SettingName, SubscriptionPlanName, Username } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { RegisterDTO } from './RegisterDTO'
import { RegisterResponse } from './RegisterResponse'
import { UseCaseInterface } from './UseCaseInterface'
import { RoleRepositoryInterface } from '../Role/RoleRepositoryInterface'
import { CrypterInterface } from '../Encryption/CrypterInterface'
import { AuthResponseFactory20200115 } from '../Auth/AuthResponseFactory20200115'
import { ApiVersion } from '../Api/ApiVersion'
import { ApplyDefaultSettings } from './ApplyDefaultSettings/ApplyDefaultSettings'
import { ActivatePremiumFeatures } from './ActivatePremiumFeatures/ActivatePremiumFeatures'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'
import { RegistrationConfigResolverInterface } from '../Registration/RegistrationConfigResolverInterface'
import {
  DEFAULT_REGISTRATION_CONFIG,
  emailAllowedByPolicy,
  RegistrationConfig,
  sanitizeDefaultRole,
} from '../Registration/RegistrationConfig'
import { ConsumeSignupInvite } from './ConsumeSignupInvite/ConsumeSignupInvite'
import { ConsumeSignupInviteResponse } from './ConsumeSignupInvite/ConsumeSignupInviteResponse'
import { DEFAULT_SIGNUP_LIMITS, SignupLimitsConfig } from '../Registration/SignupLimitsConfig'
import { SignupLimitsConfigResolverInterface } from '../Registration/SignupLimitsConfigResolverInterface'
import { SignupRateLimiterInterface } from '../Registration/SignupRateLimiterInterface'
import { SendEmailConfirmation } from './SendEmailConfirmation/SendEmailConfirmation'

export class Register implements UseCaseInterface {
  constructor(
    private userRepository: UserRepositoryInterface,
    private roleRepository: RoleRepositoryInterface,
    private authResponseFactory20200115: AuthResponseFactory20200115,
    private crypter: CrypterInterface,
    private disableUserRegistration: boolean,
    private timer: TimerInterface,
    private applyDefaultSettings: ApplyDefaultSettings,
    private standardRedEntitlementMode = 'subscription',
    private activatePremiumFeatures?: ActivatePremiumFeatures,
    private standardRedFullFeatureDurationDays = 36500,
    private standardRedFullFeatureFileUploadBytesLimit = -1,
    // Standard Red Notes: "multiple accounts per email" feature flag. Default
    // OFF (added as a trailing optional param so existing call sites and specs
    // keep their exact behavior). When OFF, the workspace concept is invisible:
    // the duplicate check stays email-only and no workspace property is set.
    private workspacesPerEmailEnabled = false,
    // Standard Red Notes: setting store used to consult the admin-panel-persisted
    // REGISTRATION_DISABLED flag at runtime. Trailing optional param so existing
    // call sites / specs keep compiling; when absent, only the boot-time
    // DISABLE_USER_REGISTRATION env governs registration (legacy behavior).
    private settingRepository?: SettingRepositoryInterface,
    // Standard Red Notes: resolves the admin-configurable registration policy
    // (default role for new users + email-domain allow/block policy), layering
    // the persisted admin overlay over the env baseline. Trailing optional param
    // so existing call sites / specs keep compiling; when absent, Register falls
    // back to the hardcoded default (CORE_USER, domain policy off).
    private registrationConfigResolver?: RegistrationConfigResolverInterface,
    // Standard Red Notes: EMAIL CONFIRMATION (part 2). When the resolved policy
    // has emailConfirmationEnabled, a new signup is created UNCONFIRMED and this
    // use case issues + emails the single-use verification link. Trailing optional
    // param so existing call sites / specs keep compiling; when absent, no
    // confirmation email is ever sent (feature effectively off).
    private sendEmailConfirmation?: SendEmailConfirmation,
    private logger?: { error: (message: string) => void },
    // Standard Red Notes: SIGNUP CAPS (part of the admin anti-abuse surface).
    // The rate limiter backs the per-IP + per-device SOFT caps (atomic Redis
    // INCR/EXPIRE, fail-open); the resolver supplies the effective cap policy
    // (persisted admin overlay -> env -> default). Both are trailing-optional so
    // existing call sites / specs keep compiling; when absent, no caps apply.
    private signupRateLimiter?: SignupRateLimiterInterface,
    private signupLimitsResolver?: SignupLimitsConfigResolverInterface,
    // Standard Red Notes: SIGNUP INVITE LINKS. Atomically consumes an invite slot
    // (and applies the link's per-link role / domain-lock / auto-approve /
    // referrer). Trailing-optional so existing call sites / specs keep compiling.
    // When invite-only mode is ON this dep MUST be wired — an unwired consumer in
    // invite-only mode FAILS CLOSED (registration is refused) so the gate is never
    // silently bypassable. When invite-only is OFF an unwired consumer is a no-op.
    private signupInviteConsumer?: ConsumeSignupInvite,
  ) {}

  async execute(dto: RegisterDTO): Promise<RegisterResponse> {
    // Registration is blocked when EITHER the boot-time DISABLE_USER_REGISTRATION
    // env is set (a hard override) OR the admin panel has persisted the
    // REGISTRATION_DISABLED flag at runtime (see BaseAdminController.setRegistrationFlag).
    // The env is checked first so it stays a hard override even if the setting
    // store is unreachable.
    if (this.disableUserRegistration || (await this.registrationDisabledBySetting())) {
      return {
        success: false,
        errorMessage: 'User registration is currently not allowed.',
      }
    }

    // Standard Red Notes: pull workspaceIdentifier out of the spread so it is
    // NEVER Object.assign'd onto the entity implicitly. With the flag OFF we
    // ignore it completely; with the flag ON we set it explicitly below. This
    // keeps the persisted entity byte-for-byte identical when the flag is OFF.
    const {
      email,
      password,
      apiVersion,
      ephemeralSession,
      workspaceIdentifier: requestedWorkspaceIdentifier,
      // Standard Red Notes: pulled out of the spread so the client-supplied
      // device id (SOFT per-device cap signal only) is NEVER Object.assign'd onto
      // the persisted User entity.
      deviceId,
      // Standard Red Notes: pulled out of the spread so the raw invite token is
      // NEVER Object.assign'd onto the persisted User entity.
      inviteToken,
      ...registrationFields
    } = dto

    const apiVersionOrError = ApiVersion.create(apiVersion)
    if (apiVersionOrError.isFailed()) {
      return {
        success: false,
        errorMessage: apiVersionOrError.getError(),
      }
    }
    const apiVersionVO = apiVersionOrError.getValue()

    if (!apiVersionVO.isSupportedForRegistration()) {
      return {
        success: false,
        errorMessage: `Unsupported api version: ${apiVersion}`,
      }
    }

    const usernameOrError = Username.create(email)
    if (usernameOrError.isFailed()) {
      return {
        success: false,
        errorMessage: usernameOrError.getError(),
      }
    }
    const username = usernameOrError.getValue()

    // Standard Red Notes: resolve the admin-configurable registration policy once
    // (default role + email-domain policy), layering the persisted admin overlay
    // over the env baseline. Enforce the email-domain policy before creating any
    // user so a refused domain never persists a row.
    const registrationConfig = await this.resolveRegistrationConfig()
    if (!emailAllowedByPolicy(username.value, registrationConfig)) {
      return {
        success: false,
        errorMessage: 'Registration is not allowed for this email domain.',
      }
    }

    // Standard Red Notes: GLOBAL registration gates that read off the resolved
    // policy — the time-window (#12) and the max-total-accounts cap (#11). Both
    // use a single generic non-enumerable refusal; the window is a pure clock
    // check and the total cap FAILS OPEN on a count error.
    const registrationGateRefusal = await this.enforceRegistrationGates(registrationConfig)
    if (registrationGateRefusal !== undefined) {
      return registrationGateRefusal
    }

    // Standard Red Notes: when the workspaces-per-email feature is ON, the
    // account is keyed by the composite (email, workspaceIdentifier). An
    // absent/empty workspace name resolves to the 'default' workspace so the
    // same email may register multiple independent workspaces, while still
    // rejecting a duplicate (email, workspace) pair. When OFF, the historical
    // email-only duplicate check is preserved exactly.
    if (this.workspacesPerEmailEnabled) {
      const workspaceIdentifier = this.normalizeWorkspaceIdentifier(requestedWorkspaceIdentifier)

      const existingUser = await this.userRepository.findOneByEmailAndWorkspaceIdentifier(username, workspaceIdentifier)
      if (existingUser) {
        return {
          success: false,
          errorMessage:
            workspaceIdentifier === 'default'
              ? 'This email is already registered.'
              : 'This email is already registered for this workspace.',
        }
      }
    } else {
      const existingUser = await this.userRepository.findOneByUsernameOrEmail(username)
      if (existingUser) {
        return {
          success: false,
          errorMessage: 'This email is already registered.',
        }
      }
    }

    // Standard Red Notes: configurable SIGNUP CAPS (per-week global / per-IP /
    // per-device SOFT), resolved once (persisted admin overlay -> env -> default)
    // and enforced right before the account is created — after the duplicate
    // check so the per-IP/per-device counters are only spent on a signup that
    // would otherwise succeed. Each cap is checked INDEPENDENTLY and each FAILS
    // OPEN: a broken overlay / cache / DB read must never block a legitimate
    // signup. A single GENERIC refusal message is used so the specific cap that
    // tripped is not enumerable by a probing client.
    const signupLimitsRefusal = await this.enforceSignupLimits(dto.ipAddress, deviceId)
    if (signupLimitsRefusal !== undefined) {
      return signupLimitsRefusal
    }

    // Standard Red Notes: SIGNUP INVITE gate — the LAST gate before the user is
    // built + saved (after every read-only validation gate above has passed), so
    // an invite slot is only spent on a signup that would otherwise succeed. The
    // user uuid is generated up front so the atomic consume can attribute the use
    // to this exact new account. Invite-only mode is FAIL-CLOSED (a missing /
    // invalid / errored token refuses registration with a single non-enumerable
    // message); open mode is FAIL-OPEN (a present token is honored + consumed but
    // an error/invalid token just proceeds as a normal open signup).
    const newUserUuid = uuidv4()
    const inviteOutcome = await this.resolveInviteConsume(
      registrationConfig,
      inviteToken,
      username.value,
      newUserUuid,
    )
    if ('refuse' in inviteOutcome) {
      return inviteOutcome.refuse
    }
    const consumedInvite = inviteOutcome.invite

    let user = new User()
    user.uuid = newUserUuid
    user.email = username.value
    // Standard Red Notes: only stamp the workspace identifier on the entity when
    // the feature is ON. When OFF we leave it unset so the database column
    // default ('default') applies and the saved row/in-memory entity is
    // unchanged from the pre-feature shape.
    if (this.workspacesPerEmailEnabled) {
      user.workspaceIdentifier = this.normalizeWorkspaceIdentifier(requestedWorkspaceIdentifier)
    }
    user.createdAt = this.timer.getUTCDate()
    user.updatedAt = this.timer.getUTCDate()
    user.encryptedPassword = await bcrypt.hash(password, User.PASSWORD_HASH_COST)
    user.encryptedServerKey = await this.crypter.generateEncryptedUserServerKey()
    user.serverEncryptionVersion = User.DEFAULT_ENCRYPTION_VERSION

    // Standard Red Notes: EMAIL CONFIRMATION. Only create an UNCONFIRMED account
    // when the feature is enabled AND we actually have a way to email the link —
    // otherwise the account would be created confirmed (DB default), so a
    // misconfiguration can never lock a new user out. When disabled the column is
    // left unset and the database default (confirmed) applies.
    const requireEmailConfirmation =
      registrationConfig.emailConfirmationEnabled && this.sendEmailConfirmation !== undefined
    if (requireEmailConfirmation) {
      user.emailConfirmed = false
      user.emailConfirmedAt = null
    }

    // Standard Red Notes: assign the admin-configurable default role (validated
    // to a canonical NON-admin role; CORE_USER by default). A consumed invite
    // link MAY override it with its own per-link role (validated NON-admin via
    // sanitizeDefaultRole — only ADMIN links can set one; user links never do). If
    // the configured role is somehow not seeded in the database, fall back to
    // CORE_USER so a new account is never left role-less by a misconfiguration.
    const effectiveDefaultRole =
      consumedInvite?.defaultRole != null && consumedInvite.defaultRole !== ''
        ? sanitizeDefaultRole(consumedInvite.defaultRole)
        : registrationConfig.defaultRole
    const roles = []
    let defaultRole = await this.roleRepository.findOneByName(effectiveDefaultRole)
    if (!defaultRole && effectiveDefaultRole !== RoleName.NAMES.CoreUser) {
      defaultRole = await this.roleRepository.findOneByName(RoleName.NAMES.CoreUser)
    }
    if (defaultRole) {
      roles.push(defaultRole)
    }
    user.roles = Promise.resolve(roles)

    Object.assign(user, registrationFields)

    user = await this.userRepository.save(user)

    const settingsApplicationResult = await this.applyDefaultSettings.execute({
      userName: user.email,
      userUuid: user.uuid,
    })
    if (settingsApplicationResult.isFailed()) {
      return {
        success: false,
        errorMessage: settingsApplicationResult.getError(),
      }
    }

    // Standard Red Notes: dispatch the confirmation email (best-effort). A send
    // failure must NOT fail registration — the account exists and the user can
    // request a resend; the raw token is never logged.
    if (requireEmailConfirmation) {
      try {
        await this.sendEmailConfirmation!.execute({
          userUuid: user.uuid,
          email: user.email,
          registrationConfig,
        })
      } catch (error) {
        this.logger?.error(`Could not send registration confirmation email: ${(error as Error).message}`)
      }
    }

    if (this.shouldActivateStandardRedFullFeatures()) {
      const activationResult = await this.activatePremiumFeatures!.execute({
        username: user.email,
        subscriptionId: this.standardRedSubscriptionIdForUser(user.uuid),
        subscriptionPlanName: SubscriptionPlanName.NAMES.ProPlan,
        uploadBytesLimit: this.standardRedFullFeatureFileUploadBytesLimit,
        endsAt: this.timer.getUTCDateNDaysAhead(this.standardRedFullFeatureDurationDays),
        cancelPreviousSubscription: true,
      })

      if (activationResult.isFailed()) {
        return {
          success: false,
          errorMessage: activationResult.getError(),
        }
      }
    }

    const result = await this.authResponseFactory20200115.createResponse({
      user,
      apiVersion: apiVersionVO,
      userAgent: dto.updatedWithUserAgent,
      ephemeralSession,
      readonlyAccess: false,
      snjs: dto.snjs,
      application: dto.application,
      ipAddress: dto.ipAddress,
    })

    return {
      success: true,
      result,
    }
  }

  /**
   * Standard Red Notes: consult the admin-panel-persisted REGISTRATION_DISABLED
   * flag at runtime. The flag is stored as a setting on the admin's OWN user
   * record (see BaseAdminController.setRegistrationFlag), so we can't key the
   * lookup on the registering user. Instead we count settings named
   * REGISTRATION_DISABLED whose value is 'true' AND that are owned by a user
   * holding the ADMIN_USER role: a single such row means an admin has turned
   * registration off instance-wide.
   *
   * The count is deliberately scoped to admin-owned rows (rather than every user)
   * so that a REGISTRATION_DISABLED='true' row written by a NON-admin cannot
   * disable signups. The user-settings write path is already blocked from writing
   * this setting (it is CLIENT_IMMUTABLE — see SettingsAssociationService), and
   * scoping the count here means any stale malicious row persisted before that fix
   * is ignored too. This also keeps the count consistent with the admin panel,
   * which reads/writes the flag on the (admin) requestor's own record.
   *
   * Fails OPEN (returns false) when no setting store is wired, so the env behavior
   * is preserved.
   */
  private async registrationDisabledBySetting(): Promise<boolean> {
    if (this.settingRepository === undefined) {
      return false
    }

    const nameOrError = SettingName.create(SettingName.NAMES.RegistrationDisabled)
    if (nameOrError.isFailed()) {
      return false
    }

    const count = await this.settingRepository.countAllByNameAndValueOwnedByRole({
      name: nameOrError.getValue(),
      value: 'true',
      roleName: RoleName.NAMES.AdminUser,
    })

    return count > 0
  }

  /**
   * Standard Red Notes: resolves the effective registration policy. Delegates to
   * the injected resolver (persisted admin overlay -> env -> default); when no
   * resolver is wired (legacy call sites / specs) it returns the hardcoded
   * default (CORE_USER default role, domain policy off). Never throws — a
   * resolver failure degrades to the default so registration is not taken down
   * by an unreadable overlay.
   */
  private async resolveRegistrationConfig(): Promise<RegistrationConfig> {
    if (this.registrationConfigResolver === undefined) {
      return DEFAULT_REGISTRATION_CONFIG
    }

    try {
      return await this.registrationConfigResolver.resolve()
    } catch {
      return DEFAULT_REGISTRATION_CONFIG
    }
  }

  /**
   * Standard Red Notes: enforces the configurable signup caps. Returns a refusal
   * RegisterResponse when a cap is exceeded, or undefined to allow the signup.
   *
   * Each of the three caps (per-week global, per-IP, per-device SOFT) is checked
   * independently and FAILS OPEN — an error in one never blocks the signup and
   * never short-circuits the others. Caps set to 0 (unlimited) are a no-op. The
   * per-IP / per-device counters increment only when a rate limiter is wired; the
   * per-device counter additionally requires the client to have supplied a device
   * id (a forgeable, best-effort signal — NOT a security boundary).
   */
  private async enforceSignupLimits(
    ipAddress: string | null | undefined,
    deviceId: string | undefined,
  ): Promise<RegisterResponse | undefined> {
    const limits = await this.resolveSignupLimits()

    // per-week (global, DB-backed): refuse once the rolling-7-day signup count
    // has reached the cap. Read-only; fails open on any DB error.
    if (limits.perWeekMax > 0) {
      try {
        const now = this.timer.getUTCDate()
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const recentCount = await this.userRepository.countAllCreatedBetween(weekAgo, now)
        if (recentCount >= limits.perWeekMax) {
          return { success: false, errorMessage: 'User registration is currently not allowed.' }
        }
      } catch (error) {
        this.logger?.error(`Signup per-week cap check failed (allowing signup): ${(error as Error).message}`)
      }
    }

    // per-IP: atomic INCR keyed on the client IP with the configured window TTL.
    // The limiter fails open internally (returns null), so a null count never
    // refuses.
    if (limits.perIpMax > 0 && this.signupRateLimiter !== undefined && ipAddress) {
      const ipCount = await this.signupRateLimiter.incrementAndCount(
        `signup:ip:${ipAddress}`,
        limits.perIpWindowHours * 3600,
      )
      if (ipCount !== null && ipCount > limits.perIpMax) {
        return { success: false, errorMessage: 'User registration is currently not allowed.' }
      }
    }

    // per-device (SOFT): same mechanism keyed on the CLIENT-SUPPLIED device id,
    // enforced ONLY when the client actually sent one. Best-effort speed bump.
    if (limits.perDeviceMax > 0 && this.signupRateLimiter !== undefined && deviceId) {
      const deviceCount = await this.signupRateLimiter.incrementAndCount(
        `signup:dev:${deviceId}`,
        limits.perDeviceWindowHours * 3600,
      )
      if (deviceCount !== null && deviceCount > limits.perDeviceMax) {
        return { success: false, errorMessage: 'User registration is currently not allowed.' }
      }
    }

    return undefined
  }

  /**
   * Standard Red Notes: resolves the effective signup-cap policy (persisted admin
   * overlay -> env -> default). Never throws — a resolver failure or an unwired
   * resolver degrades to DEFAULT_SIGNUP_LIMITS (all caps off) so registration is
   * never taken down by an unreadable overlay.
   */
  private async resolveSignupLimits(): Promise<SignupLimitsConfig> {
    if (this.signupLimitsResolver === undefined) {
      return DEFAULT_SIGNUP_LIMITS
    }

    try {
      return await this.signupLimitsResolver.resolve()
    } catch {
      return DEFAULT_SIGNUP_LIMITS
    }
  }

  /**
   * Standard Red Notes: GLOBAL registration gates read off the resolved policy.
   *   - #12 TIME WINDOW: refuse when now < signupsOpenAt (not yet open) or
   *     now > signupsCloseAt (closed), evaluated against the SERVER clock in UTC.
   *     Either bound may be null (open-ended). A malformed persisted value was
   *     already cleared to null by the resolver, so it can never wedge signups.
   *   - #11 MAX-TOTAL-ACCOUNTS: when maxTotalAccounts > 0, refuse once the total
   *     user count reaches it. FAILS OPEN on a count error (a broken count must
   *     never block a legitimate signup — matches the caps' philosophy). A
   *     pending-approval signup still creates a real row, so it counts here too.
   * A single generic non-enumerable message is used for both.
   */
  private async enforceRegistrationGates(config: RegistrationConfig): Promise<RegisterResponse | undefined> {
    const now = this.timer.getUTCDate()

    if (config.signupsOpenAt !== null) {
      const openAt = new Date(config.signupsOpenAt)
      if (!Number.isNaN(openAt.getTime()) && now.getTime() < openAt.getTime()) {
        return { success: false, errorMessage: 'User registration is currently not allowed.' }
      }
    }
    if (config.signupsCloseAt !== null) {
      const closeAt = new Date(config.signupsCloseAt)
      if (!Number.isNaN(closeAt.getTime()) && now.getTime() > closeAt.getTime()) {
        return { success: false, errorMessage: 'User registration is currently not allowed.' }
      }
    }

    if (config.maxTotalAccounts > 0) {
      try {
        const total = await this.userRepository.countAll()
        if (total >= config.maxTotalAccounts) {
          return { success: false, errorMessage: 'User registration is currently not allowed.' }
        }
      } catch (error) {
        this.logger?.error(`Signup total-accounts cap check failed (allowing signup): ${(error as Error).message}`)
      }
    }

    return undefined
  }

  /**
   * Standard Red Notes: the SIGNUP INVITE gate. Returns `{ refuse }` to reject the
   * registration, or `{ invite }` (the consumed invite metadata, or null when no
   * invite applies) to allow it.
   *
   * INVITE-ONLY (config.inviteOnly === true) — FAIL CLOSED: a valid, non-exhausted,
   * non-expired, non-revoked, domain-matching token is REQUIRED. A missing token,
   * an unwired consumer, or an invalid/errored consume all refuse with a SINGLE
   * generic non-enumerable message. A DB outage blocking signups is acceptable
   * when signups are intentionally restricted.
   *
   * OPEN mode (inviteOnly === false) — FAIL OPEN: a token is optional. When present
   * it is still honored + consumed (so batch links work in open mode); but an
   * invalid/errored token (or an unwired consumer) simply proceeds as a normal
   * open signup — the link is a bonus, not a gate.
   */
  private async resolveInviteConsume(
    config: RegistrationConfig,
    inviteToken: string | undefined,
    email: string,
    newUserUuid: string,
  ): Promise<{ refuse: RegisterResponse } | { invite: (ConsumeSignupInviteResponse & { outcome: 'consumed' }) | null }> {
    const inviteOnly = config.inviteOnly === true
    const token = typeof inviteToken === 'string' ? inviteToken.trim() : ''

    // Open mode with no token: nothing to do.
    if (!inviteOnly && token.length === 0) {
      return { invite: null }
    }

    // Invite-only with no token, or no consumer wired: FAIL CLOSED.
    if (inviteOnly && (this.signupInviteConsumer === undefined || token.length === 0)) {
      return { refuse: { success: false, errorMessage: 'User registration is currently not allowed.' } }
    }

    // Open mode with a token but no consumer wired: FAIL OPEN (ignore the token).
    if (this.signupInviteConsumer === undefined) {
      return { invite: null }
    }

    const result = await this.signupInviteConsumer.execute({
      token,
      email,
      newUserUuid,
      now: this.timer.getUTCDate(),
    })

    if (result.outcome === 'consumed') {
      return { invite: result }
    }

    // invalid / error.
    if (inviteOnly) {
      return { refuse: { success: false, errorMessage: 'User registration is currently not allowed.' } }
    }

    return { invite: null }
  }

  /**
   * Standard Red Notes: normalizes a requested workspace name. An absent, empty
   * or whitespace-only value collapses to the reserved 'default' workspace,
   * matching the database column default and preserving the legacy
   * one-account-per-email semantics for the default workspace.
   */
  private normalizeWorkspaceIdentifier(requested?: string): string {
    const trimmed = (requested ?? '').trim()

    return trimmed.length === 0 ? 'default' : trimmed
  }

  private shouldActivateStandardRedFullFeatures(): boolean {
    return this.standardRedEntitlementMode === 'provisioned-full' && this.activatePremiumFeatures !== undefined
  }

  private standardRedSubscriptionIdForUser(userUuid: string): number {
    let hash = 0
    for (const character of userUuid) {
      hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000_000
    }

    return 1_000_000_000 + hash
  }
}
