import 'reflect-metadata'

// `otplib` reaches an ESM-only base32 codec that jest cannot `require`. TOTP is
// not what this suite is about, and every other suite that imports it does this.
jest.mock('otplib', () => ({
  generateSync: jest.fn(() => '123456'),
  verifySync: jest.fn(() => ({ valid: false })),
}))

import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ControllerContainer, RoleName } from '@standardnotes/domain-core'
import { DirectCallDomainEventPublisher } from '@standardnotes/domain-events-infra'
import { Container } from 'inversify'
import { Repository } from 'typeorm'
import * as winston from 'winston'

import { ContainerConfigLoader } from './Container'
import TYPES from './Types'
import { User } from '../Domain/User/User'

type DirectCallResult = { statusCode: number; json: Record<string, unknown> }
type DirectCallMethod = (request: never, response: never) => Promise<DirectCallResult>

/**
 * The real controller container, which also remembers every method name it was
 * handed. That list is what the container ACTUALLY registered on this topology,
 * so the checks below are about the handlers that exist rather than about the
 * handlers somebody remembered to write down here.
 */
class RecordingControllerContainer extends ControllerContainer {
  readonly registered: string[] = []

  override register(methodIdentifier: string, binding: (request: never, response: never) => Promise<unknown>): void {
    this.registered.push(methodIdentifier)
    super.register(methodIdentifier, binding)
  }
}

/**
 * The fifteen handlers that were dead. They are NOT the list under test any
 * more -- both lists below are derived -- they are the floor under the
 * derivation: if the recorded registrations or the gateway's table ever stop
 * containing these, it is the deriving that broke, and a check over an empty
 * list must not be allowed to pass for that reason.
 */
const HANDLERS_THAT_WERE_DEAD = [
  'admin.listGroups',
  'admin.createGroup',
  'admin.deleteGroup',
  'admin.setGroupRoles',
  'admin.listGroupMembers',
  'admin.addUserToGroup',
  'admin.removeUserFromGroup',
  'admin.getUserEffectivePermissions',
  'admin.listRolesWithPermissions',
  'admin.setRolePermissions',
  'admin.createCustomRole',
  'admin.deleteCustomRole',
  'admin.getPermissionCatalog',
  'admin.getRoleHolders',
  'admin.resolveRoleSetPermissions',
]

/**
 * Every `admin.*` method the gateway resolves a route to on the all-in-one, read
 * from the gateway's own table (`['[GET]:admin/...', 'admin.lookupUser']`). The
 * gateway reaches auth by these names and nothing else there, so a name in that
 * table that auth never registers is a route that answers 500 on this topology
 * only.
 */
const adminMethodsTheGatewayResolves = (): string[] => {
  const resolver = readFileSync(
    join(__dirname, '..', '..', '..', 'api-gateway', 'src', 'Service', 'Resolver', 'EndpointResolver.ts'),
    'utf8',
  )

  return [...resolver.matchAll(/'\[[A-Z]+\]:[^']*',\s*'(admin\.[A-Za-z]+)'/g)].map((match) => match[1])
}

/**
 * Standard Red Notes: the auth container EXACTLY as the all-in-one container
 * builds it -- `MODE=home-server`, a real sqlite file, in-memory cache, the
 * in-process controller container -- and the admin endpoints reached the way the
 * gateway reaches them there: by DirectCall method name, with no Express in
 * between. (The schema is synchronised from the entities, as the other
 * integration suites here do, because migrations are loaded as compiled `.js`.)
 *
 * *** WHY THIS BOOTS THE REAL CONTAINER. *** What broke was not a use case and
 * not a controller method; both have their own suites and both were correct. It
 * was the home-server branch of `Container.ts` constructing `BaseAdminController`
 * with a literal `undefined` in sixteen positions, so every endpoint behind them
 * answered `500 ... not available` on the topology this project ships by default
 * while the multi-container build (which injects all sixteen) stayed green.
 * Measured on a running all-in-one: `GET /v1/admin/users/:uuid/effective-permissions`
 * answered 500 for every account, and the user detail panel printed "Effective
 * roles/permissions could not be loaded". A fake standing in for the container
 * cannot see that; only the container can.
 */
describe('admin RBAC endpoints on the all-in-one (home-server) container', () => {
  let directory: string
  let container: Container
  let controllers: RecordingControllerContainer
  let userUuid: string
  const adminUuid = randomUUID()

  const call = async (method: string, request: Record<string, unknown> = {}): Promise<DirectCallResult> => {
    const handler = controllers.get(method) as DirectCallMethod | undefined
    if (handler === undefined) {
      throw new Error(`Method ${method} not found`)
    }

    return handler(
      { params: {}, body: {}, query: {}, headers: {}, ...request } as never,
      {
        locals: { user: { uuid: adminUuid }, roles: [{ uuid: randomUUID(), name: RoleName.NAMES.AdminUser }] },
      } as never,
    )
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'srn-auth-home-server-'))
    controllers = new RecordingControllerContainer()
    container = await new ContainerConfigLoader('server').load({
      controllerConatiner: controllers,
      directCallDomainEventPublisher: new DirectCallDomainEventPublisher(),
      logger: winston.createLogger({ silent: true }) as never,
      environmentOverrides: {
        MODE: 'home-server',
        DB_TYPE: 'sqlite',
        CACHE_TYPE: 'memory',
        DB_SQLITE_DATABASE_PATH: join(directory, 'home_server.sqlite'),
        // Throwaway values for the secrets the container refuses to start without.
        JWT_SECRET: 'j'.repeat(64),
        AUTH_JWT_SECRET: 'a'.repeat(64),
        AUTH_JWT_TTL: '60000',
        ENCRYPTION_SERVER_KEY: 'e'.repeat(64),
        PSEUDO_KEY_PARAMS_KEY: 'p'.repeat(64),
      },
    })

    // The schema, then the rows the admin surface reads: three roles, one
    // permission each, and one account holding two of the roles directly.
    const connection = container.get<Repository<User>>(TYPES.Auth_ORMUserRepository).manager.connection
    await connection.synchronize()
    const stamp = '2026-01-01 00:00:00'
    const roleUuids: Record<string, string> = {}
    for (const [roleName, permissionName] of [
      [RoleName.NAMES.CoreUser, 'server:two-factor-auth'],
      [RoleName.NAMES.AdminUser, 'server:universal-second-factor'],
      [RoleName.NAMES.ProUser, 'server:files'],
    ]) {
      const roleUuid = randomUUID()
      const permissionUuid = randomUUID()
      roleUuids[roleName] = roleUuid
      await connection.query('INSERT INTO roles (uuid, name, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', [
        roleUuid,
        roleName,
        stamp,
        stamp,
      ])
      await connection.query('INSERT INTO permissions (uuid, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
        permissionUuid,
        permissionName,
        stamp,
        stamp,
      ])
      await connection.query('INSERT INTO role_permissions (permission_uuid, role_uuid) VALUES (?, ?)', [
        permissionUuid,
        roleUuid,
      ])
    }

    userUuid = randomUUID()
    await connection.getRepository(User).save({
      uuid: userUuid,
      version: '004',
      email: 'rbac@example.com',
      pwNonce: 'nonce',
      encryptedPassword: 'hash',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    for (const roleName of [RoleName.NAMES.CoreUser, RoleName.NAMES.AdminUser]) {
      await connection.query('INSERT INTO user_roles (role_uuid, user_uuid) VALUES (?, ?)', [
        roleUuids[roleName],
        userUuid,
      ])
    }
  }, 120_000)

  afterAll(async () => {
    await container?.get<Repository<User>>(TYPES.Auth_ORMUserRepository).manager.connection.destroy()
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Windows keeps the sqlite file locked if the container never finished loading.
    }
  })

  it('answers a user’s effective roles and permissions instead of "not available"', async () => {
    const result = await call('admin.getUserEffectivePermissions', { params: { userUuid } })

    expect(result.statusCode).toBe(200)
    expect([...(result.json.directRoleNames as string[])].sort()).toEqual(['ADMIN_USER', 'CORE_USER'])
    expect(result.json.groupRoleNames).toEqual([])
    expect([...(result.json.effectiveRoleNames as string[])].sort()).toEqual(['ADMIN_USER', 'CORE_USER'])
    // Resolved through the real role -> permission rows, not echoed from the roles.
    expect([...(result.json.effectivePermissionNames as string[])].sort()).toEqual([
      'server:two-factor-auth',
      'server:universal-second-factor',
    ])
  })

  it('refuses a user it cannot find by name, not with a bare failure', async () => {
    const result = await call('admin.getUserEffectivePermissions', { params: { userUuid: randomUUID() } })

    expect(result.statusCode).toBe(400)
    expect(result.json).toEqual({ error: { message: 'Could not compute effective permissions: user not found.' } })
  })

  /**
   * The whole "Groups & roles" surface shares the sixteen positions, so the same
   * construction that broke the user panel left every one of these answering
   * "not available" too. One pass through the real sqlite tables: a group confers
   * a role, the member's effective roles show it as GROUP-conferred, and removing
   * the membership takes it away again.
   */
  it('confers a role through a group, reports it as group-conferred, and takes it away again', async () => {
    const created = await call('admin.createGroup', {
      body: { name: 'Editors', description: 'asv', roleNames: [RoleName.NAMES.ProUser] },
    })
    expect(created.statusCode).toBe(200)
    const groupUuid = (created.json.group as { uuid: string }).uuid

    const listed = await call('admin.listGroups')
    expect(listed.statusCode).toBe(200)
    expect(
      (listed.json.groups as Array<{ uuid: string; roleNames: string[] }>).find((g) => g.uuid === groupUuid),
    ).toMatchObject({
      roleNames: [RoleName.NAMES.ProUser],
    })

    const added = await call('admin.addUserToGroup', { params: { groupUuid }, body: { userUuid } })
    expect(added).toMatchObject({ statusCode: 200, json: { success: true, groupUuid, userUuid } })

    const members = await call('admin.listGroupMembers', { params: { groupUuid } })
    expect(members.statusCode).toBe(200)
    expect(JSON.stringify(members.json.members)).toContain(userUuid)

    const withGroup = await call('admin.getUserEffectivePermissions', { params: { userUuid } })
    expect(withGroup.json.groupRoleNames).toEqual([RoleName.NAMES.ProUser])
    expect([...(withGroup.json.effectiveRoleNames as string[])].sort()).toEqual(['ADMIN_USER', 'CORE_USER', 'PRO_USER'])

    const removed = await call('admin.removeUserFromGroup', { params: { groupUuid, userUuid } })
    expect(removed.statusCode).toBe(200)
    const withoutGroup = await call('admin.getUserEffectivePermissions', { params: { userUuid } })
    expect(withoutGroup.json.groupRoleNames).toEqual([])

    expect((await call('admin.deleteGroup', { params: { groupUuid } })).statusCode).toBe(200)
  })

  /**
   * *** EVERY admin handler this container registers, not a list of them. ***
   * This used to be fifteen names typed out here, which guarded exactly those
   * fifteen: a sixteenth handler added tomorrow and left unwired would have been
   * as invisible to this suite as the fifteen were to every other one. The names
   * now come from the container, so a new handler is under test the moment it is
   * registered, with nothing to remember.
   *
   * Each is called with an empty request. None may answer a 500 or the unwired
   * "... not available"; a 400 is the handler's own validation and proves it ran
   * past its dependency guard. A handler that THROWS on an empty request fails
   * too, which is how a dependency missing with no guard in front of it shows.
   */
  it('leaves no admin handler it registers unwired on this topology', async () => {
    const adminMethods = controllers.registered.filter((method) => method.startsWith('admin.'))
    expect(adminMethods).toEqual(expect.arrayContaining(HANDLERS_THAT_WERE_DEAD))

    // The one handler that cannot take an empty request: it mints a token for
    // `params.userUuid` without checking it is there, and sqlite refuses the row.
    const requests: Record<string, Record<string, unknown>> = {
      'admin.createToken': { params: { userUuid } },
    }

    const unwired: string[] = []
    for (const method of adminMethods) {
      try {
        const result = await call(method, requests[method])
        if (result.statusCode === 500 || /not available/i.test(JSON.stringify(result.json))) {
          unwired.push(`${method} answered ${result.statusCode} ${JSON.stringify(result.json)}`)
        }
      } catch (error) {
        unwired.push(`${method} threw ${String(error)}`)
      }
    }

    expect(unwired).toEqual([])
  })

  /**
   * The other way a handler goes missing here. The gateway reaches auth on this
   * topology by method name only, so a route it resolves to a name auth never
   * registered answers 500 on the all-in-one while the multi-container build,
   * which routes the same request over HTTP to the annotated controller, is fine.
   */
  it('registers every admin method the gateway resolves', () => {
    const resolved = adminMethodsTheGatewayResolves()
    expect(resolved).toEqual(expect.arrayContaining(HANDLERS_THAT_WERE_DEAD))

    expect(resolved.filter((method) => controllers.get(method) === undefined)).toEqual([])
  })
})
