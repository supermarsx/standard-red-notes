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
} from '../Registration/RegistrationConfig'
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

    let user = new User()
    user.uuid = uuidv4()
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
    // to a canonical NON-admin role; CORE_USER by default). If the configured
    // role is somehow not seeded in the database, fall back to CORE_USER so a new
    // account is never left role-less by a misconfiguration.
    const roles = []
    let defaultRole = await this.roleRepository.findOneByName(registrationConfig.defaultRole)
    if (!defaultRole && registrationConfig.defaultRole !== RoleName.NAMES.CoreUser) {
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
