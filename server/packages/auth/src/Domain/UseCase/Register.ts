import * as bcrypt from 'bcryptjs'
import { RoleName, SubscriptionPlanName, Username } from '@standardnotes/domain-core'
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
  ) {}

  async execute(dto: RegisterDTO): Promise<RegisterResponse> {
    // TODO(standard-red-notes): the in-app admin panel persists a
    // REGISTRATION_DISABLED setting (see BaseAdminController.setRegistrationFlag).
    // To make that toggle take effect at runtime without a redeploy, this check
    // should also consult that persisted flag here (via a GetSetting lookup)
    // instead of relying solely on the boot-time DISABLE_USER_REGISTRATION env.
    if (this.disableUserRegistration) {
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

    const roles = []
    const defaultRole = await this.roleRepository.findOneByName(RoleName.NAMES.CoreUser)
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
