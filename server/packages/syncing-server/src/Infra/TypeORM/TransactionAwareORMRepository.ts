import { EntityTarget, ObjectLiteral, Repository } from 'typeorm'

import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'

/**
 * Keeps existing TypeORM repository adapters transaction-aware without
 * duplicating their mapping/query logic. Every property and bound method is
 * resolved from the active command EntityManager when one exists.
 */
export const transactionAwareORMRepository = <Entity extends ObjectLiteral>(
  baseRepository: Repository<Entity>,
  entity: EntityTarget<Entity>,
  transactionContext: SyncCommandTransactionContext,
): Repository<Entity> =>
  new Proxy(baseRepository, {
    get: (_target, property) => {
      const repository = transactionContext.manager?.getRepository(entity) ?? baseRepository
      const value = Reflect.get(repository, property, repository)

      return typeof value === 'function' ? value.bind(repository) : value
    },
  })
