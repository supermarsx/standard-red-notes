import { EntityTarget, ObjectLiteral, Repository } from 'typeorm'

import { AuthInviteEventTransactionContext } from './AuthInviteEventTransactionContext'

export function authInviteTransactionAwareORMRepository<Entity extends ObjectLiteral>(
  baseRepository: Repository<Entity>,
  entity: EntityTarget<Entity>,
  transactionContext: AuthInviteEventTransactionContext,
): Repository<Entity> {
  return new Proxy(baseRepository, {
    get: (_target, property) => {
      const repository = transactionContext.manager?.getRepository(entity) ?? baseRepository
      const value = Reflect.get(repository, property, repository)
      return typeof value === 'function' ? value.bind(repository) : value
    },
  })
}
