import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm'

import { AuthInviteEventTransactionContext } from '../../Infra/TypeORM/AuthInviteEventTransactionContext'
import { authInviteTransactionAwareORMRepository } from '../../Infra/TypeORM/AuthInviteTransactionAwareORMRepository'
import { TypeORMInviteEventOutbox } from '../../Infra/TypeORM/TypeORMInviteEventOutbox'
import { TypeORMInviteEventOutboxRepository } from '../../Infra/TypeORM/TypeORMInviteEventOutboxRepository'
import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'
import { AuthInviteMutationTransactionRunner } from './AuthInviteMutationTransactionRunner'
import { AuthInviteRealtimeOutboxProducer } from './AuthInviteRealtimeOutboxProducer'

@Entity({ name: 'auth_invite_mutation_test' })
class AuthInviteMutationTest {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column({ type: 'varchar', length: 32 })
  declare action: string
}

const userOne = '00000000-0000-4000-8000-000000000001'
const userTwo = '00000000-0000-4000-8000-000000000002'
const inviteUuid = '20000000-0000-4000-8000-000000000001'
const eventId = '70000000-0000-4000-8000-000000000001'
const actions = ['created', 'accepted', 'declined', 'canceled'] as const

describe('AuthInviteMutationTransactionRunner integration', () => {
  let dataSource: DataSource
  let context: AuthInviteEventTransactionContext
  let outbox: TypeORMInviteEventOutboxRepository
  let failOutbox: boolean
  let failPrimary: boolean
  let producer: AuthInviteRealtimeOutboxProducer
  let runner: AuthInviteMutationTransactionRunner

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [AuthInviteMutationTest, TypeORMInviteEventOutbox],
      synchronize: true,
    })
    await dataSource.initialize()
    context = new AuthInviteEventTransactionContext()
    outbox = new TypeORMInviteEventOutboxRepository(
      dataSource.getRepository(TypeORMInviteEventOutbox),
      context,
      () => 1_000,
    )
    failOutbox = false
    failPrimary = false
    const controlledOutbox = new Proxy(outbox, {
      get: (target, property) => {
        if (property === 'enqueue') {
          return async (...args: Parameters<InviteEventOutboxRepositoryInterface['enqueue']>) => {
            if (failOutbox) {
              throw new Error('forced auth outbox failure')
            }
            return target.enqueue(...args)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InviteEventOutboxRepositoryInterface
    producer = new AuthInviteRealtimeOutboxProducer(
      controlledOutbox,
      context,
      () => 1_000,
      () => eventId,
    )
    runner = new AuthInviteMutationTransactionRunner(dataSource, context, { wake: jest.fn() })
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it.each(actions)(
    '%s rolls the mutation back on outbox failure and commits one stable retry identity',
    async (action) => {
      failOutbox = true
      await expect(execute(action)).rejects.toThrow('forced auth outbox failure')
      expect(await dataSource.getRepository(AuthInviteMutationTest).count()).toBe(0)
      expect(await dataSource.getRepository(TypeORMInviteEventOutbox).count()).toBe(0)

      failOutbox = false
      expect(await execute(action)).toEqual({ success: true })
      expect(await dataSource.getRepository(AuthInviteMutationTest).count()).toBe(1)
      const record = await dataSource.getRepository(TypeORMInviteEventOutbox).findOneByOrFail({ uuid: eventId })
      expect(record.eventJson).toContain(`"action":"${action}"`)
      expect(record.eventJson).toContain(userOne)
      expect(record.eventJson).toContain(userTwo)
      expect(record.eventJson).not.toMatch(/email|token|body|encrypted/i)
    },
  )

  it.each(actions)('%s leaves no outbox record when the primary write fails', async (action) => {
    failPrimary = true
    await expect(execute(action)).rejects.toThrow('forced auth primary failure')
    expect(await dataSource.getRepository(AuthInviteMutationTest).count()).toBe(0)
    expect(await dataSource.getRepository(TypeORMInviteEventOutbox).count()).toBe(0)
  })

  async function execute(action: (typeof actions)[number]): Promise<{ success: boolean }> {
    const repository = authInviteTransactionAwareORMRepository(
      dataSource.getRepository(AuthInviteMutationTest),
      AuthInviteMutationTest,
      context,
    )
    return runner.execute(
      async () => {
        if (failPrimary) {
          throw new Error('forced auth primary failure')
        }
        await repository.insert({ uuid: inviteUuid, action })
        await producer.recordSubscriptionInvite({
          action,
          inviteUuid,
          affectedUserUuids: [userOne, userTwo],
        })
        return { success: true }
      },
      (result) => result.success,
    )
  }
})
