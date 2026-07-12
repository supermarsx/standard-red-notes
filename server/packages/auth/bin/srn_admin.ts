import 'reflect-metadata'

/**
 * Standard Red Notes: in-container admin CLI ("srn-admin").
 *
 * Runs INSIDE the auth container (same DI container + DataSource as the other
 * maintenance bins, in the lean 'cli' mode so it never runs migrations and
 * skips the SNS/SQS/S3 clients) and performs admin operations by reusing the
 * auth package's own use-cases and repositories — no HTTP, no admin session.
 *
 * FAST START: this file keeps its static imports tiny (domain-core, the TYPES
 * symbol table and the pure CLI helpers). The DI container — DataSource, Redis,
 * hundreds of bindings — is imported LAZILY, only for commands that need the
 * database. `help`, unknown commands, argument errors and the read-only
 * diagnostics (`status`, `logs`, `config`, `roles list`, `flags list`) never
 * pay for it.
 *
 * Invoke via:
 *   docker compose exec server srn-admin <command> [args]
 */

import { promises as fsPromises } from 'fs'
import * as net from 'net'
import * as path from 'path'
import { randomUUID } from 'crypto'

import { Email, RoleName, SettingName, Uuid, type MapperInterface } from '@standardnotes/domain-core'

import TYPES from '../src/Bootstrap/Types'
import { AuditAction } from '../src/Domain/AuditLog/AuditAction'
import type { AuditLogWriterInterface } from '../src/Domain/AuditLog/AuditLogWriterInterface'
import type { AuditLogEntry } from '../src/Domain/AuditLog/AuditLogEntry'
import type { AuditLogEntryHttpProjection } from '../src/Infra/Http/Projection/AuditLogEntryHttpProjection'
import type { RoleServiceInterface } from '../src/Domain/Role/RoleServiceInterface'
import type { SettingRepositoryInterface } from '../src/Domain/Setting/SettingRepositoryInterface'
import type { BanType, User } from '../src/Domain/User/User'
import type { AdminUserRow, UserRepositoryInterface } from '../src/Domain/User/UserRepositoryInterface'
import type { Webhook } from '../src/Domain/Webhook/Webhook'
import type { WebhookRepositoryInterface } from '../src/Domain/Webhook/WebhookRepositoryInterface'

import {
  ADMIN_ROLE_NAME,
  CLI_MANAGEABLE_FLAGS,
  CliLogEntry,
  IP_ACL_ALLOW_KEY,
  IP_ACL_BLOCK_KEY,
  IpAclList,
  OPERATOR_ENVS,
  STORAGE_LIMIT_SETTING,
  STORAGE_USED_SETTING,
  findFlagSpec,
  formatBytes,
  formatTable,
  helpFor,
  matchGroupUuidInList,
  parseArgs,
  parseBanOptions,
  parseDateFilter,
  parseEnvFileContent,
  parseStorageLimitInput,
  resolveOperatorEnv,
  serviceProbeTargets,
  stringOption,
  tailLogFiles,
  usage,
  validateCliIpEntry,
  validateFlagValue,
  type GroupLike,
  type OperatorService,
  type ParsedArgs,
} from '../src/Infra/Cli/SrnAdminCli'
import { ServerSettingsOverlayReader } from '../src/Infra/FS/ServerSettingsOverlayReader'
import {
  EnvRegistrationConfigResolver,
  registrationBaselineFromEnv,
} from '../src/Infra/Registration/EnvRegistrationConfigResolver'
import { ASSIGNABLE_DEFAULT_ROLE_NAMES, isAssignableDefaultRole } from '../src/Domain/Role/CanonicalRoles'
import {
  EMAIL_CONFIRMATION_GATING_MODES,
  isEmailConfirmationGatingMode,
  isRegistrationDomainMode,
  normalizeDomainList,
  REGISTRATION_DOMAIN_MODES,
  type RegistrationConfig,
  type RegistrationConfigOverlay,
} from '../src/Domain/Registration/RegistrationConfig'

/* ---------------------------------------------------------------------------
 * Small shared shapes so use cases can be driven through the container without
 * importing each one's module (keeps the lazy-boot property).
 * ------------------------------------------------------------------------- */

type ResultLike<T> = { isFailed(): boolean; getError(): string; getValue(): T }
type UseCase<Dto, T = unknown> = { execute(dto: Dto): Promise<ResultLike<T>> }
// DeleteSetting predates the Result<T> convention and returns a plain object.
type DeleteSettingLike = {
  execute(dto: {
    userUuid: string
    settingName: string
    softDelete?: boolean
  }): Promise<{ success: boolean; error?: { message: string } }>
}

const out = (text: string): boolean => process.stdout.write(text)
const outLine = (text: string): boolean => process.stdout.write(text + '\n')
const outJson = (value: unknown): boolean => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
const errLine = (text: string): boolean => process.stderr.write(text + '\n')

class UsageError extends Error {}

function requireResult<T>(result: ResultLike<T>): T {
  if (result.isFailed()) {
    throw new Error(result.getError())
  }

  return result.getValue()
}

/* ---------------------------------------------------------------------------
 * Container-free IO helpers (status / logs / config)
 * ------------------------------------------------------------------------- */

function packagesRoot(): string {
  // dist/bin/srn_admin.js -> dist -> auth -> packages
  return process.env.SRN_PACKAGES_DIR ?? path.resolve(__dirname, '..', '..', '..')
}

async function readPackageEnv(packageName: string): Promise<Record<string, string>> {
  try {
    const content = await fsPromises.readFile(path.join(packagesRoot(), packageName, '.env'), 'utf8')

    return parseEnvFileContent(content)
  } catch {
    return {}
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(ok)
      }
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

interface ReadinessProbe {
  name: string
  port: number
  reachable: boolean
  status: 'ok' | 'degraded' | 'down'
  checks?: Record<string, boolean>
  detail?: string
}

async function probeReadiness(name: string, port: number): Promise<ReadinessProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthcheck/readiness`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    let body: { status?: string; checks?: Record<string, boolean> } = {}
    try {
      body = (await response.json()) as typeof body
    } catch {
      /* non-JSON readiness body — status code is still authoritative */
    }
    if (response.status === 200) {
      return { name, port, reachable: true, status: 'ok', checks: body.checks }
    }
    if (response.status === 503) {
      return { name, port, reachable: true, status: 'degraded', checks: body.checks, detail: 'readiness unavailable' }
    }

    return { name, port, reachable: true, status: 'down', detail: `unexpected status ${response.status}` }
  } catch {
    return { name, port, reachable: false, status: 'down', detail: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------------------------------------------------------------------
 * Lazy container boot
 * ------------------------------------------------------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContainerLike = { get<T = any>(symbol: symbol): T }

let containerPromise: Promise<ContainerLike> | undefined

async function loadContainer(): Promise<ContainerLike> {
  if (containerPromise === undefined) {
    containerPromise = (async () => {
      // Deferred require: this line pulls in the full auth module graph
      // (TypeORM, ioredis, AWS SDK, every use case) — the expensive part of a
      // CLI invocation — so only DB-backed commands pay for it.
      const { ContainerConfigLoader } = await import('../src/Bootstrap/Container')

      return (await new ContainerConfigLoader('cli').load()) as unknown as ContainerLike
    })()
  }

  return containerPromise
}

async function resolveUser(container: ContainerLike, identifier: string | undefined): Promise<User> {
  if (!identifier) {
    throw new UsageError('a <user> (email or uuid) is required')
  }
  const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)

  const asUuid = Uuid.create(identifier)
  if (!asUuid.isFailed()) {
    const byUuid = await userRepository.findOneByUuid(asUuid.getValue())
    if (byUuid) {
      return byUuid
    }
  }
  const asEmail = Email.create(identifier)
  if (!asEmail.isFailed()) {
    const byEmail = await userRepository.findOneByUsernameOrEmail(asEmail.getValue())
    if (byEmail) {
      return byEmail
    }
  }
  throw new Error(`no user found for "${identifier}"`)
}

/** Best-effort audit entry for CLI mutations (never fails the operation). */
async function writeAudit(
  container: ContainerLike,
  action: string,
  target: { type: string; uuid: string | null },
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const writer = container.get<AuditLogWriterInterface>(TYPES.Auth_AuditLogWriter)
    await writer.write({
      actorUuid: null,
      action,
      targetType: target.type,
      targetUuid: target.uuid,
      ip: null,
      metadata: { ...metadata, via: 'srn-admin' },
    })
  } catch {
    /* the audit writer is itself best-effort; a missing binding must not break the CLI */
  }
}

/* ---------------------------------------------------------------------------
 * USERS
 * ------------------------------------------------------------------------- */

async function cmdUsersList(args: ParsedArgs): Promise<number> {
  const { options } = args

  const limitRaw = stringOption(options, 'limit')
  const offsetRaw = stringOption(options, 'offset')
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 100
  const offset = offsetRaw !== undefined ? Number.parseInt(offsetRaw, 10) : 0
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(offset) || offset < 0) {
    throw new UsageError('--limit must be a positive integer and --offset a non-negative integer')
  }

  const sortRaw = stringOption(options, 'sort') ?? 'createdAt'
  if (!['createdAt', 'email', 'updatedAt'].includes(sortRaw)) {
    throw new UsageError(`invalid --sort '${sortRaw}' (createdAt | email | updatedAt)`)
  }

  const bannedRaw = stringOption(options, 'banned')
  if (bannedRaw !== undefined && !['true', 'false'].includes(bannedRaw)) {
    throw new UsageError("--banned takes 'true' or 'false'")
  }

  const suspendedRaw = stringOption(options, 'suspended')
  if (suspendedRaw !== undefined && !['true', 'false'].includes(suspendedRaw)) {
    throw new UsageError("--suspended takes 'true' or 'false'")
  }

  const subscriptionRaw = stringOption(options, 'subscription')
  if (subscriptionRaw !== undefined && !['active', 'inactive', 'none'].includes(subscriptionRaw)) {
    throw new UsageError('--subscription takes active | inactive | none')
  }

  const parseDateOption = (name: string): number | undefined => {
    const raw = stringOption(options, name)
    if (raw === undefined) {
      return undefined
    }
    const parsed = parseDateFilter(raw)
    if (parsed === undefined) {
      throw new UsageError(`invalid --${name} '${raw}' (use ISO-8601 or epoch milliseconds)`)
    }

    return parsed
  }
  const createdAfter = parseDateOption('created-after')
  const createdBefore = parseDateOption('created-before')

  const container = await loadContainer()
  const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)

  const result = await userRepository.findUsersForAdmin({
    limit,
    offset,
    sort: sortRaw as 'createdAt' | 'email' | 'updatedAt',
    email: stringOption(options, 'email'),
    role: stringOption(options, 'role'),
    banned: bannedRaw !== undefined ? bannedRaw === 'true' : undefined,
    suspended: suspendedRaw !== undefined ? suspendedRaw === 'true' : undefined,
    subscription: subscriptionRaw as 'active' | 'inactive' | 'none' | undefined,
    createdAfter,
    createdBefore,
  })

  if (options.json === true) {
    outJson({ users: result.rows, total: result.total, limit, offset })

    return 0
  }

  if (result.rows.length === 0) {
    outLine('(no users match)')

    return 0
  }

  const rows = result.rows.map((row: AdminUserRow) => [
    row.email,
    row.uuid,
    row.createdAt.slice(0, 10),
    row.roles.join(',') || '-',
    row.banned ? 'yes' : 'no',
    row.suspended ? 'yes' : 'no',
    row.mfaEnabled ? 'on' : 'off',
    `${formatBytes(row.storageUsedBytes)} / ${formatBytes(row.storageLimitBytes)}`,
  ])
  outLine(formatTable(['EMAIL', 'UUID', 'CREATED', 'ROLES', 'BANNED', 'SUSPENDED', 'MFA', 'STORAGE USED/LIMIT'], rows))
  outLine(`\n${offset + 1}-${offset + result.rows.length} of ${result.total} user(s)`)

  return 0
}

async function cmdUser(args: ParsedArgs): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError('user <user> — a <user> (email or uuid) is required')
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)
  const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)

  // Reuse the admin list finder's batched enrichment (roles, subscription,
  // MFA, storage) so the CLI shows exactly what the admin panel shows.
  const adminList = await userRepository.findUsersForAdmin({
    limit: 100,
    offset: 0,
    sort: 'createdAt',
    email: user.email,
  })
  const row = adminList.rows.find((candidate) => candidate.uuid === user.uuid)

  // Effective roles/permissions (direct + group-conferred).
  let effective:
    | { directRoleNames: string[]; groupRoleNames: string[]; effectiveRoleNames: string[]; effectivePermissionNames: string[] }
    | undefined
  try {
    const getEffective = container.get<UseCase<{ userUuid: string }>>(TYPES.Auth_GetUserEffectivePermissions)
    effective = requireResult(await getEffective.execute({ userUuid: user.uuid })) as typeof effective
  } catch {
    /* effective-permissions use case unavailable; direct roles still shown */
  }

  const getSetting = container.get<
    UseCase<
      { userUuid: string; settingName: string; allowSensitiveRetrieval: boolean; decrypted: boolean },
      { decryptedValue?: string | null }
    >
  >(TYPES.Auth_GetSetting)

  const flags: Record<string, string | null> = {}
  for (const spec of CLI_MANAGEABLE_FLAGS) {
    const result = await getSetting.execute({
      userUuid: user.uuid,
      settingName: spec.name,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })
    flags[spec.name] = result.isFailed() ? null : (result.getValue().decryptedValue ?? null)
  }

  // Existence-only probe (never decrypts) — mirrors the panel's read-only
  // "Nextcloud destination configured?" indicator.
  const appPassword = await getSetting.execute({
    userUuid: user.uuid,
    settingName: SettingName.NAMES.NextcloudBackupAppPassword,
    allowSensitiveRetrieval: true,
    decrypted: false,
  })
  const nextcloudConfigured = !appPassword.isFailed()

  const directRoles = (await user.roles).map((role) => role.name)

  if (args.options.json === true) {
    outJson({
      uuid: user.uuid,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      banned: user.isBanned(),
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      banReason: user.banReason ?? null,
      banType: user.effectiveBanType(),
      bannedUntil: user.bannedUntil ? new Date(user.bannedUntil).toISOString() : null,
      shadowBanned: user.isShadowBanned(),
      suspended: user.isSuspended(),
      suspendedAt: user.suspendedAt ? new Date(user.suspendedAt).toISOString() : null,
      suspendedReason: user.suspendedReason ?? null,
      mfaEnabled: row?.mfaEnabled ?? null,
      roles: {
        direct: directRoles,
        groupConferred: effective?.groupRoleNames ?? null,
        effective: effective?.effectiveRoleNames ?? directRoles,
      },
      effectivePermissions: effective?.effectivePermissionNames ?? null,
      subscription: row?.subscription ?? null,
      storage: { usedBytes: row?.storageUsedBytes ?? null, limitBytes: row?.storageLimitBytes ?? null },
      flags,
      nextcloudAppPasswordConfigured: nextcloudConfigured,
    })

    return 0
  }

  outLine(`uuid:     ${user.uuid}`)
  outLine(`email:    ${user.email}`)
  outLine(`created:  ${user.createdAt.toISOString()}`)
  outLine(
    `banned:   ${
      user.isBanned()
        ? `yes [${user.effectiveBanType()}] (since ${user.bannedAt?.toISOString() ?? '?'}${
            user.effectiveBanType() === 'temporary' && user.bannedUntil
              ? `, until ${new Date(user.bannedUntil).toISOString()}`
              : ''
          }${user.banReason ? `, reason: ${user.banReason}` : ''})`
        : 'no'
    }`,
  )
  outLine(
    `suspended: ${
      user.isSuspended()
        ? `yes (since ${user.suspendedAt ? new Date(user.suspendedAt).toISOString() : '?'}${
            user.suspendedReason ? `, reason: ${user.suspendedReason}` : ''
          })`
        : 'no'
    }`,
  )
  outLine(`mfa:      ${row ? (row.mfaEnabled ? 'on' : 'off') : 'unknown'}`)
  if (row?.subscription) {
    outLine(`plan:     ${row.subscription.plan ?? '-'} (${row.subscription.active ? 'active' : 'inactive'})`)
  }
  outLine(`storage:  ${formatBytes(row?.storageUsedBytes ?? null)} used / ${formatBytes(row?.storageLimitBytes ?? null)} limit`)
  outLine('')
  outLine(`direct roles:          ${directRoles.join(', ') || '(none)'}`)
  if (effective) {
    outLine(`group-conferred roles: ${effective.groupRoleNames.join(', ') || '(none)'}`)
    outLine(`effective roles:       ${effective.effectiveRoleNames.join(', ') || '(none)'}`)
    outLine(`effective permissions: ${effective.effectivePermissionNames.join(', ') || '(none)'}`)
  }
  outLine('')
  outLine('feature flags (unset = server default):')
  for (const spec of CLI_MANAGEABLE_FLAGS) {
    outLine(`  ${spec.name.padEnd(28)} ${flags[spec.name] ?? '(default)'}`)
  }
  outLine(`  ${'NEXTCLOUD_APP_PASSWORD'.padEnd(28)} ${nextcloudConfigured ? '(configured)' : '(not configured)'}`)

  return 0
}

async function cmdBan(args: ParsedArgs, banned: boolean): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError(`${banned ? 'ban' : 'unban'} <user> — a <user> (email or uuid) is required`)
  }
  const banReason = stringOption(args.options, 'reason') ?? null

  // Standard Red Notes: richer bans. --type selects permanent (default) |
  // temporary | shadow; a temporary ban needs --until <ISO date> or
  // --duration <minutes>. The legacy `ban <user> [--reason]` form is unchanged.
  let banType: BanType = 'permanent'
  let bannedUntil: Date | null = null
  if (banned) {
    const parsed = parseBanOptions(args.options)
    if (!parsed.ok) {
      throw new UsageError(parsed.error)
    }
    banType = parsed.value.banType
    bannedUntil = parsed.value.bannedUntil
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const setUserBanStatus = container.get<
    UseCase<
      { userUuid: string; banned: boolean; banReason: string | null; banType?: BanType | null; bannedUntil?: Date | null },
      User
    >
  >(TYPES.Auth_SetUserBanStatus)
  requireResult(
    await setUserBanStatus.execute({
      userUuid: user.uuid,
      banned,
      banReason,
      banType: banned ? banType : null,
      bannedUntil,
    }),
  )

  await writeAudit(
    container,
    AuditAction.BanChanged,
    { type: 'user', uuid: user.uuid },
    { banned, banReason, banType: banned ? banType : null, bannedUntil: bannedUntil?.toISOString() ?? null },
  )

  if (banned) {
    const typeNote =
      banType === 'temporary'
        ? ` [temporary until ${bannedUntil?.toISOString()}]`
        : banType === 'shadow'
          ? ' [shadow: user still connects but sync is silently degraded]'
          : ' [permanent]'
    const effect =
      banType === 'shadow'
        ? ' Takes effect once their session token refreshes.'
        : ' Takes effect on their next authenticated request.'
    outLine(`Banned ${user.email} (${user.uuid})${banReason ? ` — reason: ${banReason}` : ''}${typeNote}.${effect}`)
  } else {
    outLine(`Unbanned ${user.email} (${user.uuid}).`)
  }

  return 0
}

async function cmdSuspend(args: ParsedArgs, suspended: boolean): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError(`${suspended ? 'suspend' : 'unsuspend'} <user> — a <user> (email or uuid) is required`)
  }
  const suspendedReason = suspended ? (stringOption(args.options, 'reason') ?? null) : null

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const setUserSuspension = container.get<
    UseCase<{ userUuid: string; suspended: boolean; suspendedReason?: string | null }, User>
  >(TYPES.Auth_SetUserSuspension)
  requireResult(await setUserSuspension.execute({ userUuid: user.uuid, suspended, suspendedReason }))

  await writeAudit(
    container,
    AuditAction.SuspensionChanged,
    { type: 'user', uuid: user.uuid },
    { suspended, suspendedReason },
  )

  if (suspended) {
    outLine(
      `Suspended ${user.email} (${user.uuid})${suspendedReason ? ` — reason: ${suspendedReason}` : ''}. ` +
        'They are signed out immediately and blocked from signing in until unsuspended.',
    )
  } else {
    outLine(`Unsuspended ${user.email} (${user.uuid}). They can sign in again.`)
  }

  return 0
}

async function cmdDeleteUser(args: ParsedArgs): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError('delete-user <user> --confirm <email> — a <user> (email or uuid) is required')
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  // Belt-and-suspenders: --confirm MUST equal the resolved email so a mistyped
  // <user> can never delete the wrong account.
  const confirm = stringOption(args.options, 'confirm')
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    throw new UsageError(
      `refusing to delete: --confirm must equal the target email (${user.email}).`,
    )
  }

  // Last-admin guard: refuse deleting the final administrator unless --force.
  const force = args.options.force === true
  if (!force) {
    const directRoles = (await user.roles).map((role) => role.name)
    if (directRoles.includes(RoleName.NAMES.AdminUser)) {
      const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)
      const admins = await userRepository.findUsersForAdmin({
        role: RoleName.NAMES.AdminUser,
        limit: 2,
        offset: 0,
        sort: 'createdAt',
      })
      if (admins.total <= 1) {
        throw new UsageError(
          'refusing to delete the last remaining administrator. Grant another admin first, or pass --force.',
        )
      }
    }
  }

  const deleteAccount = container.get<UseCase<{ userUuid: string }, string>>(TYPES.Auth_DeleteAccount)
  requireResult(await deleteAccount.execute({ userUuid: user.uuid }))

  await writeAudit(container, AuditAction.AccountDeleted, { type: 'user', uuid: user.uuid }, { email: user.email })

  outLine(
    `Deleting ${user.email} (${user.uuid}). Removal completes across services shortly ` +
      '(auth row + sessions, then items, revisions, files and analytics via the deletion event).',
  )

  return 0
}

async function cmdResetMfa(args: ParsedArgs): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError('reset-mfa <user> — a <user> (email or uuid) is required')
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const deleteSetting = container.get<DeleteSettingLike>(TYPES.Auth_DeleteSetting)
  const result = await deleteSetting.execute({
    userUuid: user.uuid,
    settingName: SettingName.NAMES.MfaSecret,
    softDelete: true,
  })
  if (!result.success) {
    throw new Error(result.error?.message ?? `No 2FA configuration found for ${user.email}.`)
  }

  await writeAudit(container, AuditAction.MfaReset, { type: 'user', uuid: user.uuid }, { name: SettingName.NAMES.MfaSecret })

  outLine(`Cleared 2FA (and recovery codes) for ${user.email} (${user.uuid})`)

  return 0
}

async function cmdFixQuota(args: ParsedArgs): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError('fix-quota <user> — a <user> (email or uuid) is required')
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const fixQuota = container.get<UseCase<{ userEmail: string }>>(TYPES.Auth_FixStorageQuotaForUser)
  requireResult(await fixQuota.execute({ userEmail: user.email }))

  await writeAudit(container, AuditAction.QuotaRecalculated, { type: 'user', uuid: user.uuid }, {})

  outLine(`Recalculated storage quota for ${user.email} (the files worker refreshes the counter asynchronously)`)

  return 0
}

/* ---------------------------------------------------------------------------
 * ROLES
 * ------------------------------------------------------------------------- */

async function cmdRolesMutate(identifier: string | undefined, roleNameRaw: string | undefined, grant: boolean): Promise<number> {
  if (!identifier || !roleNameRaw) {
    throw new UsageError(`roles ${grant ? 'grant' : 'revoke'} <user> <ROLE_NAME> — see 'srn-admin roles list'`)
  }
  const roleNameOrError = RoleName.create(roleNameRaw)
  if (roleNameOrError.isFailed()) {
    throw new UsageError(`unknown role '${roleNameRaw}'. Known roles: ${Object.values(RoleName.NAMES).join(', ')}`)
  }
  const roleName = roleNameOrError.getValue()

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)
  const roleService = container.get<RoleServiceInterface>(TYPES.Auth_RoleService)
  const userUuid = requireResult(Uuid.create(user.uuid) as ResultLike<Uuid>)

  if (grant) {
    await roleService.addRoleToUser(userUuid, roleName)
  } else {
    await roleService.removeRoleFromUser(userUuid, roleName)
  }

  await writeAudit(container, AuditAction.RoleChanged, { type: 'user', uuid: user.uuid }, { role: roleName.value, granted: grant })

  outLine(`${grant ? 'Granted' : 'Revoked'} ${roleName.value} ${grant ? 'to' : 'from'} ${user.email} (${user.uuid})`)

  return 0
}

/* ---------------------------------------------------------------------------
 * FLAGS + STORAGE LIMIT
 * ------------------------------------------------------------------------- */

function printFlagsList(): number {
  const rows = CLI_MANAGEABLE_FLAGS.map((spec) => [
    spec.name,
    spec.allowedValues ? spec.allowedValues.join(' | ') : '(free-form)',
    spec.description + (spec.cliOnly ? ' [CLI-only]' : ''),
  ])
  rows.push([STORAGE_LIMIT_SETTING, 'bytes | unlimited', "Per-user storage limit — use 'storage-limit set'"])
  outLine(formatTable(['SETTING', 'VALUES', 'DESCRIPTION'], rows))
  outLine('\nSensitive settings (MFA secrets, backup app passwords, ...) are not manageable here.')

  return 0
}

async function cmdFlagsGet(args: ParsedArgs): Promise<number> {
  const [identifier, settingRaw] = args.positionals
  if (!identifier) {
    throw new UsageError('flags get <user> [SETTING]')
  }
  const specs = settingRaw !== undefined ? [findFlagSpec(settingRaw)] : CLI_MANAGEABLE_FLAGS
  if (specs[0] === undefined) {
    throw new UsageError(`'${settingRaw}' is not an admin-manageable setting — see 'srn-admin flags list'`)
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)
  const getSetting = container.get<
    UseCase<
      { userUuid: string; settingName: string; allowSensitiveRetrieval: boolean; decrypted: boolean },
      { decryptedValue?: string | null }
    >
  >(TYPES.Auth_GetSetting)

  const values: Record<string, string | null> = {}
  for (const spec of specs as typeof CLI_MANAGEABLE_FLAGS) {
    const result = await getSetting.execute({
      userUuid: user.uuid,
      settingName: spec.name,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })
    values[spec.name] = result.isFailed() ? null : (result.getValue().decryptedValue ?? null)
  }

  if (args.options.json === true) {
    outJson({ userUuid: user.uuid, email: user.email, flags: values })

    return 0
  }

  outLine(
    formatTable(
      ['SETTING', 'VALUE'],
      Object.entries(values).map(([name, value]) => [name, value ?? '(default)']),
    ),
  )

  return 0
}

async function cmdFlagsSet(args: ParsedArgs, unset: boolean): Promise<number> {
  const [identifier, settingRaw, valueRaw] = args.positionals
  if (!identifier || !settingRaw || (!unset && valueRaw === undefined)) {
    throw new UsageError(unset ? 'flags unset <user> <SETTING>' : 'flags set <user> <SETTING> <value>')
  }

  // The storage limit is a SUBSCRIPTION setting with a dedicated path.
  if (settingRaw.toUpperCase() === STORAGE_LIMIT_SETTING) {
    if (unset) {
      throw new UsageError(`${STORAGE_LIMIT_SETTING} cannot be unset — use 'storage-limit set <user> <bytes|unlimited>'`)
    }

    return setStorageLimit(identifier, valueRaw)
  }

  const spec = findFlagSpec(settingRaw)
  if (spec === undefined) {
    throw new UsageError(
      `'${settingRaw}' is not an admin-manageable setting (sensitive/unknown settings are refused) — see 'srn-admin flags list'`,
    )
  }

  const value = unset ? null : (valueRaw as string)
  const validation = validateFlagValue(spec, value)
  if (!validation.ok) {
    throw new UsageError(validation.error)
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const setSettingValue = container.get<
    UseCase<{ settingName: string; value: string | null; userUuid: string; checkUserPermissions: boolean }>
  >(TYPES.Auth_SetSettingValue)
  requireResult(
    await setSettingValue.execute({
      settingName: spec.name,
      value,
      userUuid: user.uuid,
      checkUserPermissions: false,
    }),
  )

  // Setting NAME only, never the value (mirrors the panel's audit policy).
  await writeAudit(container, AuditAction.SettingChanged, { type: 'user', uuid: user.uuid }, { name: spec.name })

  outLine(`${unset ? 'Cleared' : 'Set'} ${spec.name}${unset ? '' : `=${value}`} for ${user.email} (${user.uuid})`)

  return 0
}

async function storageInfoForUser(
  container: ContainerLike,
  userUuid: string,
): Promise<{ subscriptionUuid: string | null; limit: number | null; used: number | null }> {
  const getRegularSubscription = container.get<UseCase<{ userUuid: string }, { uuid: string }>>(
    TYPES.Auth_GetRegularSubscriptionForUser,
  )
  const subscriptionOrError = await getRegularSubscription.execute({ userUuid })
  if (subscriptionOrError.isFailed()) {
    return { subscriptionUuid: null, limit: null, used: null }
  }
  const subscriptionUuid = subscriptionOrError.getValue().uuid

  const getSubscriptionSetting = container.get<
    UseCase<
      { userSubscriptionUuid: string; settingName: string; allowSensitiveRetrieval: boolean },
      { setting: { props: { value: string | null } } }
    >
  >(TYPES.Auth_GetSubscriptionSetting)

  const readNumber = async (settingName: string): Promise<number | null> => {
    const result = await getSubscriptionSetting.execute({
      userSubscriptionUuid: subscriptionUuid,
      settingName,
      allowSensitiveRetrieval: false,
    })
    if (result.isFailed()) {
      return null
    }
    const raw = result.getValue().setting.props.value
    const parsed = raw === null ? Number.NaN : Number(raw)

    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    subscriptionUuid,
    limit: await readNumber(STORAGE_LIMIT_SETTING),
    used: await readNumber(STORAGE_USED_SETTING),
  }
}

async function cmdStorageLimitGet(args: ParsedArgs): Promise<number> {
  const identifier = args.positionals[0]
  if (!identifier) {
    throw new UsageError('storage-limit get <user>')
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)
  const info = await storageInfoForUser(container, user.uuid)

  if (args.options.json === true) {
    outJson({ userUuid: user.uuid, email: user.email, ...info })

    return 0
  }

  if (info.subscriptionUuid === null) {
    outLine(
      `${user.email} has no regular subscription record — the files server already treats such accounts as unlimited.`,
    )

    return 0
  }
  outLine(`used:  ${formatBytes(info.used)}${info.used !== null ? ` (${info.used} bytes)` : ''}`)
  outLine(`limit: ${formatBytes(info.limit)}${info.limit !== null && info.limit !== -1 ? ` (${info.limit} bytes)` : ''}`)

  return 0
}

async function setStorageLimit(identifier: string, rawValue: string): Promise<number> {
  const parsed = parseStorageLimitInput(rawValue)
  if (!parsed.ok) {
    throw new UsageError(parsed.error)
  }

  const container = await loadContainer()
  const user = await resolveUser(container, identifier)

  const getRegularSubscription = container.get<UseCase<{ userUuid: string }, { uuid: string }>>(
    TYPES.Auth_GetRegularSubscriptionForUser,
  )
  const subscriptionOrError = await getRegularSubscription.execute({ userUuid: user.uuid })
  if (subscriptionOrError.isFailed()) {
    throw new Error(
      `${user.email} has no regular subscription record. Accounts without one are already treated as unlimited by the files server.`,
    )
  }

  const setSubscriptionSettingValue = container.get<
    UseCase<{ userSubscriptionUuid: string; settingName: string; value: string }>
  >(TYPES.Auth_SetSubscriptionSettingValue)
  requireResult(
    await setSubscriptionSettingValue.execute({
      userSubscriptionUuid: subscriptionOrError.getValue().uuid,
      settingName: STORAGE_LIMIT_SETTING,
      value: parsed.value,
    }),
  )

  await writeAudit(container, AuditAction.SettingChanged, { type: 'user', uuid: user.uuid }, { name: STORAGE_LIMIT_SETTING })

  outLine(
    `Set storage limit for ${user.email} to ${formatBytes(Number(parsed.value))}. New upload valet tokens honor it immediately; tokens issued earlier keep the old limit until they expire.`,
  )

  return 0
}

/* ---------------------------------------------------------------------------
 * REGISTRATION (env vs persisted, shown honestly)
 * ------------------------------------------------------------------------- */

async function registrationPersistedCount(container: ContainerLike): Promise<number> {
  const settingRepository = container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository)
  const name = requireResult(SettingName.create(SettingName.NAMES.RegistrationDisabled) as ResultLike<SettingName>)

  return settingRepository.countAllByNameAndValue({ name, value: 'true' })
}

/**
 * Standard Red Notes: resolves the effective REGISTRATION POLICY (default role +
 * email-domain policy) exactly the way the auth server does — the persisted
 * admin overlay (the gateway-written SERVER_SETTINGS_PATH JSON) layered over the
 * REGISTRATION_* env baseline. Returns the effective config plus the overlay
 * path and the raw persisted section so the CLI can show provenance.
 */
async function resolveRegistrationPolicy(): Promise<{
  effective: RegistrationConfig
  overlayPath: string | undefined
  persisted: RegistrationConfigOverlay | undefined
}> {
  const authEnv = await readPackageEnv('auth')
  const baseline = registrationBaselineFromEnv({
    defaultRole: process.env.REGISTRATION_DEFAULT_ROLE ?? authEnv.REGISTRATION_DEFAULT_ROLE,
    domainMode: process.env.REGISTRATION_DOMAIN_MODE ?? authEnv.REGISTRATION_DOMAIN_MODE,
    domains: process.env.REGISTRATION_DOMAINS ?? authEnv.REGISTRATION_DOMAINS,
  })
  const overlayPath = process.env.SERVER_SETTINGS_PATH ?? authEnv.SERVER_SETTINGS_PATH ?? undefined
  const reader = new ServerSettingsOverlayReader(overlayPath)
  const persisted = await reader.registration()
  const resolver = new EnvRegistrationConfigResolver(baseline, () => Promise.resolve(persisted))

  return { effective: await resolver.resolve(), overlayPath, persisted }
}

/**
 * Read-modify-write the persisted `registration` section of the SERVER_SETTINGS
 * overlay JSON (the same file the gateway admin surface writes). Atomic via a
 * tmp file + rename. Requires SERVER_SETTINGS_PATH to be configured.
 */
async function updateRegistrationOverlay(
  mutate: (registration: Record<string, unknown>) => void,
): Promise<string> {
  const authEnv = await readPackageEnv('auth')
  const overlayPath = process.env.SERVER_SETTINGS_PATH ?? authEnv.SERVER_SETTINGS_PATH ?? undefined
  if (!overlayPath) {
    throw new Error(
      'SERVER_SETTINGS_PATH is not configured, so the registration policy cannot be persisted from the CLI. Set it in the operator .env (both auth + gateway) or manage the policy from the admin panel.',
    )
  }

  let data: Record<string, unknown> = {}
  try {
    const raw = await fsPromises.readFile(overlayPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      data = parsed as Record<string, unknown>
    }
  } catch {
    data = {}
  }

  const registration = (data.registration && typeof data.registration === 'object'
    ? (data.registration as Record<string, unknown>)
    : {}) as Record<string, unknown>
  mutate(registration)
  if (Object.keys(registration).length === 0) {
    delete data.registration
  } else {
    data.registration = registration
  }

  await fsPromises.mkdir(path.dirname(overlayPath), { recursive: true })
  const tmp = `${overlayPath}.${process.pid}.${Date.now()}.tmp`
  await fsPromises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsPromises.rename(tmp, overlayPath)

  return overlayPath
}

async function cmdRegistrationPolicy(args: ParsedArgs, action: string | undefined): Promise<number> {
  if (action === undefined || action === 'show' || action === 'status') {
    const { effective, overlayPath, persisted } = await resolveRegistrationPolicy()
    if (args.options.json === true) {
      outJson({ effective, persisted: persisted ?? null, overlayPath: overlayPath ?? null })

      return 0
    }
    outLine('registration policy (effective — persisted overlay over env, then default):')
    outLine(`  default role for new users: ${effective.defaultRole}`)
    outLine(`  email-domain mode:          ${effective.domainMode}`)
    outLine(`  email-domain list:          ${effective.domainList.length ? effective.domainList.join(', ') : '(empty)'}`)
    outLine(`  email confirmation:         ${effective.emailConfirmationEnabled ? 'ENABLED' : 'disabled'}`)
    outLine(`  confirmation gating mode:   ${effective.emailConfirmationGating}`)
    outLine(
      `  confirmation base URL:      ${effective.emailConfirmationBaseUrl || '(unset — link is relative; set with email-confirmation-url)'}`,
    )
    outLine(`  persisted overlay file:     ${overlayPath ?? '(SERVER_SETTINGS_PATH unset — env/default only)'}`)

    return 0
  }

  if (action === 'default-role') {
    const role = args.positionals[0]
    if (!role) {
      throw new UsageError(`registration policy default-role <${ASSIGNABLE_DEFAULT_ROLE_NAMES.join('|')}|clear>`)
    }
    if (role === 'clear') {
      const file = await updateRegistrationOverlay((r) => delete r.defaultRole)
      outLine(`registration default role cleared (falls back to env/CORE_USER). Wrote ${file}.`)

      return 0
    }
    if (!isAssignableDefaultRole(role)) {
      throw new UsageError(
        `invalid default role '${role}' — must be one of ${ASSIGNABLE_DEFAULT_ROLE_NAMES.join(', ')} (never the admin role)`,
      )
    }
    const file = await updateRegistrationOverlay((r) => (r.defaultRole = role))
    outLine(`registration default role set to ${role}. Effective on the next signup. Wrote ${file}.`)

    return 0
  }

  if (action === 'domain-mode') {
    const mode = args.positionals[0]
    if (!mode || !isRegistrationDomainMode(mode)) {
      throw new UsageError(`registration policy domain-mode <${REGISTRATION_DOMAIN_MODES.join('|')}>`)
    }
    const file = await updateRegistrationOverlay((r) => (r.domainMode = mode))
    outLine(`registration email-domain mode set to ${mode}. Wrote ${file}.`)

    return 0
  }

  if (action === 'domains') {
    const rest = args.positionals.join(' ')
    if (rest.trim() === '') {
      throw new UsageError("registration policy domains <comma-separated-domains|clear>")
    }
    if (rest.trim() === 'clear') {
      const file = await updateRegistrationOverlay((r) => delete r.domainList)
      outLine(`registration email-domain list cleared. Wrote ${file}.`)

      return 0
    }
    const list = normalizeDomainList(rest.split(/[\s,]+/))
    const file = await updateRegistrationOverlay((r) => (r.domainList = list))
    outLine(`registration email-domain list set to: ${list.length ? list.join(', ') : '(empty)'}. Wrote ${file}.`)

    return 0
  }

  if (action === 'email-confirmation') {
    const value = args.positionals[0]
    if (value === 'clear') {
      const file = await updateRegistrationOverlay((r) => delete r.emailConfirmationEnabled)
      outLine(`email confirmation cleared (falls back to env/default OFF). Wrote ${file}.`)

      return 0
    }
    if (value !== 'on' && value !== 'off') {
      throw new UsageError('registration policy email-confirmation <on|off|clear>')
    }
    const file = await updateRegistrationOverlay((r) => (r.emailConfirmationEnabled = value === 'on'))
    outLine(`email confirmation ${value === 'on' ? 'ENABLED' : 'disabled'}. Effective on the next signup. Wrote ${file}.`)

    return 0
  }

  if (action === 'email-confirmation-gating') {
    const mode = args.positionals[0]
    if (mode === 'clear') {
      const file = await updateRegistrationOverlay((r) => delete r.emailConfirmationGating)
      outLine(`confirmation gating cleared (falls back to env/default block_signin). Wrote ${file}.`)

      return 0
    }
    if (!isEmailConfirmationGatingMode(mode)) {
      throw new UsageError(`registration policy email-confirmation-gating <${EMAIL_CONFIRMATION_GATING_MODES.join('|')}|clear>`)
    }
    const file = await updateRegistrationOverlay((r) => (r.emailConfirmationGating = mode))
    outLine(`confirmation gating mode set to ${mode}. Wrote ${file}.`)

    return 0
  }

  if (action === 'email-confirmation-url') {
    const rest = args.positionals.join(' ').trim()
    if (rest === '') {
      throw new UsageError('registration policy email-confirmation-url <https://your-web-app|clear>')
    }
    if (rest === 'clear') {
      const file = await updateRegistrationOverlay((r) => delete r.emailConfirmationBaseUrl)
      outLine(`confirmation base URL cleared. Wrote ${file}.`)

      return 0
    }
    if (!/^https?:\/\/.+/i.test(rest)) {
      throw new UsageError('confirmation base URL must be an absolute http(s) URL, e.g. https://notes.example.com')
    }
    const file = await updateRegistrationOverlay((r) => (r.emailConfirmationBaseUrl = rest))
    outLine(`confirmation base URL set to ${rest}. Wrote ${file}.`)

    return 0
  }

  throw new UsageError(
    `unknown registration policy action '${action}' — show | default-role <role> | domain-mode <mode> | domains <list> | email-confirmation <on|off> | email-confirmation-gating <mode> | email-confirmation-url <url>`,
  )
}

async function cmdRegistration(args: ParsedArgs, sub: string | undefined): Promise<number> {
  if (sub === 'policy') {
    return cmdRegistrationPolicy({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])
  }

  if (sub === 'status' || sub === undefined) {
    // The env master switch is read at BOOT by the auth service; the CLI reads
    // the same entrypoint-generated .env the service loaded.
    const authEnv = await readPackageEnv('auth')
    const envDisabled = (process.env.DISABLE_USER_REGISTRATION ?? authEnv.DISABLE_USER_REGISTRATION) === 'true'

    const container = await loadContainer()
    const persistedCount = await registrationPersistedCount(container)
    const persistedDisabled = persistedCount > 0
    const effective = envDisabled || persistedDisabled

    if (args.options.json === true) {
      outJson({
        registrationDisabled: effective,
        env: { disableUserRegistration: envDisabled, note: 'read at boot; change requires editing the operator .env and restarting' },
        persisted: { registrationDisabled: persistedDisabled, trueRows: persistedCount, note: 'runtime flag; toggle with registration enable|disable' },
      })

      return 0
    }

    outLine(`registration: ${effective ? 'DISABLED' : 'enabled'}`)
    outLine(`  env DISABLE_USER_REGISTRATION: ${envDisabled ? 'true' : 'false'} (boot-time; read-only from this CLI)`)
    outLine(
      `  persisted runtime flag:        ${persistedDisabled ? `true (${persistedCount} REGISTRATION_DISABLED row(s))` : 'false'}`,
    )
    if (envDisabled) {
      outLine("  NOTE: the env switch is on — 'registration enable' alone cannot re-open signups; edit the operator .env and restart.")
    }

    return 0
  }

  if (sub === 'disable') {
    const container = await loadContainer()
    const asIdentifier = stringOption(args.options, 'as')

    let target: { uuid: string; email: string }
    if (asIdentifier !== undefined) {
      const user = await resolveUser(container, asIdentifier)
      target = { uuid: user.uuid, email: user.email }
    } else {
      // The panel stores the flag on the acting admin's record; from the CLI we
      // pick the oldest admin so the panel shows a consistent state.
      const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)
      const admins = await userRepository.findUsersForAdmin({
        limit: 1,
        offset: 0,
        sort: 'createdAt',
        role: ADMIN_ROLE_NAME,
      })
      if (admins.rows.length === 0) {
        throw new Error(`no ${ADMIN_ROLE_NAME} user found to carry the flag — pass --as <user>`)
      }
      target = { uuid: admins.rows[0].uuid, email: admins.rows[0].email }
    }

    const setSettingValue = container.get<
      UseCase<{ settingName: string; value: string | null; userUuid: string; checkUserPermissions: boolean }>
    >(TYPES.Auth_SetSettingValue)
    requireResult(
      await setSettingValue.execute({
        settingName: SettingName.NAMES.RegistrationDisabled,
        value: 'true',
        userUuid: target.uuid,
        checkUserPermissions: false,
      }),
    )

    await writeAudit(container, AuditAction.SettingChanged, { type: 'user', uuid: target.uuid }, {
      name: SettingName.NAMES.RegistrationDisabled,
    })

    outLine(`Registration DISABLED (persisted flag written to ${target.email}). Effective immediately — no restart needed.`)

    return 0
  }

  if (sub === 'enable') {
    const container = await loadContainer()
    const settingRepository = container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository)
    const setSettingValue = container.get<
      UseCase<{ settingName: string; value: string | null; userUuid: string; checkUserPermissions: boolean }>
    >(TYPES.Auth_SetSettingValue)
    const name = requireResult(SettingName.create(SettingName.NAMES.RegistrationDisabled) as ResultLike<SettingName>)

    // ANY user's 'true' row disables signups instance-wide, so clear them ALL
    // (re-query from offset 0 each round because the flips shrink the match set).
    let cleared = 0
    for (let round = 0; round < 100; round++) {
      const settings = await settingRepository.findAllByNameAndValue({ name, value: 'true', offset: 0, limit: 100 })
      if (settings.length === 0) {
        break
      }
      for (const setting of settings) {
        requireResult(
          await setSettingValue.execute({
            settingName: SettingName.NAMES.RegistrationDisabled,
            value: 'false',
            userUuid: setting.props.userUuid.value,
            checkUserPermissions: false,
          }),
        )
        cleared++
      }
    }

    await writeAudit(container, AuditAction.SettingChanged, { type: 'user', uuid: null }, {
      name: SettingName.NAMES.RegistrationDisabled,
      clearedRows: cleared,
    })

    const authEnv = await readPackageEnv('auth')
    const envDisabled = (process.env.DISABLE_USER_REGISTRATION ?? authEnv.DISABLE_USER_REGISTRATION) === 'true'
    outLine(`Registration persisted flag cleared (${cleared} row(s) set to 'false').`)
    if (envDisabled) {
      outLine('WARNING: env DISABLE_USER_REGISTRATION is still true — signups remain blocked until you change the operator .env and restart.')
    }

    return 0
  }

  // Standard Red Notes: manually mark a user's email as confirmed (admin override
  // for the email-confirmation gate) — e.g. when a user cannot receive the email.
  if (sub === 'confirm-email') {
    const container = await loadContainer()
    const user = await resolveUser(container, args.positionals[0])
    const userRepository = container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)

    if (user.isEmailConfirmed()) {
      outLine(`${user.email} is already confirmed. No change.`)

      return 0
    }

    user.emailConfirmed = true
    user.emailConfirmedAt = new Date()
    await userRepository.save(user)

    await writeAudit(container, AuditAction.SettingChanged, { type: 'user', uuid: user.uuid }, {
      name: 'email_confirmed',
      value: 'true',
      via: 'cli',
    })

    outLine(`Marked ${user.email} email-confirmed. They can now sign in.`)

    return 0
  }

  throw new UsageError(
    `unknown registration subcommand '${sub}' — status | enable | disable | policy | confirm-email <user>`,
  )
}

/* ---------------------------------------------------------------------------
 * ANTI-ABUSE (IP allow/block lists + effective limits)
 * ------------------------------------------------------------------------- */

/** Minimal ioredis slice the IP-list + limits commands need. */
type RedisSetClient = {
  sadd(key: string, member: string): Promise<number>
  srem(key: string, member: string): Promise<number>
  smembers(key: string): Promise<string[]>
}

/**
 * Get the shared Redis client bound by the auth container (Auth_Redis). Returns
 * undefined when Redis is not configured (in-memory cache mode) — the anti-abuse
 * layer no-ops there just as it does at the gateway, so we report that honestly.
 */
async function getRedisSetClient(container: ContainerLike): Promise<RedisSetClient | undefined> {
  try {
    return container.get<RedisSetClient>(TYPES.Auth_Redis)
  } catch {
    return undefined
  }
}

const ipListKey = (list: IpAclList): string => (list === 'allow' ? IP_ACL_ALLOW_KEY : IP_ACL_BLOCK_KEY)

async function cmdIp(args: ParsedArgs, sub: string | undefined): Promise<number> {
  if (sub === 'list' || sub === undefined) {
    const which = args.positionals[0]
    if (which !== undefined && which !== 'allow' && which !== 'block') {
      throw new UsageError("ip list [allow|block]")
    }
    const container = await loadContainer()
    const redis = await getRedisSetClient(container)
    if (!redis) {
      outLine('IP lists are unavailable: Redis is not configured on this deployment (in-memory cache mode).')

      return 0
    }
    const allow = which === 'block' ? [] : (await redis.smembers(IP_ACL_ALLOW_KEY)).sort()
    const block = which === 'allow' ? [] : (await redis.smembers(IP_ACL_BLOCK_KEY)).sort()

    if (args.options.json === true) {
      outJson({ allow, block })

      return 0
    }
    if (which !== 'block') {
      outLine(`allow (${allow.length}):${allow.length ? '\n  ' + allow.join('\n  ') : ' (empty)'}`)
    }
    if (which !== 'allow') {
      outLine(`block (${block.length}):${block.length ? '\n  ' + block.join('\n  ') : ' (empty)'}`)
    }

    return 0
  }

  const actionMap: Record<string, { list: IpAclList; add: boolean } | undefined> = {
    block: { list: 'block', add: true },
    unblock: { list: 'block', add: false },
    allow: { list: 'allow', add: true },
    unallow: { list: 'allow', add: false },
  }
  const action = actionMap[sub]
  if (!action) {
    throw new UsageError(`unknown ip subcommand '${sub}' — list | block | unblock | allow | unallow`)
  }

  const entryRaw = args.positionals[0]
  if (!entryRaw) {
    throw new UsageError(`ip ${sub} <ip|ipv4-cidr>`)
  }
  const validated = validateCliIpEntry(entryRaw)
  if (!validated.ok) {
    throw new UsageError(validated.error)
  }

  const container = await loadContainer()
  const redis = await getRedisSetClient(container)
  if (!redis) {
    throw new Error('Redis is not configured on this deployment, so the IP lists cannot be managed from the CLI.')
  }

  const key = ipListKey(action.list)
  if (action.add) {
    await redis.sadd(key, validated.value)
  } else {
    await redis.srem(key, validated.value)
  }

  await writeAudit(container, 'admin.anti-abuse.ip-list', { type: 'ip', uuid: null }, {
    list: action.list,
    action: action.add ? 'add' : 'remove',
    entry: validated.value,
  })

  outLine(
    `${action.add ? 'Added' : 'Removed'} ${validated.value} ${action.add ? 'to' : 'from'} the ${action.list} list. Effective within a few seconds (the gateway caches the list briefly).`,
  )

  return 0
}

async function cmdLimits(args: ParsedArgs): Promise<number> {
  // Rate-limit tiers live in the SERVER_SETTINGS overlay (security.rateLimit),
  // layered over RATE_LIMIT_* env, over the safe defaults. Read the overlay file
  // + the gateway .env the same honest way the registration policy command does.
  const authEnv = await readPackageEnv('auth')
  const gatewayEnv = await readPackageEnv('api-gateway')
  const overlayPath = process.env.SERVER_SETTINGS_PATH ?? authEnv.SERVER_SETTINGS_PATH ?? undefined

  let persisted: Record<string, unknown> = {}
  if (overlayPath) {
    try {
      const raw = await fsPromises.readFile(overlayPath, 'utf8')
      const parsed = JSON.parse(raw) as { security?: { rateLimit?: Record<string, unknown> } }
      persisted = parsed?.security?.rateLimit ?? {}
    } catch {
      persisted = {}
    }
  }

  const num = (key: string, fallback: number): { value: number; source: string } => {
    if (persisted[key] !== undefined && typeof persisted[key] === 'number') {
      return { value: persisted[key] as number, source: 'persisted' }
    }
    const envRaw = process.env[`API_GATEWAY_${key}`] ?? gatewayEnv[key]
    if (envRaw !== undefined && envRaw !== '' && Number.isFinite(Number(envRaw))) {
      return { value: Number(envRaw), source: 'env' }
    }

    return { value: fallback, source: 'default' }
  }
  // env var NAMES for the tiers (mapped to the overlay key they override).
  const window = (() => {
    if (typeof persisted.windowSeconds === 'number') {
      return { value: persisted.windowSeconds, source: 'persisted' }
    }
    const envRaw = process.env.API_GATEWAY_RATE_LIMIT_WINDOW_SECONDS ?? gatewayEnv.RATE_LIMIT_WINDOW_SECONDS
    return envRaw ? { value: Number(envRaw), source: 'env' } : { value: 60, source: 'default' }
  })()
  const login = (() => {
    if (typeof persisted.loginMax === 'number') {
      return { value: persisted.loginMax, source: 'persisted' }
    }
    const envRaw = process.env.API_GATEWAY_RATE_LIMIT_LOGIN_MAX ?? gatewayEnv.RATE_LIMIT_LOGIN_MAX
    return envRaw ? { value: Number(envRaw), source: 'env' } : { value: 10, source: 'default' }
  })()
  const registration = (() => {
    if (typeof persisted.registrationMax === 'number') {
      return { value: persisted.registrationMax, source: 'persisted' }
    }
    const envRaw = process.env.API_GATEWAY_RATE_LIMIT_REGISTRATION_MAX ?? gatewayEnv.RATE_LIMIT_REGISTRATION_MAX
    return envRaw ? { value: Number(envRaw), source: 'env' } : { value: 5, source: 'default' }
  })()
  const enabled =
    typeof persisted.enabled === 'boolean'
      ? { value: persisted.enabled, source: 'persisted' }
      : { value: (process.env.API_GATEWAY_RATE_LIMIT_ENABLED ?? gatewayEnv.RATE_LIMIT_ENABLED) !== 'false', source: 'env/default' }
  const userMax = num('userMax', 0)
  const adaptive =
    typeof persisted.adaptiveEscalation === 'boolean'
      ? { value: persisted.adaptiveEscalation, source: 'persisted' }
      : { value: false, source: 'default' }

  // IP list sizes (best-effort — Redis may be unconfigured).
  let allowCount: number | null = null
  let blockCount: number | null = null
  try {
    const container = await loadContainer()
    const redis = await getRedisSetClient(container)
    if (redis) {
      allowCount = (await redis.smembers(IP_ACL_ALLOW_KEY)).length
      blockCount = (await redis.smembers(IP_ACL_BLOCK_KEY)).length
    }
  } catch {
    /* keep null (unknown) */
  }

  // Failed-login lockout config is read at boot from the auth env.
  const lockout = {
    failedLoginLockout: process.env.FAILED_LOGIN_LOCKOUT ?? authEnv.FAILED_LOGIN_LOCKOUT ?? '(default)',
    failedLoginCaptchaLockout:
      process.env.FAILED_LOGIN_CAPTCHA_LOCKOUT ?? authEnv.FAILED_LOGIN_CAPTCHA_LOCKOUT ?? '(default)',
  }

  if (args.options.json === true) {
    outJson({
      rateLimit: {
        enabled: enabled.value,
        windowSeconds: window.value,
        loginMax: login.value,
        registrationMax: registration.value,
        userMax: userMax.value,
        adaptiveEscalation: adaptive.value,
      },
      sources: {
        enabled: enabled.source,
        windowSeconds: window.source,
        loginMax: login.source,
        registrationMax: registration.source,
        userMax: userMax.source,
        adaptiveEscalation: adaptive.source,
      },
      ipLists: { allow: allowCount, block: blockCount },
      lockout,
      overlayPath: overlayPath ?? null,
    })

    return 0
  }

  outLine('rate-limit tiers (effective — persisted overlay over RATE_LIMIT_* env over defaults):')
  outLine(`  enabled:            ${enabled.value} [${enabled.source}]`)
  outLine(`  window seconds:     ${window.value} [${window.source}]`)
  outLine(`  login max / window: ${login.value} [${login.source}]`)
  outLine(`  registration max:   ${registration.value} [${registration.source}]`)
  outLine(`  per-user max:       ${userMax.value === 0 ? '0 (disabled)' : userMax.value} [${userMax.source}]`)
  outLine(`  adaptive escalation:${adaptive.value ? ' on' : ' off'} [${adaptive.source}]`)
  outLine('')
  outLine('IP access lists (Redis):')
  outLine(`  allow entries:      ${allowCount ?? '(Redis unavailable)'}`)
  outLine(`  block entries:      ${blockCount ?? '(Redis unavailable)'}`)
  outLine('')
  outLine('failed-login lockout (auth env; read at boot):')
  outLine(`  FAILED_LOGIN_LOCKOUT:         ${lockout.failedLoginLockout}`)
  outLine(`  FAILED_LOGIN_CAPTCHA_LOCKOUT: ${lockout.failedLoginCaptchaLockout}`)
  outLine(`  overlay file: ${overlayPath ?? '(SERVER_SETTINGS_PATH unset — env/default only)'}`)

  return 0
}

/* ---------------------------------------------------------------------------
 * OCR + WORKFLOWS runtime config (the SERVER_SETTINGS overlay `ocr` / `workflows`
 * sections, layered over the gateway env, over the safe defaults). These read +
 * write the SAME atomic overlay file the gateway admin panel writes, the same
 * honest way the registration policy / limits commands do.
 * ------------------------------------------------------------------------- */

/**
 * Read-modify-write an arbitrary TOP-LEVEL section of the SERVER_SETTINGS overlay
 * JSON (e.g. 'ocr', 'workflows'). Atomic via tmp + rename. Prunes the section
 * when it empties. Requires SERVER_SETTINGS_PATH to be configured.
 */
async function updateOverlaySection(
  section: string,
  mutate: (obj: Record<string, unknown>) => void,
): Promise<string> {
  const authEnv = await readPackageEnv('auth')
  const overlayPath = process.env.SERVER_SETTINGS_PATH ?? authEnv.SERVER_SETTINGS_PATH ?? undefined
  if (!overlayPath) {
    throw new Error(
      'SERVER_SETTINGS_PATH is not configured, so this setting cannot be persisted from the CLI. Set it in the operator .env (both auth + gateway) or manage it from the admin panel.',
    )
  }

  let data: Record<string, unknown> = {}
  try {
    const raw = await fsPromises.readFile(overlayPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      data = parsed as Record<string, unknown>
    }
  } catch {
    data = {}
  }

  const current = (data[section] && typeof data[section] === 'object'
    ? (data[section] as Record<string, unknown>)
    : {}) as Record<string, unknown>
  mutate(current)
  if (Object.keys(current).length === 0) {
    delete data[section]
  } else {
    data[section] = current
  }

  await fsPromises.mkdir(path.dirname(overlayPath), { recursive: true })
  const tmp = `${overlayPath}.${process.pid}.${Date.now()}.tmp`
  await fsPromises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsPromises.rename(tmp, overlayPath)

  return overlayPath
}

/** Read a top-level overlay section (never throws — missing/corrupt → {}). */
async function readOverlaySection(section: string): Promise<{ persisted: Record<string, unknown>; overlayPath: string | undefined }> {
  const authEnv = await readPackageEnv('auth')
  const overlayPath = process.env.SERVER_SETTINGS_PATH ?? authEnv.SERVER_SETTINGS_PATH ?? undefined
  let persisted: Record<string, unknown> = {}
  if (overlayPath) {
    try {
      const raw = await fsPromises.readFile(overlayPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed[section] && typeof parsed[section] === 'object') {
        persisted = parsed[section] as Record<string, unknown>
      }
    } catch {
      persisted = {}
    }
  }

  return { persisted, overlayPath }
}

const LOOSE_TRUE_VALUES = ['true', '1', 'yes', 'on']
const parseOnOffClear = (value: string | undefined): boolean | null | undefined => {
  if (value === 'clear') {
    return null
  }
  if (value === 'on' || value === 'true') {
    return true
  }
  if (value === 'off' || value === 'false') {
    return false
  }

  return undefined
}
const OCR_LANGUAGE_RE = /^[a-zA-Z]{2,}([_+][a-zA-Z]{2,})*$/

async function cmdOcr(args: ParsedArgs, action: string | undefined): Promise<number> {
  if (action === undefined || action === 'show' || action === 'status') {
    const { persisted, overlayPath } = await readOverlaySection('ocr')
    const gatewayEnv = await readPackageEnv('api-gateway')
    const envOf = (name: string): string | undefined =>
      process.env[`API_GATEWAY_${name}`] ?? gatewayEnv[name] ?? undefined

    const boolField = (key: string, envName: string, def: boolean): { value: boolean; source: string } => {
      if (typeof persisted[key] === 'boolean') {
        return { value: persisted[key] as boolean, source: 'persisted' }
      }
      const raw = envOf(envName)
      if (raw !== undefined && raw !== '') {
        return { value: LOOSE_TRUE_VALUES.includes(raw.toLowerCase()), source: 'env' }
      }

      return { value: def, source: 'default' }
    }
    const strField = (key: string, envName: string, def: string): { value: string; source: string } => {
      if (typeof persisted[key] === 'string' && OCR_LANGUAGE_RE.test((persisted[key] as string).trim())) {
        return { value: (persisted[key] as string).trim(), source: 'persisted' }
      }
      const raw = envOf(envName)
      if (raw !== undefined && OCR_LANGUAGE_RE.test(raw.trim())) {
        return { value: raw.trim(), source: 'env' }
      }

      return { value: def, source: 'default' }
    }
    const numField = (key: string, envName: string, def: number): { value: number; source: string } => {
      if (typeof persisted[key] === 'number') {
        return { value: persisted[key] as number, source: 'persisted' }
      }
      const raw = envOf(envName)
      if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
        return { value: Number(raw), source: 'env' }
      }

      return { value: def, source: 'default' }
    }

    const serverEnabled = boolField('serverEnabled', 'OCR_SERVER_ENABLED', false)
    const defaultLanguage = strField('defaultLanguage', 'OCR_SERVER_DEFAULT_LANGUAGE', 'eng')
    const maxPages = numField('maxPages', 'OCR_SERVER_MAX_PAGES', 50)
    const maxImageBytes = numField('maxImageBytes', 'OCR_SERVER_MAX_IMAGE_BYTES', 12 * 1024 * 1024)
    const clientEnabled = boolField('clientEnabled', 'OCR_ENABLED', false)
    const clientDefaultLanguage = strField('clientDefaultLanguage', 'OCR_DEFAULT_LANGUAGE', 'eng')

    if (args.options.json === true) {
      outJson({
        effective: {
          serverEnabled: serverEnabled.value,
          defaultLanguage: defaultLanguage.value,
          maxPages: maxPages.value,
          maxImageBytes: maxImageBytes.value,
          clientEnabled: clientEnabled.value,
          clientDefaultLanguage: clientDefaultLanguage.value,
        },
        sources: {
          serverEnabled: serverEnabled.source,
          defaultLanguage: defaultLanguage.source,
          maxPages: maxPages.source,
          maxImageBytes: maxImageBytes.source,
          clientEnabled: clientEnabled.source,
          clientDefaultLanguage: clientDefaultLanguage.source,
        },
        overlayPath: overlayPath ?? null,
      })

      return 0
    }

    outLine('OCR config (effective — persisted overlay over gateway env over defaults):')
    outLine(`  server-side OCR:          ${serverEnabled.value ? 'on' : 'off'} [${serverEnabled.source}]  (runtime)`)
    outLine(`  server default language:  ${defaultLanguage.value} [${defaultLanguage.source}]  (runtime)`)
    outLine(`  server max pages:         ${maxPages.value} [${maxPages.source}]  (runtime)`)
    outLine(`  server max image bytes:   ${maxImageBytes.value} [${maxImageBytes.source}]  (runtime)`)
    outLine(`  browser (on-device) OCR:  ${clientEnabled.value ? 'on' : 'off'} [${clientEnabled.source}]  (applies on next page load)`)
    outLine(`  browser default language: ${clientDefaultLanguage.value} [${clientDefaultLanguage.source}]  (applies on next page load)`)
    outLine(`  overlay file: ${overlayPath ?? '(SERVER_SETTINGS_PATH unset — env/default only)'}`)

    return 0
  }

  const value = args.positionals[0]

  if (action === 'set-server-enabled' || action === 'set-client-enabled') {
    const key = action === 'set-server-enabled' ? 'serverEnabled' : 'clientEnabled'
    const parsed = parseOnOffClear(value)
    if (parsed === undefined) {
      throw new UsageError(`ocr ${action} <on|off|clear>`)
    }
    const file = await updateOverlaySection('ocr', (o) => (parsed === null ? delete o[key] : (o[key] = parsed)))
    outLine(`ocr.${key} ${parsed === null ? 'cleared (falls back to env/default)' : parsed ? 'enabled' : 'disabled'}. Wrote ${file}.`)

    return 0
  }

  if (action === 'set-default-language' || action === 'set-client-default-language') {
    const key = action === 'set-default-language' ? 'defaultLanguage' : 'clientDefaultLanguage'
    if (!value) {
      throw new UsageError(`ocr ${action} <tesseract-code|clear>`)
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('ocr', (o) => delete o[key])
      outLine(`ocr.${key} cleared. Wrote ${file}.`)

      return 0
    }
    if (!OCR_LANGUAGE_RE.test(value)) {
      throw new UsageError(`invalid language '${value}' — must be a tesseract code, e.g. eng or eng+deu`)
    }
    const file = await updateOverlaySection('ocr', (o) => (o[key] = value))
    outLine(`ocr.${key} set to ${value}. Wrote ${file}.`)

    return 0
  }

  if (action === 'set-max-pages' || action === 'set-max-image-bytes') {
    const key = action === 'set-max-pages' ? 'maxPages' : 'maxImageBytes'
    const [min, max] = action === 'set-max-pages' ? [1, 1000] : [1024, 200 * 1024 * 1024]
    if (!value) {
      throw new UsageError(`ocr ${action} <${min}..${max}|clear>`)
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('ocr', (o) => delete o[key])
      outLine(`ocr.${key} cleared. Wrote ${file}.`)

      return 0
    }
    const n = Number(value)
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new UsageError(`ocr.${key} must be an integer between ${min} and ${max}`)
    }
    const file = await updateOverlaySection('ocr', (o) => (o[key] = n))
    outLine(`ocr.${key} set to ${n}. Wrote ${file}.`)

    return 0
  }

  throw new UsageError(
    `unknown ocr action '${action}' — show | set-server-enabled <on|off> | set-default-language <code> | set-max-pages <n> | set-max-image-bytes <n> | set-client-enabled <on|off> | set-client-default-language <code>`,
  )
}

async function cmdWorkflows(args: ParsedArgs, action: string | undefined): Promise<number> {
  if (action === undefined || action === 'show' || action === 'status') {
    const { persisted, overlayPath } = await readOverlaySection('workflows')
    const gatewayEnv = await readPackageEnv('api-gateway')
    const envOf = (name: string): string | undefined =>
      process.env[`API_GATEWAY_${name}`] ?? gatewayEnv[name] ?? undefined

    const enabled = (() => {
      if (typeof persisted.enabled === 'boolean') {
        return { value: persisted.enabled, source: 'persisted' }
      }
      const raw = envOf('WORKFLOWS_ENABLED')
      if (raw !== undefined && raw !== '') {
        return { value: LOOSE_TRUE_VALUES.includes(raw.toLowerCase()), source: 'env' }
      }

      return { value: false, source: 'default' }
    })()
    const strField = (key: string, envName: string, def: string): { value: string; source: string } => {
      if (typeof persisted[key] === 'string' && (persisted[key] as string).trim() !== '') {
        return { value: (persisted[key] as string).trim(), source: 'persisted' }
      }
      const raw = envOf(envName)
      if (raw !== undefined && raw !== '') {
        return { value: raw.trim(), source: 'env' }
      }

      return { value: def, source: 'default' }
    }
    const n8nUrl = strField('n8nUrl', 'WORKFLOWS_N8N_URL', 'http://n8n:5678')
    const uiBasePath = strField('uiBasePath', 'WORKFLOWS_UI_BASE_PATH', '/workflows-ui')
    const uiTokenTtl = (() => {
      if (typeof persisted.uiTokenTtlSeconds === 'number') {
        return { value: persisted.uiTokenTtlSeconds, source: 'persisted' }
      }
      const raw = envOf('WORKFLOWS_UI_TOKEN_TTL_SECONDS')
      if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
        return { value: Number(raw), source: 'env' }
      }

      return { value: 12 * 60 * 60, source: 'default' }
    })()

    if (args.options.json === true) {
      outJson({
        effective: {
          enabled: enabled.value,
          n8nUrl: n8nUrl.value,
          uiBasePath: uiBasePath.value,
          uiTokenTtlSeconds: uiTokenTtl.value,
        },
        sources: {
          enabled: enabled.source,
          n8nUrl: n8nUrl.source,
          uiBasePath: uiBasePath.source,
          uiTokenTtlSeconds: uiTokenTtl.source,
        },
        overlayPath: overlayPath ?? null,
      })

      return 0
    }

    outLine('workflows (n8n) config (effective — persisted overlay over gateway env over defaults):')
    outLine(`  enabled:            ${enabled.value ? 'on' : 'off'} [${enabled.source}]  (runtime)`)
    outLine(`  internal n8n URL:   ${n8nUrl.value} [${n8nUrl.source}]  (runtime)`)
    outLine(`  editor proxy path:  ${uiBasePath.value} [${uiBasePath.source}]  (applies on next gateway restart)`)
    outLine(`  editor cookie TTL:  ${uiTokenTtl.value}s [${uiTokenTtl.source}]  (runtime; new cookies)`)
    outLine(`  overlay file: ${overlayPath ?? '(SERVER_SETTINGS_PATH unset — env/default only)'}`)

    return 0
  }

  const value = args.positionals[0]

  if (action === 'set-enabled') {
    const parsed = parseOnOffClear(value)
    if (parsed === undefined) {
      throw new UsageError('workflows set-enabled <on|off|clear>')
    }
    const file = await updateOverlaySection('workflows', (w) => (parsed === null ? delete w.enabled : (w.enabled = parsed)))
    outLine(`workflows.enabled ${parsed === null ? 'cleared (falls back to env/default)' : parsed ? 'enabled' : 'disabled'}. Wrote ${file}.`)

    return 0
  }

  if (action === 'set-n8n-url') {
    if (!value) {
      throw new UsageError('workflows set-n8n-url <http(s)://host:port|clear>')
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('workflows', (w) => delete w.n8nUrl)
      outLine(`workflows.n8nUrl cleared. Wrote ${file}.`)

      return 0
    }
    if (!/^https?:\/\/.+/i.test(value)) {
      throw new UsageError('the n8n URL must be an absolute http(s) URL, e.g. http://n8n:5678')
    }
    const file = await updateOverlaySection('workflows', (w) => (w.n8nUrl = value))
    outLine(`workflows.n8nUrl set to ${value}. Wrote ${file}.`)

    return 0
  }

  if (action === 'set-ui-base-path') {
    if (!value) {
      throw new UsageError('workflows set-ui-base-path </path|clear>')
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('workflows', (w) => delete w.uiBasePath)
      outLine(`workflows.uiBasePath cleared. Wrote ${file}.`)

      return 0
    }
    if (!/^\/[A-Za-z0-9/_-]*$/.test(value)) {
      throw new UsageError('the editor proxy path must be an absolute path, e.g. /workflows-ui')
    }
    const file = await updateOverlaySection('workflows', (w) => (w.uiBasePath = value))
    outLine(`workflows.uiBasePath set to ${value}. Applies on the next gateway restart. Wrote ${file}.`)

    return 0
  }

  if (action === 'set-ui-token-ttl') {
    if (!value) {
      throw new UsageError('workflows set-ui-token-ttl <60..604800|clear>')
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('workflows', (w) => delete w.uiTokenTtlSeconds)
      outLine(`workflows.uiTokenTtlSeconds cleared. Wrote ${file}.`)

      return 0
    }
    const n = Number(value)
    if (!Number.isInteger(n) || n < 60 || n > 7 * 24 * 60 * 60) {
      throw new UsageError('workflows.uiTokenTtlSeconds must be an integer between 60 and 604800')
    }
    const file = await updateOverlaySection('workflows', (w) => (w.uiTokenTtlSeconds = n))
    outLine(`workflows.uiTokenTtlSeconds set to ${n}. Wrote ${file}.`)

    return 0
  }

  throw new UsageError(
    `unknown workflows action '${action}' — show | set-enabled <on|off> | set-n8n-url <url> | set-ui-base-path </path> | set-ui-token-ttl <seconds>`,
  )
}

const DEFAULT_PLUGINS_REPO_URL = 'https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist'

/**
 * PLUGINS gallery repo base URL (the SERVER_SETTINGS overlay `plugins.repoUrl`,
 * layered over the gateway PLUGINS_REPO_URL env, over the Standard Notes default).
 * The gateway proxies `<repoUrl>/packages.json` to the browser SAME-ORIGIN so the
 * strict CSP is satisfied. Reads + writes the SAME atomic overlay file the admin
 * panel writes.
 */
async function cmdPlugins(args: ParsedArgs, action: string | undefined): Promise<number> {
  if (action === undefined || action === 'show' || action === 'status') {
    const { persisted, overlayPath } = await readOverlaySection('plugins')
    const gatewayEnv = await readPackageEnv('api-gateway')
    const envOf = (name: string): string | undefined =>
      process.env[`API_GATEWAY_${name}`] ?? gatewayEnv[name] ?? undefined

    const repoUrl = (() => {
      if (typeof persisted.repoUrl === 'string' && persisted.repoUrl.trim() !== '') {
        return { value: persisted.repoUrl.trim().replace(/\/+$/, ''), source: 'persisted' }
      }
      const raw = envOf('PLUGINS_REPO_URL')
      if (raw !== undefined && raw.trim() !== '') {
        return { value: raw.trim().replace(/\/+$/, ''), source: 'env' }
      }

      return { value: DEFAULT_PLUGINS_REPO_URL, source: 'default' }
    })()

    if (args.options.json === true) {
      outJson({
        effective: { repoUrl: repoUrl.value, indexUrl: `${repoUrl.value}/packages.json` },
        sources: { repoUrl: repoUrl.source },
        overlayPath: overlayPath ?? null,
      })

      return 0
    }

    outLine('plugins gallery repo (effective — persisted overlay over gateway env over default):')
    outLine(`  repo base URL: ${repoUrl.value} [${repoUrl.source}]  (runtime)`)
    outLine(`  index URL:     ${repoUrl.value}/packages.json`)
    outLine(`  overlay file:  ${overlayPath ?? '(SERVER_SETTINGS_PATH unset — env/default only)'}`)

    return 0
  }

  const value = args.positionals[0]

  if (action === 'set-repo-url') {
    if (!value) {
      throw new UsageError('plugins set-repo-url <http(s)://host/path|clear>')
    }
    if (value === 'clear') {
      const file = await updateOverlaySection('plugins', (p) => delete p.repoUrl)
      outLine(`plugins.repoUrl cleared (falls back to env/default). Wrote ${file}.`)

      return 0
    }
    if (!/^https?:\/\/.+/i.test(value)) {
      throw new UsageError('the plugins repo URL must be an absolute http(s) URL')
    }
    const normalized = value.trim().replace(/\/+$/, '')
    const file = await updateOverlaySection('plugins', (p) => (p.repoUrl = normalized))
    outLine(`plugins.repoUrl set to ${normalized}. Wrote ${file}.`)

    return 0
  }

  throw new UsageError(`unknown plugins action '${action}' — show | set-repo-url <url|clear>`)
}

/* ---------------------------------------------------------------------------
 * WEBHOOKS
 * ------------------------------------------------------------------------- */

function webhookToRow(webhook: Webhook): { uuid: string; scope: string; enabled: boolean; events: string[]; targetUrl: string } {
  return {
    uuid: webhook.id.toString(),
    scope: webhook.props.userUuid === null ? 'global' : webhook.props.userUuid,
    enabled: webhook.props.enabled,
    events: webhook.props.events,
    targetUrl: webhook.props.targetUrl,
  }
}

async function cmdWebhooks(args: ParsedArgs, sub: string | undefined): Promise<number> {
  if (sub === 'list') {
    const container = await loadContainer()
    const webhookRepository = container.get<WebhookRepositoryInterface>(TYPES.Auth_WebhookRepository)

    const webhooks = [...(await webhookRepository.findGlobal())]
    const identifier = args.positionals[0]
    let scopeNote = 'global webhooks'
    if (identifier !== undefined) {
      const user = await resolveUser(container, identifier)
      const userUuid = requireResult(Uuid.create(user.uuid) as ResultLike<Uuid>)
      webhooks.push(...(await webhookRepository.findByUserUuid(userUuid)))
      scopeNote = `global webhooks + ${user.email}'s`
    }

    // The HMAC secret is NEVER shown here — it is printed once at creation.
    const rows = webhooks.map(webhookToRow)
    if (args.options.json === true) {
      outJson({ webhooks: rows })

      return 0
    }
    if (rows.length === 0) {
      outLine(`(no ${scopeNote})`)

      return 0
    }
    outLine(
      formatTable(
        ['UUID', 'SCOPE', 'ENABLED', 'EVENTS', 'TARGET URL'],
        rows.map((row) => [row.uuid, row.scope, row.enabled ? 'yes' : 'no', row.events.join(','), row.targetUrl]),
      ),
    )

    return 0
  }

  if (sub === 'create') {
    const [targetUrl, eventsCsv] = args.positionals
    if (!targetUrl || !eventsCsv) {
      throw new UsageError('webhooks create <url> <event,event> [--user <user>] — see \'srn-admin help webhooks\'')
    }
    const events = eventsCsv
      .split(',')
      .map((event) => event.trim())
      .filter(Boolean)

    const container = await loadContainer()
    const userIdentifier = stringOption(args.options, 'user')
    const scopedUser = userIdentifier !== undefined ? await resolveUser(container, userIdentifier) : null

    const registerWebhook = container.get<
      UseCase<
        { userUuid: string; targetUrl: string; events: string[]; global?: boolean },
        { uuid: string; userUuid: string | null; targetUrl: string; events: string[]; secret: string }
      >
    >(TYPES.Auth_RegisterWebhook)
    const created = requireResult(
      await registerWebhook.execute({
        // For a GLOBAL webhook the use case persists a null user_uuid; the
        // userUuid only has to be well-formed (there is no acting admin here).
        userUuid: scopedUser?.uuid ?? randomUUID(),
        targetUrl,
        events,
        global: scopedUser === null,
      }),
    )

    await writeAudit(container, AuditAction.WebhookCreated, { type: 'webhook', uuid: created.uuid }, {
      global: scopedUser === null,
      events,
    })

    outLine(`Created ${scopedUser === null ? 'GLOBAL' : `user-scoped (${scopedUser.email})`} webhook ${created.uuid}`)
    outLine(`  target: ${created.targetUrl}`)
    outLine(`  events: ${created.events.join(', ')}`)
    outLine(`  secret: ${created.secret}`)
    outLine('  Store the secret now — it is shown ONLY this once (X-SRN-Signature HMAC key).')

    return 0
  }

  if (sub === 'delete') {
    const webhookId = args.positionals[0]
    if (!webhookId) {
      throw new UsageError('webhooks delete <webhook-uuid>')
    }

    const container = await loadContainer()
    const deleteWebhook = container.get<UseCase<{ userUuid: string; webhookId: string; isAdmin?: boolean }>>(
      TYPES.Auth_DeleteWebhook,
    )
    requireResult(await deleteWebhook.execute({ userUuid: randomUUID(), webhookId, isAdmin: true }))

    await writeAudit(container, AuditAction.WebhookDeleted, { type: 'webhook', uuid: webhookId }, {})

    outLine(`Deleted webhook ${webhookId}`)

    return 0
  }

  throw new UsageError(`unknown webhooks subcommand '${sub ?? '(none)'}' — list | create | delete`)
}

/* ---------------------------------------------------------------------------
 * AUDIT LOG
 * ------------------------------------------------------------------------- */

async function cmdAudit(args: ParsedArgs): Promise<number> {
  const { options } = args
  const limitRaw = stringOption(options, 'limit')
  const offsetRaw = stringOption(options, 'offset')
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 50
  const offset = offsetRaw !== undefined ? Number.parseInt(offsetRaw, 10) : 0
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(offset) || offset < 0) {
    throw new UsageError('--limit must be a positive integer and --offset a non-negative integer')
  }

  const container = await loadContainer()

  let actorUuid: string | undefined
  const userIdentifier = stringOption(options, 'user')
  if (userIdentifier !== undefined) {
    actorUuid = (await resolveUser(container, userIdentifier)).uuid
  }

  const queryAuditLog = container.get<
    UseCase<
      { actorUuid?: string; action?: string; from?: string; to?: string; limit?: number; offset?: number },
      { entries: AuditLogEntry[]; total: number; limit: number; offset: number }
    >
  >(TYPES.Auth_QueryAuditLog)
  const result = requireResult(
    await queryAuditLog.execute({
      actorUuid,
      action: stringOption(options, 'action'),
      from: stringOption(options, 'from'),
      to: stringOption(options, 'to'),
      limit,
      offset,
    }),
  )

  const mapper = container.get<MapperInterface<AuditLogEntry, AuditLogEntryHttpProjection>>(
    TYPES.Auth_AuditLogEntryHttpMapper,
  )
  const projections = result.entries.map((entry) => mapper.toProjection(entry))

  if (options.json === true) {
    outJson({ entries: projections, total: result.total, limit: result.limit, offset: result.offset })

    return 0
  }

  if (projections.length === 0) {
    outLine('(no audit entries match)')

    return 0
  }

  outLine(
    formatTable(
      ['TIME', 'ACTION', 'ACTOR', 'TARGET', 'METADATA'],
      projections.map((entry) => [
        entry.createdAt,
        entry.action,
        entry.actorUuid ?? '-',
        entry.targetUuid ? `${entry.targetType ?? '?'}:${entry.targetUuid}` : '-',
        entry.metadata ? JSON.stringify(entry.metadata) : '-',
      ]),
    ),
  )
  outLine(`\n${result.offset + 1}-${result.offset + projections.length} of ${result.total} entr(ies), newest first`)

  return 0
}

/* ---------------------------------------------------------------------------
 * STATUS / LOGS / CONFIG (container-free — instant)
 * ------------------------------------------------------------------------- */

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const packageNames = ['api-gateway', 'syncing-server', 'auth', 'files', 'revisions']
  const envFiles: Record<string, Record<string, string>> = {}
  await Promise.all(
    packageNames.map(async (name) => {
      envFiles[name] = await readPackageEnv(name)
    }),
  )

  const targets = serviceProbeTargets(envFiles)

  // DB/Redis reachability: raw TCP dial using the same envs the services use.
  const authEnv = envFiles.auth ?? {}
  const dbHost = process.env.DB_HOST ?? authEnv.DB_HOST
  const dbPort = Number.parseInt(process.env.DB_PORT ?? authEnv.DB_PORT ?? '3306', 10)
  let redisHost = process.env.REDIS_HOST
  let redisPort = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10)
  const redisUrl = process.env.REDIS_URL ?? authEnv.REDIS_URL
  if (!redisHost && redisUrl) {
    try {
      const parsed = new URL(redisUrl.split(',')[0])
      redisHost = parsed.hostname
      redisPort = parsed.port ? Number.parseInt(parsed.port, 10) : 6379
    } catch {
      /* unparsable REDIS_URL — reported as unknown below */
    }
  }

  const [probes, dbReachable, redisReachable] = await Promise.all([
    Promise.all(targets.map((target) => probeReadiness(target.name, target.port))),
    dbHost ? tcpProbe(dbHost, Number.isFinite(dbPort) ? dbPort : 3306) : Promise.resolve(null),
    redisHost ? tcpProbe(redisHost, Number.isFinite(redisPort) ? redisPort : 6379) : Promise.resolve(null),
  ])

  if (args.options.json === true) {
    outJson({
      services: probes,
      dependencies: {
        db: { host: dbHost ?? null, reachable: dbReachable },
        redis: { host: redisHost ?? null, reachable: redisReachable },
      },
      note: 'worker processes have no health port and are not probed — check logs --service <name>-worker',
    })

    return 0
  }

  const chip = (status: string): string => {
    return status === 'ok' ? '[ OK ]' : status === 'degraded' ? '[WARN]' : '[DOWN]'
  }

  const rows = probes.map((probe) => [
    chip(probe.status),
    probe.name,
    `:${probe.port}`,
    probe.checks ? Object.entries(probe.checks).map(([key, ok]) => `${key}:${ok ? 'ok' : 'FAIL'}`).join(' ') : (probe.detail ?? ''),
  ])
  const dependencyRow = (label: string, host: string | undefined, reachable: boolean | null): string[] => [
    reachable === null ? '[ ?? ]' : reachable ? '[ OK ]' : '[DOWN]',
    label,
    host ?? '(not configured)',
    reachable === null ? 'no address to probe' : reachable ? 'tcp reachable' : 'tcp unreachable',
  ]
  rows.push(dependencyRow('db', dbHost, dbReachable))
  rows.push(dependencyRow('redis', redisHost, redisReachable))

  outLine(formatTable(['STATE', 'SERVICE', 'ADDR', 'DETAIL'], rows))
  outLine('\nWorker processes (auth-worker, files-worker, ...) expose no health port — see: srn-admin logs --service auth-worker')

  return 0
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
  const { options } = args
  const tailRaw = stringOption(options, 'tail')
  const limit = tailRaw !== undefined ? Number.parseInt(tailRaw, 10) : 100
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new UsageError('--tail must be a positive integer')
  }

  const logsDirectory = process.env.SERVER_LOGS_PATH ?? '/var/lib/server/logs'
  const result = await tailLogFiles(
    {
      readdir: (directory) => fsPromises.readdir(directory),
      readFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      joinPath: (...parts) => path.join(...parts),
    },
    logsDirectory,
    { limit, service: stringOption(options, 'service'), level: stringOption(options, 'level') },
  )

  // Chronological (oldest first) for reading, like `tail`.
  const entries = [...result.entries].reverse()

  if (options.json === true) {
    outJson({ entries, truncated: result.truncated, logsDirectory })

    return 0
  }

  if (entries.length === 0) {
    outLine(`(no matching log lines under ${logsDirectory})`)

    return 0
  }
  for (const entry of entries as CliLogEntry[]) {
    const time = entry.timestamp ?? '-'
    const level = entry.level ?? '-'
    outLine(`${time}  ${(entry.service ?? '-').padEnd(22)} ${level.padEnd(5)} ${entry.message}`)
  }
  if (result.truncated) {
    outLine('... (older matching lines exist — raise --tail)')
  }

  return 0
}

async function cmdConfig(args: ParsedArgs): Promise<number> {
  const packageEnvFiles: Partial<Record<OperatorService, Record<string, string>>> = {
    auth: await readPackageEnv('auth'),
    'api-gateway': await readPackageEnv('api-gateway'),
  }

  const resolved = OPERATOR_ENVS.map((spec) =>
    resolveOperatorEnv(spec, process.env as Record<string, string | undefined>, packageEnvFiles),
  )

  if (args.options.json === true) {
    outJson({
      config: resolved,
      honesty: {
        envValues:
          'every env above is read at BOOT and is read-only from this CLI — change it in the operator .env (compose level) and restart the stack',
        runtimeSettable: "only the persisted registration gate is runtime-settable: 'srn-admin registration enable|disable'",
      },
    })

    return 0
  }

  outLine(
    formatTable(
      ['ENV', 'SERVICE', 'VALUE', 'SOURCE', 'RESTART TO CHANGE'],
      resolved.map((entry) => [
        entry.env,
        entry.service,
        entry.effective + (entry.note ? ' *' : ''),
        entry.source,
        entry.restartRequired ? 'yes' : 'no',
      ]),
    ),
  )
  for (const entry of resolved) {
    if (entry.note) {
      outLine(`  * ${entry.env}: ${entry.note}`)
    }
  }
  outLine('')
  outLine('HONESTY: all values above are read at BOOT. This CLI cannot change them —')
  outLine('edit the operator .env (compose level, using the AUTH_SERVER_/API_GATEWAY_')
  outLine('prefixes) and restart the stack. The only runtime-settable server flag is')
  outLine("the persisted registration gate: 'srn-admin registration enable|disable'.")

  return 0
}

/* ---------------------------------------------------------------------------
 * RBAC GROUPS (existing commands, unchanged semantics)
 * ------------------------------------------------------------------------- */

async function cmdGroup(args: string[]): Promise<number> {
  const [sub, ...rest] = args
  if (sub === undefined || sub === 'help') {
    out(helpFor('group'))

    return sub === undefined ? 1 : 0
  }

  const container = await loadContainer()

  // Resolve a <group> argument (name OR uuid) to a group uuid via one list call.
  const resolveGroupUuid = async (identifier: string): Promise<string> => {
    const listGroups = container.get<UseCase<undefined>>(TYPES.Auth_ListGroups)
    const groups = requireResult(await listGroups.execute(undefined)) as GroupLike[]
    const identifierIsUuid = !Uuid.create(identifier).isFailed()

    return matchGroupUuidInList(groups, identifier, identifierIsUuid)
  }

  switch (sub) {
    case 'list': {
      const listGroups = container.get<UseCase<undefined>>(TYPES.Auth_ListGroups)
      const groups = requireResult(await listGroups.execute(undefined)) as GroupLike[]
      if (groups.length === 0) {
        outLine('(no groups)')
      }
      for (const group of groups) {
        outLine(`${group.id?.toString() ?? ''}  ${group.props?.name ?? ''}`)
      }

      return 0
    }

    case 'create': {
      const name = rest[0]
      if (!name) {
        throw new UsageError('group create <name> [comma,separated,roles]')
      }
      const roleNames = rest[1]
        ? rest[1]
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined
      const createGroup = container.get<UseCase<{ name: string; description?: string | null; roleNames?: string[] }>>(
        TYPES.Auth_CreateGroup,
      )
      const group = requireResult(await createGroup.execute({ name, roleNames })) as { id?: { toString(): string } }
      outLine(`Created group "${name}" (${group.id?.toString() ?? ''})`)

      return 0
    }

    case 'delete': {
      const groupArg = rest[0]
      if (!groupArg) {
        throw new UsageError('group delete <group>')
      }
      const groupUuid = await resolveGroupUuid(groupArg)
      const deleteGroup = container.get<UseCase<{ groupUuid: string }>>(TYPES.Auth_DeleteGroup)
      requireResult(await deleteGroup.execute({ groupUuid }))
      outLine(`Deleted group ${groupUuid}`)

      return 0
    }

    case 'set-roles': {
      const [groupArg, rolesCsv] = rest
      if (!groupArg || !rolesCsv) {
        throw new UsageError('group set-roles <group> <role1,role2>')
      }
      const groupUuid = await resolveGroupUuid(groupArg)
      const setRoles = container.get<UseCase<{ groupUuid: string; roleNames: string[] }>>(TYPES.Auth_SetGroupRoles)
      requireResult(
        await setRoles.execute({
          groupUuid,
          roleNames: rolesCsv
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      )
      outLine(`Set roles for group ${groupUuid}`)

      return 0
    }

    case 'members': {
      const groupArg = rest[0]
      if (!groupArg) {
        throw new UsageError('group members <group>')
      }
      const groupUuid = await resolveGroupUuid(groupArg)
      const listMembers = container.get<UseCase<{ groupUuid: string }>>(TYPES.Auth_ListGroupMembers)
      const members = requireResult(await listMembers.execute({ groupUuid })) as Array<{
        uuid: string
        email: string | null
      }>
      if (members.length === 0) {
        outLine('(no members)')
      }
      for (const member of members) {
        outLine(`${member.uuid}  ${member.email ?? ''}`)
      }

      return 0
    }

    case 'add-user':
    case 'remove-user': {
      const [groupArg, identifier] = rest
      if (!groupArg || !identifier) {
        throw new UsageError(`group ${sub} <group> <user>`)
      }
      const groupUuid = await resolveGroupUuid(groupArg)
      const user = await resolveUser(container, identifier)
      const symbol = sub === 'add-user' ? TYPES.Auth_AddUserToGroup : TYPES.Auth_RemoveUserFromGroup
      const useCase = container.get<UseCase<{ groupUuid: string; userUuid: string }>>(symbol)
      requireResult(await useCase.execute({ groupUuid, userUuid: user.uuid }))
      outLine(`${sub === 'add-user' ? 'Added' : 'Removed'} ${identifier} ${sub === 'add-user' ? 'to' : 'from'} group ${groupUuid}`)

      return 0
    }

    default:
      throw new UsageError(`unknown group subcommand: ${sub} — see "srn-admin help group"`)
  }
}

/* ---------------------------------------------------------------------------
 * Dispatch
 * ------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(helpFor(rest[0], rest[1]))

    return 0
  }

  // `<command> help` and `<command> <sub> --help` also print help — instantly.
  if (rest[0] === 'help') {
    out(helpFor(command, rest[1]))

    return 0
  }

  const args = parseArgs(rest)
  if (args.options.help === true) {
    out(helpFor(command, args.positionals[0]))

    return 0
  }

  switch (command) {
    /* USERS ------------------------------------------------------------- */
    case 'users': {
      const [sub, ...subPositionals] = args.positionals
      if (sub !== 'list') {
        throw new UsageError(`unknown users subcommand '${sub ?? '(none)'}' — try 'srn-admin users list'`)
      }

      return cmdUsersList({ positionals: subPositionals, options: args.options })
    }

    case 'user':
    case 'whois':
    case 'list-roles':
      return cmdUser(args)

    case 'ban':
      return cmdBan(args, true)
    case 'unban':
      return cmdBan(args, false)

    case 'suspend':
      return cmdSuspend(args, true)
    case 'unsuspend':
      return cmdSuspend(args, false)

    case 'delete-user':
      return cmdDeleteUser(args)

    case 'reset-mfa':
      return cmdResetMfa(args)
    case 'fix-quota':
      return cmdFixQuota(args)

    /* ROLES & GROUPS ----------------------------------------------------- */
    case 'roles': {
      const [sub, ...subPositionals] = args.positionals
      if (sub === 'list') {
        const roleNames = Object.values(RoleName.NAMES)
        if (args.options.json === true) {
          outJson({ roleNames })
        } else {
          outLine(roleNames.join('\n'))
        }

        return 0
      }
      if (sub === 'grant' || sub === 'revoke') {
        return cmdRolesMutate(subPositionals[0], subPositionals[1], sub === 'grant')
      }
      throw new UsageError(`unknown roles subcommand '${sub ?? '(none)'}' — list | grant | revoke`)
    }

    case 'grant-admin':
      return cmdRolesMutate(args.positionals[0], ADMIN_ROLE_NAME, true)
    case 'revoke-admin':
      return cmdRolesMutate(args.positionals[0], ADMIN_ROLE_NAME, false)

    case 'group':
      return cmdGroup(args.positionals)

    /* FLAGS --------------------------------------------------------------- */
    case 'flags': {
      const [sub, ...subPositionals] = args.positionals
      const subArgs = { positionals: subPositionals, options: args.options }
      switch (sub) {
        case 'list':
          return printFlagsList()
        case 'get':
          return cmdFlagsGet(subArgs)
        case 'set':
          return cmdFlagsSet(subArgs, false)
        case 'unset':
          return cmdFlagsSet(subArgs, true)
        default:
          throw new UsageError(`unknown flags subcommand '${sub ?? '(none)'}' — list | get | set | unset`)
      }
    }

    case 'storage-limit': {
      const [sub, ...subPositionals] = args.positionals
      if (sub === 'get') {
        return cmdStorageLimitGet({ positionals: subPositionals, options: args.options })
      }
      if (sub === 'set') {
        const [identifier, value] = subPositionals
        if (!identifier || value === undefined) {
          throw new UsageError('storage-limit set <user> <bytes|unlimited>')
        }

        return setStorageLimit(identifier, value)
      }
      throw new UsageError(`unknown storage-limit subcommand '${sub ?? '(none)'}' — get | set`)
    }

    /* SERVER --------------------------------------------------------------- */
    case 'registration':
      return cmdRegistration({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    case 'webhooks':
      return cmdWebhooks({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    /* ANTI-ABUSE ----------------------------------------------------------- */
    case 'ip':
      return cmdIp({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    case 'limits':
      return cmdLimits(args)

    /* RUNTIME FEATURE CONFIG (SERVER_SETTINGS overlay) ---------------------- */
    case 'ocr':
      return cmdOcr({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    case 'workflows':
      return cmdWorkflows({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    case 'plugins':
      return cmdPlugins({ positionals: args.positionals.slice(1), options: args.options }, args.positionals[0])

    case 'config':
      return cmdConfig(args)

    /* DIAGNOSTICS ----------------------------------------------------------- */
    case 'status':
      return cmdStatus(args)

    case 'logs':
      return cmdLogs(args)

    case 'audit':
      return cmdAudit(args)

    default:
      errLine(`Unknown command: ${command}\n`)
      out(usage())

      return 1
  }
}

void main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      errLine(`srn-admin: ${error.message}`)
    } else {
      errLine(`srn-admin: ${(error as Error).message}`)
    }
    process.exit(1)
  })
