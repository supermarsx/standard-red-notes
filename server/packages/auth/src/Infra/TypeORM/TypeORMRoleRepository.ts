import { inject, injectable } from 'inversify'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { Role } from '../../Domain/Role/Role'
import { RoleRepositoryInterface } from '../../Domain/Role/RoleRepositoryInterface'

@injectable()
export class TypeORMRoleRepository implements RoleRepositoryInterface {
  constructor(
    @inject(TYPES.Auth_ORMRoleRepository)
    private ormRepository: Repository<Role>,
  ) {}

  async findOneByName(name: string): Promise<Role | null> {
    const roles = await this.ormRepository
      .createQueryBuilder('role')
      .where('role.name = :name', { name })
      .orderBy('version', 'DESC')
      .cache(`role_${name}`, 600000)
      .take(1)
      .getMany()

    if (roles.length === 0) {
      return null
    }

    return roles.shift() as Role
  }

  async findAll(): Promise<Role[]> {
    return this.ormRepository.createQueryBuilder('role').orderBy('role.name', 'ASC').addOrderBy('role.version', 'DESC').getMany()
  }

  async findOneByUuid(uuid: string): Promise<Role | null> {
    return this.ormRepository.createQueryBuilder('role').where('role.uuid = :uuid', { uuid }).getOne()
  }

  async save(role: Role): Promise<void> {
    await this.ormRepository.save(role)
    await this.invalidateNameCache(role.name)
  }

  async remove(role: Role): Promise<void> {
    const name = role.name
    await this.ormRepository.remove(role)
    await this.invalidateNameCache(name)
  }

  /**
   * Standard Red Notes: findOneByName caches per name for 10 minutes. When a
   * custom role is created or deleted, best-effort drop that cache key so
   * group-conferred effective-permission resolution (which resolves group role
   * names via findOneByName) sees the change immediately rather than after the
   * TTL. No-op when query caching is not enabled.
   */
  private async invalidateNameCache(name: string): Promise<void> {
    try {
      await this.ormRepository.manager.connection.queryResultCache?.remove([`role_${name}`])
    } catch {
      // Caching is optional; a cache-clear failure must never break the write.
    }
  }
}
