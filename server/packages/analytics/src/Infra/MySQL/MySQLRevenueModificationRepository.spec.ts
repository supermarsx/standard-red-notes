import 'reflect-metadata'

import { MapperInterface, Uuid } from '@standardnotes/domain-core'
import { Repository, SelectQueryBuilder } from 'typeorm'

import { RevenueModification } from '../../Domain/Revenue/RevenueModification'
import { TypeORMRevenueModification } from '../TypeORM/TypeORMRevenueModification'

import { MySQLRevenueModificationRepository } from './MySQLRevenueModificationRepository'

describe('MySQLRevenueModificationRepository', () => {
  let ormRepository: Repository<TypeORMRevenueModification>
  let queryBuilder: SelectQueryBuilder<TypeORMRevenueModification>
  let revenueModificationMap: MapperInterface<RevenueModification, TypeORMRevenueModification>
  let persistence: TypeORMRevenueModification
  let domain: RevenueModification

  const userUuid = Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue()

  const createRepository = () => new MySQLRevenueModificationRepository(ormRepository, revenueModificationMap)

  beforeEach(() => {
    persistence = { uuid: 'a-b-c' } as jest.Mocked<TypeORMRevenueModification>
    domain = { id: 'a-b-c' } as unknown as jest.Mocked<RevenueModification>

    queryBuilder = {} as jest.Mocked<SelectQueryBuilder<TypeORMRevenueModification>>
    queryBuilder.select = jest.fn().mockReturnThis()
    queryBuilder.where = jest.fn().mockReturnThis()
    queryBuilder.andWhere = jest.fn().mockReturnThis()
    queryBuilder.orderBy = jest.fn().mockReturnThis()
    queryBuilder.limit = jest.fn().mockReturnThis()
    queryBuilder.getRawOne = jest.fn().mockResolvedValue({ mrrDiff: '12.3456' })
    queryBuilder.getOne = jest.fn().mockResolvedValue(persistence)

    ormRepository = {} as jest.Mocked<Repository<TypeORMRevenueModification>>
    ormRepository.createQueryBuilder = jest.fn().mockReturnValue(queryBuilder)
    ormRepository.save = jest.fn().mockResolvedValue(persistence)

    revenueModificationMap = {} as jest.Mocked<MapperInterface<RevenueModification, TypeORMRevenueModification>>
    revenueModificationMap.toDomain = jest.fn().mockReturnValue(domain)
    revenueModificationMap.toProjection = jest.fn().mockReturnValue(persistence)
  })

  describe('sumMRRDiff', () => {
    it('sums the mrr delta and rounds it to two decimals', async () => {
      await expect(createRepository().sumMRRDiff({ billingFrequencies: [1, 12] })).resolves.toEqual(12.35)

      expect(queryBuilder.select).toHaveBeenCalledWith('sum(new_mrr - previous_mrr)', 'mrrDiff')
      expect(queryBuilder.where).toHaveBeenCalledWith('billing_frequency IN (:...billingFrequencies)', {
        billingFrequencies: [1, 12],
      })
    })

    it('does not filter by billing frequency when none are supplied', async () => {
      await createRepository().sumMRRDiff({ billingFrequencies: [] })

      expect(queryBuilder.where).not.toHaveBeenCalled()
    })

    it('additionally filters by plan name when plan names are supplied', async () => {
      await createRepository().sumMRRDiff({ billingFrequencies: [1], planNames: ['PLUS_PLAN'] })

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('subscription_plan IN (:...planNames)', {
        planNames: ['PLUS_PLAN'],
      })
    })

    it('does not filter by plan name for an empty plan name list', async () => {
      await createRepository().sumMRRDiff({ billingFrequencies: [1], planNames: [] })

      expect(queryBuilder.andWhere).not.toHaveBeenCalled()
    })

    it('reports a zero delta when the query returns no row', async () => {
      queryBuilder.getRawOne = jest.fn().mockResolvedValue(undefined)

      await expect(createRepository().sumMRRDiff({ billingFrequencies: [1] })).resolves.toEqual(0)
    })
  })

  describe('findLastByUserUuid', () => {
    it('returns the most recent modification mapped to the domain', async () => {
      await expect(createRepository().findLastByUserUuid(userUuid)).resolves.toEqual(domain)

      expect(queryBuilder.where).toHaveBeenCalledWith('user_uuid = :userUuid', { userUuid: userUuid.value })
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('created_at', 'DESC')
      expect(queryBuilder.limit).toHaveBeenCalledWith(1)
      expect(revenueModificationMap.toDomain).toHaveBeenCalledWith(persistence)
    })

    it('returns null without mapping when the user has no modifications', async () => {
      queryBuilder.getOne = jest.fn().mockResolvedValue(null)

      await expect(createRepository().findLastByUserUuid(userUuid)).resolves.toBeNull()
      expect(revenueModificationMap.toDomain).not.toHaveBeenCalled()
    })
  })

  describe('save', () => {
    it('round-trips the aggregate through the projection and back', async () => {
      await expect(createRepository().save(domain)).resolves.toEqual(domain)

      expect(revenueModificationMap.toProjection).toHaveBeenCalledWith(domain)
      expect(ormRepository.save).toHaveBeenCalledWith(persistence)
      expect(revenueModificationMap.toDomain).toHaveBeenCalledWith(persistence)
    })
  })
})
