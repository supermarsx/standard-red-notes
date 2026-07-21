import 'reflect-metadata'

import { Repository, SelectQueryBuilder } from 'typeorm'

import { AnalyticsEntity } from '../../Domain/Entity/AnalyticsEntity'

import { MySQLAnalyticsEntityRepository } from './MySQLAnalyticsEntityRepository'

describe('MySQLAnalyticsEntityRepository', () => {
  let ormRepository: Repository<AnalyticsEntity>
  let queryBuilder: SelectQueryBuilder<AnalyticsEntity>
  let analyticsEntity: AnalyticsEntity

  const createRepository = () => new MySQLAnalyticsEntityRepository(ormRepository)

  beforeEach(() => {
    analyticsEntity = { id: 123, userUuid: '1-2-3', username: 'test@test.te' } as jest.Mocked<AnalyticsEntity>

    queryBuilder = {} as jest.Mocked<SelectQueryBuilder<AnalyticsEntity>>
    queryBuilder.where = jest.fn().mockReturnThis()
    queryBuilder.getOne = jest.fn().mockResolvedValue(analyticsEntity)

    ormRepository = {} as jest.Mocked<Repository<AnalyticsEntity>>
    ormRepository.createQueryBuilder = jest.fn().mockReturnValue(queryBuilder)
    ormRepository.save = jest.fn().mockResolvedValue(analyticsEntity)
    ormRepository.remove = jest.fn().mockResolvedValue(analyticsEntity)
  })

  it('looks a user up by the email column', async () => {
    await expect(createRepository().findOneByUserEmail('test@test.te')).resolves.toEqual(analyticsEntity)

    expect(queryBuilder.where).toHaveBeenCalledWith('analytics_entity.user_email = :email', { email: 'test@test.te' })
  })

  it('looks a user up by the uuid column', async () => {
    await expect(createRepository().findOneByUserUuid('1-2-3')).resolves.toEqual(analyticsEntity)

    expect(queryBuilder.where).toHaveBeenCalledWith('analytics_entity.user_uuid = :userUuid', { userUuid: '1-2-3' })
  })

  it('returns null when no row matches', async () => {
    queryBuilder.getOne = jest.fn().mockResolvedValue(null)

    await expect(createRepository().findOneByUserUuid('1-2-3')).resolves.toBeNull()
  })

  it('returns the persisted entity from save', async () => {
    await expect(createRepository().save(analyticsEntity)).resolves.toEqual(analyticsEntity)

    expect(ormRepository.save).toHaveBeenCalledWith(analyticsEntity)
  })

  it('removes an entity without returning it', async () => {
    await expect(createRepository().remove(analyticsEntity)).resolves.toBeUndefined()

    expect(ormRepository.remove).toHaveBeenCalledWith(analyticsEntity)
  })
})
