import { Repository, SelectQueryBuilder } from 'typeorm'
import { Logger } from 'winston'
import { MapperInterface, Timestamps, Uuid } from '@standardnotes/domain-core'

import { Connection } from '../../Domain/Connection/Connection'
import { SQLConnection } from './SQLConnection'
import { SQLConnectionRepository } from './SQLConnectionRepository'

describe('SQLConnectionRepository', () => {
  let ormRepository: Repository<SQLConnection>
  let queryBuilder: SelectQueryBuilder<SQLConnection>
  let mapper: MapperInterface<Connection, SQLConnection>
  let logger: Logger
  let connection: Connection
  let projection: SQLConnection

  const createRepository = () => new SQLConnectionRepository(ormRepository, mapper, logger)

  beforeEach(() => {
    connection = Connection.create({
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      sessionUuid: Uuid.create('11111111-1111-1111-1111-111111111111').getValue(),
      connectionId: 'connection-id',
      timestamps: Timestamps.create(123, 456).getValue(),
    }).getValue()

    projection = new SQLConnection()
    projection.connectionId = 'connection-id'

    queryBuilder = {} as jest.Mocked<SelectQueryBuilder<SQLConnection>>
    queryBuilder.where = jest.fn().mockReturnThis()
    queryBuilder.getMany = jest.fn().mockResolvedValue([projection])
    queryBuilder.delete = jest.fn().mockReturnThis()
    queryBuilder.from = jest.fn().mockReturnThis()
    queryBuilder.execute = jest.fn().mockResolvedValue({ affected: 1 })

    ormRepository = {} as jest.Mocked<Repository<SQLConnection>>
    ormRepository.createQueryBuilder = jest.fn().mockReturnValue(queryBuilder)
    ormRepository.save = jest.fn().mockResolvedValue(projection)

    mapper = {} as jest.Mocked<MapperInterface<Connection, SQLConnection>>
    mapper.toDomain = jest.fn().mockReturnValue(connection)
    mapper.toProjection = jest.fn().mockReturnValue(projection)

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
  })

  describe('findAllByUserUuid', () => {
    it('filters on the raw uuid value rather than the value object', async () => {
      await createRepository().findAllByUserUuid(Uuid.create('00000000-0000-0000-0000-000000000000').getValue())

      expect(queryBuilder.where).toHaveBeenCalledWith('user_uuid = :userUuid', {
        userUuid: '00000000-0000-0000-0000-000000000000',
      })
    })

    it('maps every returned row through the mapper', async () => {
      const second = new SQLConnection()
      second.connectionId = 'second-connection-id'
      queryBuilder.getMany = jest.fn().mockResolvedValue([projection, second])

      const result = await createRepository().findAllByUserUuid(
        Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      )

      expect(mapper.toDomain).toHaveBeenCalledTimes(2)
      expect(mapper.toDomain).toHaveBeenNthCalledWith(1, projection)
      expect(mapper.toDomain).toHaveBeenNthCalledWith(2, second)
      expect(result).toEqual([connection, connection])
    })

    it('returns an empty list when the user has no connections', async () => {
      queryBuilder.getMany = jest.fn().mockResolvedValue([])

      const result = await createRepository().findAllByUserUuid(
        Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      )

      expect(result).toEqual([])
      expect(mapper.toDomain).not.toHaveBeenCalled()
    })
  })

  describe('saveConnection', () => {
    it('persists the projection produced by the mapper, not the domain entity', async () => {
      await createRepository().saveConnection(connection)

      expect(mapper.toProjection).toHaveBeenCalledWith(connection)
      expect(ormRepository.save).toHaveBeenCalledWith(projection)
    })
  })

  describe('removeConnection', () => {
    it('deletes from the connections table by connection id', async () => {
      await createRepository().removeConnection('connection-id')

      expect(queryBuilder.delete).toHaveBeenCalled()
      expect(queryBuilder.from).toHaveBeenCalledWith(SQLConnection)
      expect(queryBuilder.where).toHaveBeenCalledWith('connection_id = :connectionId', {
        connectionId: 'connection-id',
      })
      expect(queryBuilder.execute).toHaveBeenCalled()
    })

    it('does not consult the mapper when removing', async () => {
      await createRepository().removeConnection('connection-id')

      expect(mapper.toDomain).not.toHaveBeenCalled()
      expect(mapper.toProjection).not.toHaveBeenCalled()
    })
  })
})
