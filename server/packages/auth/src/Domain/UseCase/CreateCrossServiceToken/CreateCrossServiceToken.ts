import { CrossServiceTokenData, TokenEncoderInterface } from '@standardnotes/security'
import { Result, RoleName, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { gt } from 'semver'

import { ProjectorInterface } from '../../../Projection/ProjectorInterface'
import { Role } from '../../Role/Role'
import { Session } from '../../Session/Session'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateCrossServiceTokenDTO } from './CreateCrossServiceTokenDTO'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetActiveSessionsForUser } from '../GetActiveSessionsForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'

export class CreateCrossServiceToken implements UseCaseInterface<string> {
  constructor(
    private userProjector: ProjectorInterface<User>,
    private sessionProjector: ProjectorInterface<Session>,
    private roleProjector: ProjectorInterface<Role>,
    private tokenEncoder: TokenEncoderInterface<CrossServiceTokenData>,
    private userRepository: UserRepositoryInterface,
    private jwtTTL: number,
    private getRegularSubscription: GetRegularSubscriptionForUser,
    private getSubscriptionSettingUseCase: GetSubscriptionSetting,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
    private getActiveSessions: GetActiveSessionsForUser,
    private applicationVersionThresholdForTokenVersion2: string | undefined,
    private applicationVersionThresholdForTokenVersion3: string | undefined,
    private settingRepository: SettingRepositoryInterface,
    // Standard Red Notes: RBAC group repository so tokens carry GROUP-CONFERRED
    // roles too (a user's effective roles are direct ∪ group roles). Optional so
    // existing tests that construct this use case with the original arity keep
    // compiling; when absent, tokens carry direct roles only (previous behavior).
    private groupRepository?: GroupRepositoryInterface,
  ) {}

  /**
   * Standard Red Notes: collaboration + live-sync are per-user gated. Default is
   * ENABLED when the setting is unset; only the literal value 'false' disables
   * the feature (opt-in disable). Read directly from the auth settings store at
   * token-mint time so the booleans ride along in the cross-service token.
   */
  private async readGatingFlag(userUuid: string, settingName: string): Promise<boolean> {
    const setting = await this.settingRepository.findLastByNameAndUserUuid(settingName, userUuid)
    if (setting === null) {
      return true
    }
    return (setting.props.value as string | null) !== 'false'
  }

  /**
   * Standard Red Notes: OPT-IN (default-off) per-user gate, the inverse of
   * readGatingFlag. Returns true ONLY when the setting is literally 'true'.
   * Used for admin-managed flags that must FAIL CLOSED when never set (e.g.
   * WORKFLOWS_ENABLED — the n8n workflows feature).
   */
  private async readOptInGatingFlag(userUuid: string, settingName: string): Promise<boolean> {
    const setting = await this.settingRepository.findLastByNameAndUserUuid(settingName, userUuid)
    if (setting === null) {
      return false
    }
    return (setting.props.value as string | null) === 'true'
  }

  /**
   * Standard Red Notes: read a per-user numeric setting (e.g. AI_REQUEST_LIMIT)
   * at token-mint time. Returns undefined when unset/non-positive/unparseable so
   * the api-gateway falls back to the global cap.
   */
  private async readNumericSetting(userUuid: string, settingName: string): Promise<number | undefined> {
    const setting = await this.settingRepository.findLastByNameAndUserUuid(settingName, userUuid)
    if (setting === null) {
      return undefined
    }
    const parsed = parseInt(`${setting.props.value as string | null}`, 10)
    if (Number.isNaN(parsed) || parsed <= 0) {
      return undefined
    }
    return parsed
  }

  async execute(dto: CreateCrossServiceTokenDTO): Promise<Result<string>> {
    let user: User | undefined | null = dto.user
    if (user === undefined && dto.userUuid !== undefined) {
      const userUuidOrError = Uuid.create(dto.userUuid)
      if (userUuidOrError.isFailed()) {
        return Result.fail(userUuidOrError.getError())
      }
      const userUuid = userUuidOrError.getValue()

      user = await this.userRepository.findOneByUuid(userUuid)
    }

    if (!user) {
      return Result.fail(`Could not find user with uuid ${dto.userUuid}`)
    }

    const roles = await user.roles
    // Single-tier, fully-free instance: every user is treated as Pro. No content
    // size limit here, and projectRoles() below guarantees the Pro role so all
    // role-gated server features (full revision history, unlimited shared vaults,
    // etc.) are unlocked for everyone.
    const hasContentLimit = false

    const sharedVaultAssociations = await this.sharedVaultUserRepository.findByUserUuid(
      Uuid.create(user.uuid).getValue(),
    )

    const applicationVersionThresholds = {
      2: this.applicationVersionThresholdForTokenVersion2,
      3: this.applicationVersionThresholdForTokenVersion3,
    }

    const authTokenData: CrossServiceTokenData = {
      user: this.projectUser(user),
      roles: this.projectRoles(roles, user.email, await this.groupConferredRoleNames(user.uuid)),
      shared_vault_owner_context: undefined,
      belongs_to_shared_vaults: sharedVaultAssociations.map((association) => ({
        shared_vault_uuid: association.props.sharedVaultUuid.value,
        permission: association.props.permission.value,
      })),
      hasContentLimit: hasContentLimit,
      version: this.determineTokenVersion(applicationVersionThresholds, dto.applicationVersion),
      collaboration_enabled: await this.readGatingFlag(user.uuid, SettingName.NAMES.CollaborationEnabled),
      live_sync_enabled: await this.readGatingFlag(user.uuid, SettingName.NAMES.LiveSyncEnabled),
      // Standard Red Notes: per-user AI gating + metering (default-on; an admin
      // disabling AI_ENABLED for an abusive user rides along here so the
      // api-gateway can FAIL CLOSED before spending the provider key).
      ai_enabled: await this.readGatingFlag(user.uuid, SettingName.NAMES.AiEnabled),
      ai_request_limit: await this.readNumericSetting(user.uuid, SettingName.NAMES.AiRequestLimit),
    }

    // Standard Red Notes: WORKFLOWS is OPT-IN (default-off) — the field is
    // emitted ONLY when the admin-managed WorkflowsEnabled setting is literally
    // 'true'. Absent means disabled, so pre-existing tokens (and the spec'd
    // payload shape) stay byte-identical for non-entitled users.
    if (await this.readOptInGatingFlag(user.uuid, SettingName.NAMES.WorkflowsEnabled)) {
      authTokenData.workflows_enabled = true
    }

    // Standard Red Notes: SERVER-SIDE OCR is OPT-IN (default-off), same shape as
    // WORKFLOWS above — the field is emitted ONLY when the admin-managed
    // OcrServerAllowed setting is literally 'true'. Absent means not allowed, so
    // the api-gateway OcrController FAILS CLOSED (server OCR is an E2E downgrade)
    // and pre-existing tokens for non-entitled users stay byte-identical.
    if (await this.readOptInGatingFlag(user.uuid, SettingName.NAMES.OcrServerAllowed)) {
      authTokenData.ocr_server_allowed = true
    }

    // Standard Red Notes: SHADOW-BAN projection. A shadow-banned user is NOT
    // rejected (SignIn / AuthenticateUser let them through — isAccessBlocked is
    // false for shadow), but we ride the marker along so downstream services
    // (syncing-server) can SILENTLY degrade their service. OPT-IN shape: the
    // field is emitted ONLY when the user is actively shadow-banned, so every
    // pre-existing token stays byte-identical. Never surfaced to the user.
    if (user.isShadowBanned()) {
      authTokenData.shadow_banned = true
    }

    if (dto.sharedVaultOwnerContext !== undefined) {
      const regularSubscriptionOrError = await this.getRegularSubscription.execute({
        userUuid: dto.sharedVaultOwnerContext,
      })
      if (regularSubscriptionOrError.isFailed()) {
        return Result.fail(regularSubscriptionOrError.getError())
      }
      const regularSubscription = regularSubscriptionOrError.getValue()

      const uploadBytesLimitSettingOrError = await this.getSubscriptionSettingUseCase.execute({
        settingName: SettingName.NAMES.FileUploadBytesLimit,
        userSubscriptionUuid: regularSubscription.uuid,
        allowSensitiveRetrieval: false,
      })
      if (uploadBytesLimitSettingOrError.isFailed()) {
        return Result.fail(uploadBytesLimitSettingOrError.getError())
      }
      const uploadBytesLimitSetting = uploadBytesLimitSettingOrError.getValue()
      const uploadBytesLimit = parseInt(uploadBytesLimitSetting.setting.props.value as string)

      authTokenData.shared_vault_owner_context = {
        upload_bytes_limit: uploadBytesLimit,
      }
    }

    let resolvedSession: Session | undefined = undefined
    if (dto.session !== undefined) {
      resolvedSession = dto.session
      authTokenData.session = this.projectSession(dto.session)
    } else if (dto.sessionUuid !== undefined) {
      const activeSessionsResponse = await this.getActiveSessions.execute({
        userUuid: user.uuid,
        sessionUuid: dto.sessionUuid,
      })
      if (activeSessionsResponse.sessions.length) {
        resolvedSession = activeSessionsResponse.sessions[0]
        authTokenData.session = this.projectSession(activeSessionsResponse.sessions[0])
      }
    }

    // Standard Red Notes: thread MCP scope from the session into the
    // cross-service token. read/write derives from `readonlyAccess` (reused),
    // and the optional tag-scope is carried verbatim for client-side enforcement.
    if (resolvedSession !== undefined) {
      const mcpScope = this.projectMcpScope(resolvedSession)
      if (mcpScope !== undefined) {
        authTokenData.mcp_scope = mcpScope
      }
    }

    return Result.ok(this.tokenEncoder.encodeExpirableToken(authTokenData, this.jwtTTL))
  }

  private projectUser(user: User): { uuid: string; email: string } {
    return this.userProjector.projectSimple(user) as { uuid: string; email: string }
  }

  private projectSession(session: Session): {
    uuid: string
    api_version: string
    created_at: string
    updated_at: string
    device_info: string
    readonly_access: boolean
    access_expiration: string
    refresh_expiration: string
  } {
    return this.sessionProjector.projectSimple(session) as {
      uuid: string
      api_version: string
      created_at: string
      updated_at: string
      device_info: string
      readonly_access: boolean
      access_expiration: string
      refresh_expiration: string
    }
  }

  private projectMcpScope(session: Session): { access: 'read' | 'write'; tagUuids?: string[] } | undefined {
    let tagUuids: string[] | undefined = undefined
    if (session.mcpScopeTagUuids !== null && session.mcpScopeTagUuids !== undefined) {
      try {
        const parsed = JSON.parse(session.mcpScopeTagUuids)
        if (Array.isArray(parsed) && parsed.length > 0) {
          tagUuids = parsed as string[]
        }
      } catch {
        tagUuids = undefined
      }
    }

    // Only emit mcp_scope when the session actually carries a tag-scope. A plain
    // read/write MCP session without tag-scope is already fully represented by
    // `session.readonly_access`, which the syncing-server enforces. Emitting
    // mcp_scope for every readonly session would mislabel non-MCP sessions.
    if (tagUuids === undefined) {
      return undefined
    }

    return {
      access: session.readonlyAccess ? 'read' : 'write',
      tagUuids,
    }
  }

  /**
   * Standard Red Notes: resolve the role names conferred by the RBAC groups the
   * user belongs to. These are unioned into the token's roles at MINT time so
   * a role granted via a group (e.g. INTERNAL_TEAM_USER through an "admins"
   * group) is honored by role-gated endpoints exactly like a directly-assigned
   * role — without it, effective roles and token roles diverge forever and a
   * genuine admin is denied (403) no matter how often the session refreshes.
   * Best-effort: a group-lookup failure must never block token minting.
   */
  private async groupConferredRoleNames(userUuid: string): Promise<string[]> {
    if (this.groupRepository === undefined) {
      return []
    }

    try {
      const groups = await this.groupRepository.findByUserUuid(Uuid.create(userUuid).getValue())
      const roleNames = new Set<string>()
      for (const group of groups) {
        for (const roleName of group.props.roleNames) {
          roleNames.add(roleName)
        }
      }

      return Array.from(roleNames)
    } catch {
      return []
    }
  }

  private projectRoles(
    roles: Array<Role>,
    email?: string,
    groupConferredRoleNames: string[] = [],
  ): Array<{ uuid: string; name: string }> {
    const projected = roles.map((role) => this.roleProjector.projectSimple(role) as { uuid: string; name: string })
    // Single-tier, fully-free instance: guarantee every user carries the Pro role
    // so role-gated server features (revision history beyond 30/365 days,
    // shared-vault count limits, etc.) are unlocked for everyone.
    if (!projected.some((role) => role.name === RoleName.NAMES.ProUser)) {
      projected.push({ uuid: `singletier-${RoleName.NAMES.ProUser}`, name: RoleName.NAMES.ProUser })
    }
    // Designate admins via the ADMIN_EMAILS env (comma-separated). These users
    // carry the InternalTeamUser role, which unlocks the in-app Admin panel and
    // the /admin endpoints that manage other users' feature flags.
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    if (email && adminEmails.includes(email.toLowerCase())) {
      if (!projected.some((role) => role.name === RoleName.NAMES.InternalTeamUser)) {
        projected.push({ uuid: `admin-${RoleName.NAMES.InternalTeamUser}`, name: RoleName.NAMES.InternalTeamUser })
      }
    }
    // Standard Red Notes: union in RBAC group-conferred role names so the token
    // reflects the user's EFFECTIVE roles (direct ∪ group). Synthetic uuids,
    // mirroring the Pro/admin injections above — consumers key off `name`.
    for (const roleName of groupConferredRoleNames) {
      if (!projected.some((role) => role.name === roleName)) {
        projected.push({ uuid: `group-${roleName}`, name: roleName })
      }
    }
    return projected
  }

  // TODO: Eventually roll out all clients to use version 3
  private determineTokenVersion(
    applicationVersionThresholds: Record<number, string | undefined>,
    applicationVersion?: string,
  ): number {
    let tokenVersion = 1
    // Default to version 1
    if (!applicationVersion) {
      return tokenVersion
    }

    // Extract version number from application version string (format: environment-version, e.g., "web-4.21.0")
    const versionMatch = applicationVersion.match(/(\d+\.\d+\.\d+)/)

    if (!versionMatch) {
      return tokenVersion
    }

    const semver = versionMatch[1]

    for (const [version, threshold] of Object.entries(applicationVersionThresholds)) {
      const versionNumber = parseInt(version, 10)
      if (threshold && gt(semver, threshold) && versionNumber > tokenVersion) {
        tokenVersion = versionNumber
      }
    }

    return tokenVersion
  }
}
