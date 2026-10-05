import { Uuid } from '@standardnotes/domain-core'

import { TypeORMMessageRepository } from './TypeORMMessageRepository'

describe('TypeORMMessageRepository replaceability lookup', () => {
  const RECIPIENT = '22222222-2222-2222-2222-222222222222'
  const SENDER = '11111111-1111-1111-1111-111111111111'
  const IDENTIFIER =
    'SharedVaultRootKeyChanged:44444444-4444-4444-4444-444444444444:55555555-5555-5555-5555-555555555555'

  const createRepository = () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }
    const ormRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }
    const repository = new TypeORMMessageRepository(ormRepository as never, {} as never)

    return { repository, queryBuilder }
  }

  it('constrains the match by sender as well as recipient and identifier', async () => {
    const { repository, queryBuilder } = createRepository()

    const result = await repository.findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier({
      recipientUuid: Uuid.create(RECIPIENT).getValue(),
      senderUuid: Uuid.create(SENDER).getValue(),
      replaceabilityIdentifier: IDENTIFIER,
    })

    // Precondition: the query really was built and executed, so the clause assertions below are
    // about a query that ran rather than about a call that never happened.
    expect(queryBuilder.getOne).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()

    expect(queryBuilder.where).toHaveBeenCalledWith('message.recipientUuid = :recipientUuid', {
      recipientUuid: RECIPIENT,
    })
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('message.senderUuid = :senderUuid', {
      senderUuid: SENDER,
    })
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('message.replaceabilityIdentifier = :replaceabilityIdentifier', {
      replaceabilityIdentifier: IDENTIFIER,
    })
  })
})
