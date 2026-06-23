import 'reflect-metadata'

import { Email, RoleName, SettingName, Uuid } from '@standardnotes/domain-core'

import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import TYPES from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { UserRepositoryInterface } from '../src/Domain/User/UserRepositoryInterface'
import { RoleServiceInterface } from '../src/Domain/Role/RoleServiceInterface'
import { User } from '../src/Domain/User/User'

/**
 * Standard Red Notes: in-container admin CLI ("srn-admin").
 *
 * Runs INSIDE the auth container (same DI container + DataSource as the other
 * maintenance bins, in 'worker' mode so it never triggers migrations) and
 * performs admin operations by reusing the auth package's own use-cases and
 * repositories — no HTTP, no admin session required.
 *
 * Invoke via:
 *   docker compose exec server node packages/auth/docker/entrypoint-admin.js <command> [args]
 * (the entrypoint wires up Yarn PnP, then loads this compiled bin).
 */

const ADMIN_ROLE = RoleName.NAMES.InternalTeamUser

// Minimal shape of the package's Result<T> + a use-case, so we can drive the
// use-cases through the container without importing each one's file.
type ResultLike<T> = { isFailed(): boolean; getError(): string; getValue(): T }
type UseCase<Dto, T = unknown> = { execute(dto: Dto): Promise<ResultLike<T>> }

function usage(): void {
  process.stdout.write(
    `srn-admin — in-container admin operations for the Standard Red Notes auth server

USAGE
  srn-admin <command> [args]

  A <user> may be an email address or a user uuid.

USERS / ROLES
  whois <user>                       Show a user's uuid, email, direct roles
  grant-admin <user>                 Give a user the admin role (${ADMIN_ROLE})
  revoke-admin <user>                Remove the admin role from a user
  list-roles <user>                  List a user's direct + effective roles
  reset-mfa <user>                   Disable/clear a user's 2FA (and recovery codes)
  fix-quota <email>                  Recalculate a user's storage quota

RBAC GROUPS
  group list                         List all groups
  group create <name> [roles]        Create a group ([roles] = comma-separated role names)
  group delete <groupUuid>           Delete a group
  group set-roles <groupUuid> <r,r>  Set a group's roles (comma-separated)
  group members <groupUuid>          List a group's members
  group add-user <groupUuid> <user>  Add a user to a group
  group remove-user <groupUuid> <user>  Remove a user from a group
`,
  )
}

async function resolveUser(userRepository: UserRepositoryInterface, identifier: string): Promise<User | null> {
  const asUuid = Uuid.create(identifier)
  if (!asUuid.isFailed()) {
    const byUuid = await userRepository.findOneByUuid(asUuid.getValue())
    if (byUuid) {
      return byUuid
    }
  }
  const asEmail = Email.create(identifier)
  if (!asEmail.isFailed()) {
    return userRepository.findOneByUsernameOrEmail(asEmail.getValue())
  }
  return null
}

async function directRoleNames(user: User): Promise<string[]> {
  const roles = await user.roles
  return roles.map((role) => role.name)
}

function requireResult<T>(result: ResultLike<T>): T {
  if (result.isFailed()) {
    throw new Error(result.getError())
  }
  return result.getValue()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(container: any): Promise<number> {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage()
    return 0
  }

  const userRepository = container.get(TYPES.Auth_UserRepository) as UserRepositoryInterface

  const needUser = async (identifier: string | undefined): Promise<User> => {
    if (!identifier) {
      throw new Error('a <user> (email or uuid) is required')
    }
    const user = await resolveUser(userRepository, identifier)
    if (!user) {
      throw new Error(`no user found for "${identifier}"`)
    }
    return user
  }

  switch (command) {
    case 'whois': {
      const user = await needUser(args[0])
      process.stdout.write(
        `uuid:  ${user.uuid}\nemail: ${user.email}\nroles: ${(await directRoleNames(user)).join(', ') || '(none)'}\n`,
      )
      return 0
    }

    case 'grant-admin':
    case 'revoke-admin': {
      const user = await needUser(args[0])
      const roleService = container.get(TYPES.Auth_RoleService) as RoleServiceInterface
      const roleName = requireResult(RoleName.create(ADMIN_ROLE) as ResultLike<RoleName>)
      const userUuid = requireResult(Uuid.create(user.uuid) as ResultLike<Uuid>)
      if (command === 'grant-admin') {
        await roleService.addRoleToUser(userUuid, roleName)
        process.stdout.write(`Granted ${ADMIN_ROLE} to ${user.email} (${user.uuid})\n`)
      } else {
        await roleService.removeRoleFromUser(userUuid, roleName)
        process.stdout.write(`Revoked ${ADMIN_ROLE} from ${user.email} (${user.uuid})\n`)
      }
      return 0
    }

    case 'list-roles': {
      const user = await needUser(args[0])
      process.stdout.write(`direct roles: ${(await directRoleNames(user)).join(', ') || '(none)'}\n`)
      try {
        const getEffective = container.get(TYPES.Auth_GetUserEffectivePermissions) as UseCase<{ userUuid: string }>
        const effective = requireResult(await getEffective.execute({ userUuid: user.uuid })) as {
          effectiveRoleNames?: string[]
          effectivePermissionNames?: string[]
        }
        process.stdout.write(`effective roles: ${(effective.effectiveRoleNames ?? []).join(', ') || '(none)'}\n`)
        process.stdout.write(
          `effective permissions: ${(effective.effectivePermissionNames ?? []).join(', ') || '(none)'}\n`,
        )
      } catch {
        /* effective-permissions use-case unavailable; direct roles already printed */
      }
      return 0
    }

    case 'reset-mfa': {
      const user = await needUser(args[0])
      const deleteSetting = container.get(TYPES.Auth_DeleteSetting) as UseCase<{
        userUuid: string
        settingName: string
        softDelete?: boolean
      }>
      requireResult(
        await deleteSetting.execute({ userUuid: user.uuid, settingName: SettingName.NAMES.MfaSecret, softDelete: true }),
      )
      process.stdout.write(`Cleared 2FA (and recovery codes) for ${user.email} (${user.uuid})\n`)
      return 0
    }

    case 'fix-quota': {
      const user = await needUser(args[0])
      const fixQuota = container.get(TYPES.Auth_FixStorageQuotaForUser) as UseCase<{ userEmail: string }>
      requireResult(await fixQuota.execute({ userEmail: user.email }))
      process.stdout.write(`Recalculated storage quota for ${user.email}\n`)
      return 0
    }

    case 'group': {
      return runGroup(container, args)
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n`)
      usage()
      return 1
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runGroup(container: any, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  const userRepository = container.get(TYPES.Auth_UserRepository) as UserRepositoryInterface

  const resolveUserUuid = async (identifier: string): Promise<string> => {
    const user = await resolveUser(userRepository, identifier)
    if (!user) {
      throw new Error(`no user found for "${identifier}"`)
    }
    return user.uuid
  }

  switch (sub) {
    case 'list': {
      const listGroups = container.get(TYPES.Auth_ListGroups) as UseCase<undefined>
      const groups = requireResult(await listGroups.execute(undefined)) as Array<{
        id?: { toString(): string }
        props?: { name?: string }
      }>
      if (groups.length === 0) {
        process.stdout.write('(no groups)\n')
      }
      for (const group of groups) {
        process.stdout.write(`${group.id?.toString() ?? ''}  ${group.props?.name ?? ''}\n`)
      }
      return 0
    }

    case 'create': {
      const name = rest[0]
      if (!name) {
        throw new Error('group create <name> [comma,separated,roles]')
      }
      const roleNames = rest[1] ? rest[1].split(',').map((value) => value.trim()).filter(Boolean) : undefined
      const createGroup = container.get(TYPES.Auth_CreateGroup) as UseCase<{
        name: string
        description?: string | null
        roleNames?: string[]
      }>
      const group = requireResult(await createGroup.execute({ name, roleNames })) as { id?: { toString(): string } }
      process.stdout.write(`Created group "${name}" (${group.id?.toString() ?? ''})\n`)
      return 0
    }

    case 'delete': {
      const groupUuid = rest[0]
      if (!groupUuid) {
        throw new Error('group delete <groupUuid>')
      }
      const deleteGroup = container.get(TYPES.Auth_DeleteGroup) as UseCase<{ groupUuid: string }>
      requireResult(await deleteGroup.execute({ groupUuid }))
      process.stdout.write(`Deleted group ${groupUuid}\n`)
      return 0
    }

    case 'set-roles': {
      const [groupUuid, rolesCsv] = rest
      if (!groupUuid || !rolesCsv) {
        throw new Error('group set-roles <groupUuid> <role1,role2>')
      }
      const setRoles = container.get(TYPES.Auth_SetGroupRoles) as UseCase<{ groupUuid: string; roleNames: string[] }>
      requireResult(
        await setRoles.execute({
          groupUuid,
          roleNames: rolesCsv.split(',').map((value) => value.trim()).filter(Boolean),
        }),
      )
      process.stdout.write(`Set roles for group ${groupUuid}\n`)
      return 0
    }

    case 'members': {
      const groupUuid = rest[0]
      if (!groupUuid) {
        throw new Error('group members <groupUuid>')
      }
      const listMembers = container.get(TYPES.Auth_ListGroupMembers) as UseCase<{ groupUuid: string }>
      const members = requireResult(await listMembers.execute({ groupUuid })) as Array<{
        uuid: string
        email: string | null
      }>
      if (members.length === 0) {
        process.stdout.write('(no members)\n')
      }
      for (const member of members) {
        process.stdout.write(`${member.uuid}  ${member.email ?? ''}\n`)
      }
      return 0
    }

    case 'add-user':
    case 'remove-user': {
      const [groupUuid, identifier] = rest
      if (!groupUuid || !identifier) {
        throw new Error(`group ${sub} <groupUuid> <user>`)
      }
      const userUuid = await resolveUserUuid(identifier)
      const symbol = sub === 'add-user' ? TYPES.Auth_AddUserToGroup : TYPES.Auth_RemoveUserFromGroup
      const useCase = container.get(symbol) as UseCase<{ groupUuid: string; userUuid: string }>
      requireResult(await useCase.execute({ groupUuid, userUuid }))
      process.stdout.write(`${sub === 'add-user' ? 'Added' : 'Removed'} ${identifier} ${sub === 'add-user' ? 'to' : 'from'} group ${groupUuid}\n`)
      return 0
    }

    default:
      throw new Error(`unknown group subcommand: ${sub ?? '(none)'} — see "srn-admin help"`)
  }
}

const container = new ContainerConfigLoader('worker')
void container.load().then((container) => {
  const env: Env = new Env()
  env.load()

  run(container)
    .then((code) => {
      process.exit(code)
    })
    .catch((error) => {
      process.stderr.write(`srn-admin: ${(error as Error).message}\n`)
      process.exit(1)
    })
})
