import { AsyncLocalStorage } from 'async_hooks'
import { EntityManager, Repository } from 'typeorm'
import { User } from '../User/User'
import { Session } from './Session'
import { runAuthTypeORMTransaction } from '../../Infra/TypeORM/AuthTypeORMTransactionCoordinator'

const context = new AsyncLocalStorage<EntityManager>()
export const authGenerationManager = (): EntityManager | undefined => context.getStore()
export class AuthGenerationChangedError extends Error {
  constructor() {
    super('Authentication state changed. Restart sign-in.')
    this.name = 'AuthGenerationChangedError'
  }
}
/** SQL locks cover local database writes only; cache writes use a post-write fence. */
export class AuthSessionGenerationService {
  constructor(private users: Repository<User>) {}
  async currentGeneration(userUuid: string): Promise<number | undefined> {
    return (await this.users.findOneBy({ uuid: userUuid }))?.authGeneration
  }
  async current(userUuid: string, expected: number): Promise<boolean> {
    return (await this.currentGeneration(userUuid)) === expected
  }
  async sessionCurrent(session: Session): Promise<boolean> {
    return this.current(session.userUuid, session.authGeneration ?? 0)
  }
  async run<T>(userUuid: string, expected: number, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return runAuthTypeORMTransaction(this.users.manager.connection, async (manager) => {
      const query = manager.getRepository(User).createQueryBuilder('user').where('user.uuid = :userUuid', { userUuid })
      if (
        this.users.manager.connection.options.type === 'mysql' ||
        this.users.manager.connection.options.type === 'mariadb'
      ) {
        query.setLock('pessimistic_write')
      }
      const user = await query.getOne()
      if (!user || user.authGeneration !== expected) {
        throw new AuthGenerationChangedError()
      }
      return context.run(manager, () => work(manager))
    })
  }
  async reset<T>(userUuid: string, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return runAuthTypeORMTransaction(this.users.manager.connection, async (manager) => {
      const query = manager.getRepository(User).createQueryBuilder('user').where('user.uuid = :userUuid', { userUuid })
      if (
        this.users.manager.connection.options.type === 'mysql' ||
        this.users.manager.connection.options.type === 'mariadb'
      ) {
        query.setLock('pessimistic_write')
      }
      const user = await query.getOne()
      if (!user || !Number.isSafeInteger(user.authGeneration) || user.authGeneration >= 2_147_483_647) {
        throw new AuthGenerationChangedError()
      }
      await manager.query('UPDATE users SET auth_generation = auth_generation + 1 WHERE uuid = ?', [userUuid])
      return context.run(manager, () => work(manager))
    })
  }
}
