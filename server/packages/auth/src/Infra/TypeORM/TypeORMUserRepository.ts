import { Email, SettingName, Username, Uuid } from '@standardnotes/domain-core'
import { ReadStream } from 'fs'
import { inject, injectable } from 'inversify'
import { Repository, SelectQueryBuilder } from 'typeorm'
import TYPES from '../../Bootstrap/Types'

import { User } from '../../Domain/User/User'
import {
  AdminUserListQuery,
  AdminUserListResult,
  AdminUserRow,
  UserRepositoryInterface,
} from '../../Domain/User/UserRepositoryInterface'

@injectable()
export class TypeORMUserRepository implements UserRepositoryInterface {
  constructor(
    @inject(TYPES.Auth_ORMUserRepository)
    private ormRepository: Repository<User>,
  ) {}

  /**
   * Standard Red Notes: paginated + filtered admin user list. See the interface
   * doc for the efficiency contract. The page filters (email/created/banned/
   * role/subscription) are applied in SQL; the page is then enriched with a
   * fixed set of batched IN(...) queries.
   */
  async findUsersForAdmin(query: AdminUserListQuery): Promise<AdminUserListResult> {
    const total = await this.applyAdminUserFilters(this.ormRepository.createQueryBuilder('user'), query).getCount()

    const pageQuery = this.applyAdminUserFilters(this.ormRepository.createQueryBuilder('user'), query)
    switch (query.sort) {
      case 'email':
        pageQuery.orderBy('user.email', 'ASC')
        break
      case 'updatedAt':
        pageQuery.orderBy('user.updated_at', 'DESC')
        break
      case 'createdAt':
      default:
        pageQuery.orderBy('user.created_at', 'DESC')
        break
    }
    // Secondary, stable tie-breaker so equal sort keys page deterministically.
    pageQuery.addOrderBy('user.uuid', 'ASC')

    const users = await pageQuery.take(query.limit).skip(query.offset).getMany()
    if (users.length === 0) {
      return { rows: [], total }
    }

    const uuids = users.map((user) => user.uuid)
    const [rolesByUser, subscriptionByUser, mfaEnabledUuids, storageByUser] = await Promise.all([
      this.loadRolesForUsers(uuids),
      this.loadSubscriptionForUsers(uuids),
      this.loadMfaEnabledUsers(uuids),
      this.loadStorageForUsers(uuids),
    ])

    const rows: AdminUserRow[] = users.map((user) => ({
      uuid: user.uuid,
      email: user.email,
      createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : new Date(user.createdAt).toISOString(),
      updatedAt: user.updatedAt instanceof Date ? user.updatedAt.toISOString() : new Date(user.updatedAt).toISOString(),
      roles: rolesByUser.get(user.uuid) ?? [],
      subscription: subscriptionByUser.get(user.uuid) ?? null,
      banned: user.isBanned(),
      banType: user.isBanned() ? user.effectiveBanType() : null,
      suspended: user.isSuspended(),
      mfaEnabled: mfaEnabledUuids.has(user.uuid),
      storageUsedBytes: storageByUser.get(user.uuid)?.used ?? null,
      storageLimitBytes: storageByUser.get(user.uuid)?.limit ?? null,
    }))

    return { rows, total }
  }

  private applyAdminUserFilters(
    queryBuilder: SelectQueryBuilder<User>,
    query: AdminUserListQuery,
  ): SelectQueryBuilder<User> {
    if (query.email !== undefined && query.email !== '') {
      queryBuilder.andWhere('LOWER(user.email) LIKE :email', { email: `%${query.email.toLowerCase()}%` })
    }
    if (query.createdAfter !== undefined) {
      queryBuilder.andWhere('user.created_at >= :createdAfter', { createdAfter: new Date(query.createdAfter) })
    }
    if (query.createdBefore !== undefined) {
      queryBuilder.andWhere('user.created_at <= :createdBefore', { createdBefore: new Date(query.createdBefore) })
    }
    if (query.banned !== undefined) {
      queryBuilder.andWhere('user.banned = :banned', { banned: query.banned ? 1 : 0 })
    }
    if (query.suspended !== undefined) {
      queryBuilder.andWhere('user.suspended = :suspended', { suspended: query.suspended ? 1 : 0 })
    }
    if (query.role !== undefined && query.role !== '') {
      queryBuilder.andWhere(
        'EXISTS (SELECT 1 FROM user_roles ur INNER JOIN roles r ON r.uuid = ur.role_uuid ' +
          'WHERE ur.user_uuid = user.uuid AND r.name = :role)',
        { role: query.role },
      )
    }
    if (query.subscription !== undefined) {
      const now = Date.now()
      if (query.subscription === 'active') {
        queryBuilder.andWhere(
          'EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_uuid = user.uuid ' +
            'AND s.cancelled = 0 AND s.ends_at > :now)',
          { now },
        )
      } else if (query.subscription === 'inactive') {
        queryBuilder.andWhere(
          'EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_uuid = user.uuid) ' +
            'AND NOT EXISTS (SELECT 1 FROM user_subscriptions s2 WHERE s2.user_uuid = user.uuid ' +
            'AND s2.cancelled = 0 AND s2.ends_at > :now)',
          { now },
        )
      } else {
        queryBuilder.andWhere('NOT EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_uuid = user.uuid)')
      }
    }

    return queryBuilder
  }

  private async loadRolesForUsers(uuids: string[]): Promise<Map<string, string[]>> {
    const rows = await this.ormRepository.manager
      .createQueryBuilder()
      .select('ur.user_uuid', 'userUuid')
      .addSelect('r.name', 'name')
      .from('user_roles', 'ur')
      .innerJoin('roles', 'r', 'r.uuid = ur.role_uuid')
      .where('ur.user_uuid IN (:...uuids)', { uuids })
      .getRawMany<{ userUuid: string; name: string }>()

    const map = new Map<string, string[]>()
    for (const row of rows) {
      const list = map.get(row.userUuid) ?? []
      list.push(row.name)
      map.set(row.userUuid, list)
    }

    return map
  }

  private async loadSubscriptionForUsers(
    uuids: string[],
  ): Promise<Map<string, { plan: string | null; active: boolean }>> {
    const rows = await this.ormRepository.manager
      .createQueryBuilder()
      .select('s.user_uuid', 'userUuid')
      .addSelect('s.plan_name', 'planName')
      .addSelect('s.cancelled', 'cancelled')
      .addSelect('s.ends_at', 'endsAt')
      .from('user_subscriptions', 's')
      .where('s.user_uuid IN (:...uuids)', { uuids })
      .orderBy('s.created_at', 'DESC')
      .getRawMany<{ userUuid: string; planName: string | null; cancelled: number; endsAt: string | number }>()

    const now = Date.now()
    const map = new Map<string, { plan: string | null; active: boolean }>()
    for (const row of rows) {
      const active = Number(row.cancelled) === 0 && Number(row.endsAt) > now
      const existing = map.get(row.userUuid)
      // Rows arrive newest-first; keep the first, but let an ACTIVE subscription
      // win over an already-recorded inactive one.
      if (existing === undefined || (active && !existing.active)) {
        map.set(row.userUuid, { plan: row.planName ?? null, active })
      }
    }

    return map
  }

  private async loadMfaEnabledUsers(uuids: string[]): Promise<Set<string>> {
    const rows = await this.ormRepository.manager
      .createQueryBuilder()
      .select('DISTINCT st.user_uuid', 'userUuid')
      .from('settings', 'st')
      .where('st.user_uuid IN (:...uuids)', { uuids })
      .andWhere('st.name = :mfaName', { mfaName: SettingName.NAMES.MfaSecret })
      // A soft-deleted (reset) MFA secret keeps the row but nulls the value.
      .andWhere('st.value IS NOT NULL')
      .getRawMany<{ userUuid: string }>()

    return new Set(rows.map((row) => row.userUuid))
  }

  private async loadStorageForUsers(
    uuids: string[],
  ): Promise<Map<string, { used: number | null; limit: number | null }>> {
    const rows = await this.ormRepository.manager
      .createQueryBuilder()
      .select('us.user_uuid', 'userUuid')
      .addSelect('ss.name', 'name')
      .addSelect('ss.value', 'value')
      .from('subscription_settings', 'ss')
      .innerJoin('user_subscriptions', 'us', 'us.uuid = ss.user_subscription_uuid')
      .where('us.user_uuid IN (:...uuids)', { uuids })
      .andWhere('ss.name IN (:...names)', {
        names: [SettingName.NAMES.FileUploadBytesLimit, SettingName.NAMES.FileUploadBytesUsed],
      })
      // Newest subscription first so, if a user has more than one, we read the
      // most recent subscription's storage settings.
      .orderBy('us.created_at', 'DESC')
      .getRawMany<{ userUuid: string; name: string; value: string | null }>()

    const map = new Map<string, { used: number | null; limit: number | null }>()
    for (const row of rows) {
      const entry = map.get(row.userUuid) ?? { used: null, limit: null }
      const parsed = row.value === null ? null : Number(row.value)
      const value = parsed !== null && Number.isFinite(parsed) ? parsed : null
      if (row.name === SettingName.NAMES.FileUploadBytesLimit && entry.limit === null) {
        entry.limit = value
      } else if (row.name === SettingName.NAMES.FileUploadBytesUsed && entry.used === null) {
        entry.used = value
      }
      map.set(row.userUuid, entry)
    }

    return map
  }

  async findAllCreatedBetween(dto: { start: Date; end: Date; offset: number; limit: number }): Promise<User[]> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.created_at BETWEEN :start AND :end', { start: dto.start, end: dto.end })
      .orderBy('user.created_at', 'ASC')
      .take(dto.limit)
      .skip(dto.offset)
      .getMany()
  }

  async countAllCreatedBetween(start: Date, end: Date): Promise<number> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.created_at BETWEEN :start AND :end', { start, end })
      .getCount()
  }

  async countAll(): Promise<number> {
    return this.ormRepository.createQueryBuilder('user').getCount()
  }

  async save(user: User): Promise<User> {
    return this.ormRepository.save(user)
  }

  async remove(user: User): Promise<User> {
    return this.ormRepository.remove(user)
  }

  async streamAll(): Promise<ReadStream> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('created_at < :createdAt', { createdAt: new Date().toISOString() })
      .stream()
  }

  async streamTeam(memberEmail?: Email): Promise<ReadStream> {
    const queryBuilder = this.ormRepository.createQueryBuilder()
    if (memberEmail !== undefined) {
      queryBuilder.where('email = :email', { email: memberEmail.value })
    } else {
      queryBuilder.where('email LIKE :email', { email: '%@standardnotes.com' })
    }

    return queryBuilder.stream()
  }

  async findOneByUuid(uuid: Uuid): Promise<User | null> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.uuid = :uuid', { uuid: uuid.value })
      .cache(`user_uuid_${uuid.value}`, 60000)
      .getOne()
  }

  async findOneByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User | null> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: usernameOrEmail.value })
      .getOne()
  }

  async findAllByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User[]> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: usernameOrEmail.value })
      .getMany()
  }

  async findOneByEmailAndWorkspaceIdentifier(
    usernameOrEmail: Email | Username,
    workspaceIdentifier: string,
  ): Promise<User | null> {
    return this.ormRepository
      .createQueryBuilder('user')
      .where('user.email = :email AND user.workspace_identifier = :workspaceIdentifier', {
        email: usernameOrEmail.value,
        workspaceIdentifier,
      })
      .getOne()
  }
}
