import { inject, injectable } from 'inversify'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { Permission } from '../../Domain/Permission/Permission'
import { PermissionRepositoryInterface } from '../../Domain/Permission/PermissionRepositoryInterface'

@injectable()
export class TypeORMPermissionRepository implements PermissionRepositoryInterface {
  constructor(
    @inject(TYPES.Auth_ORMPermissionRepository)
    private ormRepository: Repository<Permission>,
  ) {}

  async findAll(): Promise<Permission[]> {
    return this.ormRepository.createQueryBuilder('permission').orderBy('permission.name', 'ASC').getMany()
  }

  async findByNames(names: string[]): Promise<Permission[]> {
    if (names.length === 0) {
      return []
    }

    return this.ormRepository
      .createQueryBuilder('permission')
      .where('permission.name IN (:...names)', { names })
      .getMany()
  }
}
