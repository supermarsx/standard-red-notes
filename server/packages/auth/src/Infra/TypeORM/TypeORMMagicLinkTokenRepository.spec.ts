import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'
import { Repository, SelectQueryBuilder } from 'typeorm'

import { MagicLinkToken } from '../../Domain/MagicLink/MagicLinkToken'
import { TypeORMMagicLinkToken } from './TypeORMMagicLinkToken'
import { TypeORMMagicLinkTokenRepository } from './TypeORMMagicLinkTokenRepository'

describe('TypeORMMagicLinkTokenRepository', () => {
  let ormRepository: jest.Mocked<Repository<TypeORMMagicLinkToken>>
  let mapper: jest.Mocked<MapperInterface<MagicLinkToken, TypeORMMagicLinkToken>>
  let queryBuilder: jest.Mocked<SelectQueryBuilder<TypeORMMagicLinkToken>>

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    } as unknown as jest.Mocked<SelectQueryBuilder<TypeORMMagicLinkToken>>
    ormRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as jest.Mocked<Repository<TypeORMMagicLinkToken>>
    mapper = {
      toDomain: jest.fn(),
      toProjection: jest.fn(),
    }
  })

  it('selects by identifier and delivered code with deterministic same-second ordering', async () => {
    const projection = {
      uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      userIdentifier: 'test@test.te',
      code: '123456',
      expiresAt: new Date('2026-08-13T12:15:00.000Z'),
      consumed: false,
      createdAt: new Date('2026-08-13T12:00:00.000Z'),
    } as TypeORMMagicLinkToken
    const token = MagicLinkToken.create(
      {
        userIdentifier: projection.userIdentifier,
        code: projection.code,
        expiresAt: projection.expiresAt,
        consumed: projection.consumed,
        createdAt: projection.createdAt,
      },
      new UniqueEntityId(projection.uuid),
    ).getValue()
    queryBuilder.getOne.mockResolvedValue(projection)
    mapper.toDomain.mockReturnValue(token)
    const repository = new TypeORMMagicLinkTokenRepository(ormRepository, mapper)

    await expect(repository.findByUserIdentifierAndCode('test@test.te', '123456')).resolves.toBe(token)

    expect(ormRepository.createQueryBuilder).toHaveBeenCalledWith('magic_link_token')
    expect(queryBuilder.where).toHaveBeenCalledWith('magic_link_token.user_identifier = :userIdentifier', {
      userIdentifier: 'test@test.te',
    })
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('magic_link_token.code = :code', {
      code: '123456',
    })
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('magic_link_token.created_at', 'DESC')
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('magic_link_token.uuid', 'DESC')
    expect(mapper.toDomain).toHaveBeenCalledWith(projection)
  })

  it('returns null without invoking the mapper when the delivered code has no token', async () => {
    queryBuilder.getOne.mockResolvedValue(null)
    const repository = new TypeORMMagicLinkTokenRepository(ormRepository, mapper)

    await expect(repository.findByUserIdentifierAndCode('test@test.te', '000000')).resolves.toBeNull()

    expect(mapper.toDomain).not.toHaveBeenCalled()
  })
})
